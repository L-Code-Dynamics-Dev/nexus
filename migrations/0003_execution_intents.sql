-- 0003_execution_intents.sql -- perzistence Execution vrstvy (P1,
-- rozhodnutí Lucky 2026-09-07 bod 23).
--
-- PROČ TO MUSÍ BÝT V DATABÁZI, NE V PAMĚTI:
--   `IntentExecutor.executeIntent` má v kontraktu pořadí, které volající
--   MUSÍ dodržet:
--     1. přepnout Intent na EXECUTING a PERZISTOVAT
--     2. teprve pak volat vnější systém
--   Bez kroku 1 se po pádu procesu (Worker vyprší, deploy, restart) neví,
--   jestli se zápis stihl provést. A "nevíme, jestli jsme zapsali" je přesně
--   ten stav, kvůli kterému celá vrstva vznikla -- kdyby ho vyráběla sama,
--   byla by k ničemu.
--
-- VZTAH K OSTATNÍM TABULKÁM:
--   `voucher_transactions`  = finanční historie JEDNÉ domény (append-only pohyby)
--   `voucher_audit`         = provozní historie JEDNÉ domény
--   `execution_intents`     = zamýšlené zápisy DO VNĚJŠÍCH systémů, napříč doménami
--   Slévat je nelze: Intent není finanční pohyb (může skončit ABANDONED
--   a nikdy se neprovést) a není doménový (pricing, voucher i omega ho sdílejí).

CREATE TABLE IF NOT EXISTS execution_intents (
    id                    TEXT    PRIMARY KEY,
    tenant_id             TEXT    NOT NULL,

    -- Rozhodnutí, ze kterého Intent vzešel. Povinné -- zápis do cizího
    -- systému bez dohledatelného důvodu je přesně to, co má tahle vrstva
    -- znemožnit ("proč systém nastavil tuhle cenu?").
    decision_id           TEXT    NOT NULL,

    domain                TEXT    NOT NULL,   -- 'pricing' | 'voucher' | 'omega' | ...
    connector_type        TEXT    NOT NULL,   -- 'shoptet' | 'pohoda' | 'omega' | 'd1' | ...
    operation             TEXT    NOT NULL,   -- 'UPDATE_PRICE' | 'REDEEM_CREDIT' | ...
    target_ref            TEXT    NOT NULL,   -- entita, které se zápis týká

    -- Tvar zápisu pro konektor a očekávaný stav po provedení. JSON, protože
    -- core je NESMÍ interpretovat -- jinak by tu skončilo
    -- `if (connectorType === 'shoptet')`, což CANONICAL-MODEL-CONTRACT §15
    -- zakazuje. Databáze je drží jako neprůhledná data.
    payload_json          TEXT    NOT NULL,
    expected_state_json   TEXT    NOT NULL,

    state                 TEXT    NOT NULL DEFAULT 'PLANNED',

    -- Odvozený od (domain, operation, target_ref, decision_id), NE náhodný --
    -- retry musí vyrobit TENTÝŽ klíč, jinak idempotence u cílového systému
    -- nefunguje. POZOR: Pohoda dedupuje server-side, Omega VŮBEC -- tam je
    -- klíč jen pro naši evidenci.
    idempotency_key       TEXT    NOT NULL,

    -- Retry NEVYRÁBÍ nový Intent (ztratila by se historie), jen inkrementuje
    -- tohle a vrací stav na EXECUTING.
    attempt               INTEGER NOT NULL DEFAULT 1,

    -- Vyplněno až po provedení. SYSTEM_CONFIRMED (Pohoda responsePack, D1
    -- meta.changes) vs LOG_INFERRED (Omega: úspěch odvozen regexem z logu).
    -- Bez tohohle rozlišení by se "úspěch z logu" tvářil jako fakt.
    confirmation_quality  TEXT,

    execution_reference   TEXT,   -- id dokumentu/logu/response, NE kopie odpovědi
    failure_reason        TEXT,

    created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT    NOT NULL DEFAULT (datetime('now')),

    CONSTRAINT ck_intent_state
        CHECK (state IN ('PLANNED','APPROVED','EXECUTING','EXECUTED',
                         'FAILED','UNKNOWN','SUPERSEDED','ABANDONED')),
    CONSTRAINT ck_intent_confirmation
        CHECK (confirmation_quality IS NULL
               OR confirmation_quality IN ('SYSTEM_CONFIRMED','LOG_INFERRED','UNCONFIRMED')),
    CONSTRAINT ck_intent_attempt
        CHECK (attempt >= 1),
    -- EXECUTED bez kvality potvrzení nedává smysl: nevědělo by se, jestli
    -- výsledek vyžaduje reconciliaci (LOG_INFERRED ji vyžaduje vždy).
    CONSTRAINT ck_intent_executed_has_quality
        CHECK (state != 'EXECUTED' OR confirmation_quality IS NOT NULL)
);

-- Idempotence: tentýž zápis se nesmí naplánovat dvakrát. Retry inkrementuje
-- `attempt` na EXISTUJÍCÍM řádku, nezakládá nový.
CREATE UNIQUE INDEX IF NOT EXISTS uq_intent_idempotency
    ON execution_intents (tenant_id, idempotency_key);

-- Fronta k provedení: co je PLANNED/APPROVED, seřazeno podle stáří.
CREATE INDEX IF NOT EXISTS idx_intent_pending
    ON execution_intents (tenant_id, state, created_at);

-- NEJDŮLEŽITĚJŠÍ INDEX PROVOZNĚ: co čeká na reconciliaci.
-- Odpovídá `requiresReconciliation()` v ExecutionIntent.ts -- tedy UNKNOWN
-- (nevíme, co se stalo) plus EXECUTED s LOG_INFERRED (potvrzení je odvozené
-- z textu, ne fakt). Bez tohohle indexu by se nejistoty musely hledat
-- full scanem a v praxi by se na ně zapomnělo.
CREATE INDEX IF NOT EXISTS idx_intent_needs_reconciliation
    ON execution_intents (tenant_id, state, confirmation_quality, updated_at)
    WHERE state = 'UNKNOWN'
       OR (state = 'EXECUTED' AND confirmation_quality = 'LOG_INFERRED');

-- Dohledání všech zápisů, které vzešly z jednoho rozhodnutí
-- ("co všechno se stalo, když jsme rozhodli tuhle cenu?").
CREATE INDEX IF NOT EXISTS idx_intent_decision
    ON execution_intents (decision_id);

-- Historie zápisů na jednu entitu + podklad pro detekci SUPERSEDED
-- (na tentýž target_ref vznikl novější Intent).
CREATE INDEX IF NOT EXISTS idx_intent_target
    ON execution_intents (tenant_id, connector_type, target_ref, created_at);
