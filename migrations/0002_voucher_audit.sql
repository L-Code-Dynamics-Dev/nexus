-- 0002_voucher_audit.sql -- auditní stopa operací nad kreditem.
-- (docs/design-proposals/Digital-Voucher.md §6.2 HOLD, §13 audit contract)
--
-- PROČ SAMOSTATNÁ TABULKA VEDLE `voucher_transactions`:
--   `voucher_transactions` je FINANČNÍ historie -- append-only pohyby, ze
--   kterých se dá přepočítat zůstatek. Zapisuje se do ní JEN když se kredit
--   skutečně pohnul.
--   `voucher_audit` je PROVOZNÍ historie: události, které pohyb NEVYVOLALY,
--   ale musí být dohledatelné. CreditVoucher.ts (AUDIT CONTRACT) je jmenuje:
--   zamítnuté čerpání, vyčerpaný retry (§7), neúspěšný pokus o uhodnutí kódu
--   (§4), a hlavně HOLD při nesouladu částky (§6.2).
--
--   Slít je do jedné tabulky by znamenalo, že reconciliační součet
--   `currentBalance === initialBalance - SUM(REDEEMED) + SUM(REFUNDED)`
--   přestane platit, protože by v ní ležely i řádky bez finančního dopadu.
--
-- HOLD je nejdůležitější případ: objednávka, u které se přepočtená částka
-- rozešla s tím, co tvrdil frontend. Kredit se NEODEČTE a rozhoduje člověk.
-- Bez perzistentního záznamu by jediným důkazem byl log, který za 30 dní
-- vyroluje.

CREATE TABLE IF NOT EXISTS voucher_audit (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id     TEXT    NOT NULL,

    -- Poukaz, kterého se událost týká. NENÍ tu FOREIGN KEY na `vouchers`:
    -- auditovat se musí i pokus o čerpání NEEXISTUJÍCÍHO kódu (uhodnutí,
    -- §4) -- právě ten je bezpečnostně nejzajímavější a FK by ho zahodil.
    voucher_id    TEXT,

    order_id      TEXT,
    event_type    TEXT    NOT NULL,

    -- Volný JSON s detailem události (přepočtená vs. tvrzená částka,
    -- verze, počet pokusů...). Schéma se liší podle `event_type`, proto
    -- TEXT a ne sloupce -- jinak by tabulka rostla o sloupec s každým
    -- novým typem události.
    payload_json  TEXT,

    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),

    CONSTRAINT ck_vaudit_event_type
        CHECK (event_type IN (
            'REDEMPTION_HOLD',        -- §6.2 nesoulad částky, kredit NEodečten
            'REDEMPTION_REJECTED',    -- zamítnuto (expirace, zůstatek, stav)
            'REDEMPTION_EXHAUSTED',   -- §7 vyčerpané retry při souběhu
            'REDEMPTION_COMPENSATED', -- vrácen odečet po idempotentním replay
            'VALIDATION_FAILED',      -- neplatný / neexistující kód (§4)
            'ISSUANCE_REJECTED'       -- emise odmítnuta
        ))
);

-- Dohledání události u objednávky ("proč tahle objednávka visí v HOLD?").
CREATE INDEX IF NOT EXISTS idx_vaudit_order
    ON voucher_audit (tenant_id, order_id, created_at);

-- Historie poukazu v adminu (Fáze D) vedle finančních pohybů.
CREATE INDEX IF NOT EXISTS idx_vaudit_voucher
    ON voucher_audit (voucher_id, created_at)
    WHERE voucher_id IS NOT NULL;

-- Bezpečnostní pohled: kolik neúspěšných pokusů o uhodnutí kódu za poslední
-- hodinu (§4 -- entropie sama nestačí, hrubá síla musí být VIDĚT).
CREATE INDEX IF NOT EXISTS idx_vaudit_type_time
    ON voucher_audit (tenant_id, event_type, created_at);
