-- 0004_voucher_burned_unclaimed.sql -- účetní podklad pro MPV režim.
-- (Digital-Voucher.md §18.6, rozhodnutí Lucky 2026-09-07)
--
-- PROČ:
--   U víceúčelového poukazu nastává zdanitelné plnění při dodání zboží.
--   Když zákazník z poukazu na 5 000 Kč nakoupí za 3 000 a zbytek propadne,
--   z těch 2 000 se stává OSTATNÍ PROVOZNÍ VÝNOS BEZ DPH -- a ten se musí
--   zaúčtovat.
--
--   Shoptet tu informaci nikde nedrží: jednorázový kupón se uplatněním
--   spálí a kolik z něj zbylo, se nikdo nedozví. NEXUS to spočítá
--   porovnáním nominálu proti skutečně uplatněné slevě (§18.7).
--
-- PROČ NULLABLE A PROČ TO JE PODSTATNÉ:
--   `NULL` znamená "ještě nevíme" -- audit neproběhl, nebo slevám
--   v objednávce nerozumíme. `0` znamená "nic nepropadlo".
--   Jsou to DVĚ RŮZNÁ TVRZENÍ a v účetnictví se nesmí splést: nula tam,
--   kde má být NULL, je nepravdivý podklad.
--
--   Proto `VoucherRedemptionAudit` vrací pět stavů místo jednoho čísla
--   a zapisuje se jen u FULLY_REDEEMED / PARTIALLY_REDEEMED.
--
-- PROČ DO `vouchers` A NE DO `voucher_transactions`:
--   Není to pohyb kreditu. Je to zůstatek, který se pohybem NIKDY NESTAL.
--   Zápis do transakcí by rozbil reconciliační invariant
--   (currentBalance = initial - SUM(REDEEMED) + SUM(REFUNDED)), protože
--   propadlá částka žádnou transakci nemá.

ALTER TABLE vouchers ADD COLUMN burned_unclaimed_minor INTEGER;

-- Kdy audit proběhl. Bez toho by nešlo odlišit "audit neproběhl" od
-- "audit proběhl a nic nepropadlo" -- obojí by mělo NULL v částce.
ALTER TABLE vouchers ADD COLUMN burned_audit_at TEXT;

-- Objednávka, ze které se propadlá částka spočítala. Dohledatelnost:
-- účetní se zeptá "z čeho ta částka je" a musí být odpověď.
ALTER TABLE vouchers ADD COLUMN burned_audit_order_id TEXT;

-- Podklad pro účetní uzávěrku: co propadlo a čeká na zaúčtování.
-- Partial index -- naprostá většina poukazů propadlou částku nemá.
CREATE INDEX IF NOT EXISTS idx_vouchers_burned
    ON vouchers (tenant_id, burned_audit_at)
    WHERE burned_unclaimed_minor IS NOT NULL AND burned_unclaimed_minor > 0;

-- POZN. k CHECK constraintu: SQLite neumí `ALTER TABLE ADD CONSTRAINT`,
-- takže invariant `0 <= burned_unclaimed_minor <= initial_balance_minor`
-- se vynucuje v aplikační vrstvě (`auditVoucherRedemption` vrací
-- OVER_REDEEMED místo záporného čísla). Kdyby se tabulka někdy
-- přestavovala, patří ten CHECK doplnit.
