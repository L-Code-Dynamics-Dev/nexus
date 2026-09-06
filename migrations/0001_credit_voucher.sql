-- 0001_credit_voucher.sql -- Fáze A "Voucher Core"
-- (docs/design-proposals/Digital-Voucher.md §3, status NÁVRH UZAVŘEN v3,
-- rozhodnutí Lucky 2026-09-06).
--
-- PRVNÍ produkční D1 migrace v celém NEXUSu. Do dneška repo nemělo žádnou
-- perzistenční vrstvu (žádná migrace, žádný wrangler config) -- proto tenhle
-- soubor zakládá i konvenci pro všechny další.
--
-- ROZHODNUTO (Lucky 2026-09-06):
--   §7  Atomické čerpání = OPTIMISTICKÝ ZÁMEK. Sloupec `version`, čerpací
--       UPDATE s `WHERE version = ?`, úspěch = `meta.changes === 1`.
--       Databáze je autorita -- žádné aplikační mutexy, žádný Durable Object.
--   §15 Víceúčelový poukaz (MPV, § 15b ZDPH). Schéma proto NEMÁ žádný sloupec
--       se sazbou DPH ani rozpadem základu daně: NEXUS eviduje kredit, účetní
--       pravdu tvoří účetní systém (Omega / Pohoda / Money S3, §15.1).
--
-- ODCHYLKA OD NÁVRHU §3 -- PENÍZE JAKO INTEGER V HALÉŘÍCH, NE REAL:
--   Návrh §3 uvádí `REAL` pro `initial_balance` / `current_balance` / `amount`.
--   Zde je vědomě `INTEGER` v minor units (haléřích), se sufixem `_minor`.
--   Důvod: SQLite nemá DECIMAL a `REAL` je IEEE-754 float. Na penězích to
--   znamená, že 0.1 + 0.2 != 0.3 a že se součty rozejdou s reconciliačním
--   invariantem (CreditVoucher.ts, RECONCILIATION CONTRACT) po dost malém
--   počtu operací. U platidla je to nepřijatelné. Aplikační vrstva pracuje
--   s `Money{Decimal}` (core/canonical/entities/base.ts: "Peníze vždy jako
--   Decimal, nikdy float") a převod na haléře dělá repository mapper --
--   entita halíře nikdy nevidí.
--   Sufix `_minor` je v názvu sloupce záměrně: bez něj se dřív nebo později
--   někdo splete o dva řády a zaplatí to zákazník.
--
-- DALŠÍ KONVENCE (D1/SQLite idiomy, návrh je nechával otevřené):
--   - datum/čas: TEXT v ISO 8601, `datetime('now')`. SQLite nemá nativní DATE;
--     ISO 8601 se řadí lexikograficky správně, takže `expires_at > datetime('now')`
--     v §8 WHERE klauzuli funguje bez konverze.
--   - boolean: nepoužit; stavy nese `status` výčet (návrh §3 hodnoty neurčoval,
--     doplněny dle CreditVoucher.ts lifecycle).

-- ---------------------------------------------------------------------------
-- vouchers -- stav kreditu. Jediný zdroj pravdy o zůstatku (rozhodnutí Lucky).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vouchers (
    -- Kód poukazu (`NEXUS-XXXX-XXXX-RRRR`, §4) je zároveň primární klíč.
    -- Kód je Nexus-generated, druhá identita by byla duplicita.
    id                     TEXT    PRIMARY KEY,

    -- §11 vyžaduje konfiguraci per tenant; návrh §3 sloupec postrádal.
    -- Alternativa (samostatná D1 per tenant) sloupec nepotřebuje, ale
    -- komplikuje admin napříč tenanty. Sloupec je levnější a reverzibilní.
    tenant_id              TEXT    NOT NULL,

    -- Peníze v haléřích -- viz ODCHYLKA výše.
    initial_balance_minor  INTEGER NOT NULL,
    current_balance_minor  INTEGER NOT NULL,
    currency               TEXT    NOT NULL DEFAULT 'CZK',

    created_at             TEXT    NOT NULL DEFAULT (datetime('now')),
    -- §8: created_at + 1 rok, délka konfigurovatelná per tenant (§11).
    expires_at             TEXT    NOT NULL,

    -- Objednávka, KTEROU BYL POUKAZ ZAKOUPEN (ne ta, kde se čerpá).
    -- Slouží zároveň jako idempotency klíč issuance toku (§4).
    source_order_id        TEXT    NOT NULL,
    customer_email         TEXT    NOT NULL,

    status                 TEXT    NOT NULL DEFAULT 'ACTIVE',

    -- §7 optimistický zámek. Inkrementuje ho každý úspěšný UPDATE zůstatku.
    version                INTEGER NOT NULL DEFAULT 0,

    created_by             TEXT,
    metadata_json          TEXT,

    -- INVARIANTY vynucené DB, ne aplikačním kódem (CreditVoucher.ts §INVARIANTY).
    -- Přečerpání musí být nemožné I PŘI CHYBĚ V KÓDU -- tohle je poslední
    -- záchranná síť pod optimistickým zámkem.
    CONSTRAINT ck_vouchers_balance_non_negative
        CHECK (current_balance_minor >= 0),
    CONSTRAINT ck_vouchers_balance_within_initial
        CHECK (current_balance_minor <= initial_balance_minor),
    CONSTRAINT ck_vouchers_initial_positive
        CHECK (initial_balance_minor > 0),
    CONSTRAINT ck_vouchers_status
        CHECK (status IN ('ACTIVE', 'DEPLETED', 'EXPIRED', 'CANCELLED')),
    CONSTRAINT ck_vouchers_version_non_negative
        CHECK (version >= 0)
);

-- Dohledání poukazů zákazníka (Fáze C doručení, Fáze D admin).
CREATE INDEX IF NOT EXISTS idx_vouchers_email
    ON vouchers (tenant_id, customer_email);

-- Admin výpis a expirační job -- D1 je single-threaded, index na WHERE
-- sloupcích je proto povinný, ne optimalizace (limits: 1ms query ~ 1000 qps,
-- 100ms query ~ 10 qps).
CREATE INDEX IF NOT EXISTS idx_vouchers_tenant_status
    ON vouchers (tenant_id, status, expires_at);

-- Idempotence issuance toku (§4): jedna objednávka = jeden poukaz.
-- Dvojí doručení téhož webhooku o koupi poukazu tedy nevystaví dva poukazy.
CREATE UNIQUE INDEX IF NOT EXISTS uq_vouchers_source_order
    ON vouchers (tenant_id, source_order_id);

-- ---------------------------------------------------------------------------
-- voucher_transactions -- APPEND-ONLY finanční historie pohybů.
-- Nikdy se nemaže ani nepřepisuje; oprava se dělá PROTIPOHYBEM (REFUNDED).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS voucher_transactions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    voucher_id    TEXT    NOT NULL,
    tenant_id     TEXT    NOT NULL,
    type          TEXT    NOT NULL,

    -- Vždy KLADNÁ absolutní hodnota -- směr nese `type`, ne znaménko.
    -- Záporná částka by rozbila reconciliační součet.
    amount_minor  INTEGER NOT NULL,
    currency      TEXT    NOT NULL DEFAULT 'CZK',

    -- Objednávka, ve které byl kredit ČERPÁN / vrácen.
    -- NULL u ISSUED a EXPIRED -- ty spotřebitelskou objednávku nemají.
    order_id      TEXT,

    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),

    FOREIGN KEY (voucher_id) REFERENCES vouchers (id),

    CONSTRAINT ck_vtx_type
        CHECK (type IN ('ISSUED', 'REDEEMED', 'EXPIRED', 'CANCELLED', 'REFUNDED')),
    CONSTRAINT ck_vtx_amount_positive
        CHECK (amount_minor > 0),
    -- Pohyb vázaný na objednávku ji MUSÍ mít; emise a expirace ji mít NESMÍ.
    -- CANCELLED je vědomě mimo obě strany -- viz OPEN QUESTION 2 v CreditVoucher.ts
    -- (storno z reklamace objednávku má, storno z rozhodnutí operátora ne).
    CONSTRAINT ck_vtx_order_id_presence
        CHECK (
            (type IN ('REDEEMED', 'REFUNDED') AND order_id IS NOT NULL)
            OR (type IN ('ISSUED', 'EXPIRED') AND order_id IS NULL)
            OR type = 'CANCELLED'
        )
);

-- ===========================================================================
-- KRITICKÉ -- idempotence dvojího webhooku VYNUCENÁ SCHÉMATEM, ne kódem.
--
-- Stejná objednávka nesmí z téhož poukazu odečíst dvakrát. Partial index
-- (WHERE) je nutný proto, že `order_id` je NULL u ISSUED/EXPIRED a plný
-- unique index by povolil jen JEDEN takový záznam na poukaz.
--
-- Tohle je druhá nezávislá vrstva pod optimistickým zámkem: zámek chrání
-- před souběhem, tenhle index před opakováním. Ani jedno samo nestačí.
-- ===========================================================================
CREATE UNIQUE INDEX IF NOT EXISTS uq_voucher_redemption
    ON voucher_transactions (voucher_id, order_id)
    WHERE type = 'REDEEMED' AND order_id IS NOT NULL;

-- Historie pohybů poukazu (Fáze D detail) + reconciliační součty.
CREATE INDEX IF NOT EXISTS idx_vtx_voucher
    ON voucher_transactions (voucher_id, created_at);

-- Dohledání podle objednávky (reconciliation: "uplatnila tahle objednávka kredit?").
CREATE INDEX IF NOT EXISTS idx_vtx_order
    ON voucher_transactions (tenant_id, order_id)
    WHERE order_id IS NOT NULL;
