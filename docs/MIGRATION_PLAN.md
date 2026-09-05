# NEXUS — Migration Plan

Postup pro každý modul (per master prompt bod 47):
`OLD IMPLEMENTATION → NEW CANONICAL INTERFACE → NEW NEXUS MODULE → REGRESSION TEST → VALIDATION → RECONCILIATION`

Dokud nový modul nedosahuje parity se starým, **starý zůstává referenční a produkční** (bod 47). Nic se nevypíná předčasně.

## Fázování (odpovídá bodu 49, s realistickým rozsahem "ne roky, ale ne jeden týden")

### Fáze 0 — Infrastruktura (kroky 49.1–49.11)
Musí být hotovo dřív, než začne přenos jakékoli domény — jinak se pricing/safeorder/etc. staví na písku.

| Krok | Modul | Zdroj vzoru |
|---|---|---|
| Canonical Model | `core/canonical/` | Nová abstrakce (žádný zdroj to nemá hotové) — viz ARCHITECTURE_MAP.md kritický nesoulad |
| Tenant Core | `core/tenant/` | AIE `TenantConfig` + SafeOrder `tenants`/`tenant_policies` tabulky |
| Validation Framework | `core/validation/` | Pricing Engine 5-stage model (`CORE_LOGIC_AND_VALIDATION.md`) + SafeOrder 5-stage pipeline + Omega Gate 1-5 — tři nezávislé implementace téhož, sjednotit do jedné |
| State Machine Framework | `core/state-machine/` | Omega `SyncJob`/`JobState` (nejexplicitnější) + AIE `PurchaseOrder` status enum |
| Audit | `core/audit/` | Omega hash triáda (source/canonical/target payload) + AIE `procurement_audit_log` (JSONB append-only) |
| Reconciliation | `core/reconciliation/` | Pricing Stage 5 (`reconcile-pricelist-drift.ts`, `reconcile-coupon-drift.ts`) — jediný zdroj s živě ověřenou reconciliation logikou |
| Error Isolation | `core/error-isolation/` | Nová abstrakce — inspirace: Pricing `PricelistWriter.processDiff()` per-item `successfulDiffs`/`failedCodesInChunk` vzor |
| Snapshot/Rollback | `core/snapshot/` | Pricing `.snapshots/` konvence — **POZOR**: aktuální implementace v okfish je fingovaná (píše na efemérní CI disk, viz `project_okfish_pricing_engine_inc012` paměť) — NEXUS verze musí řešit správně (R2/perzistentní storage) od začátku, ne opakovat stejnou chybu |
| Idempotency | `core/idempotency/` | AIE `procurement_idempotency_keys` claim/complete pattern — nejzralejší implementace ze všech zdrojů |
| Connector Layer (kostra) | `connectors/` | `pricing-engine-platform`'s `EcommercePlatformAdapter` (adaptér nikdy nepočítá byznys logiku, jen překládá data) — architektonicky nejčistší vzor v celém portfoliu |

### Fáze 1 — První doménový modul: Pricing
Vybráno jako první proto, že má nejvyšší produkční zralost (1361 commitů, 11 zdokumentovaných incidentů, golden-dataset testy) — pokud fáze 0 infrastruktura neobstojí proti tomuhle nejnáročnějšímu modulu, neobstojí proti ničemu.

- **OLD**: `~/okfish-pricing-engine/src/core/{PricingEngine,interfaces,PricingContext}.ts` + `src/policies/*.ts`
- **Migrace `CustomerTier` union type → Canonical `PriceList`/`QuantityTier`**: tvrdě zadrátovaný `"ZR4"|"ZR6"|...` se musí stát tenant-scoped konfigurací (`TenantConfig.tiers: PriceList[]`), ne kódovým typem. Toto je jediná skutečná změna chování, kterou migrace vyžaduje — zbytek (policy chain, Decimal aritmetika, rounding) se přenáší 1:1.
- **Zachovat beze změny**: `HighestDiscountPolicy`, `DiscountLimitPolicy` (Product→Brand→Category fallback), `RoundingPolicy`, command pattern (`SetPriceCommand`/`WarningCommand`/`RejectCommand`), golden-dataset testy
- **`VoucherCouponPolicy` (VOUCHER vs COUPON distinkce) — HOTOVO** (2026-09-05): přeneseno z `~/Desktop/L-Code Pricing Engine(API)doplnek Shoptet/src/core/policies/VoucherCouponPolicy.ts` do `connectors/pricing-engine/legacy/voucher/VoucherCouponPolicy.ts` (1:1 legacy port) + `domains/pricing/VoucherCouponRule.ts` (Rule contract obal) + `tests/regression/golden-pricing/voucher-coupon-rule-parity.test.ts` (7/7 zelených). Stejně jako `CouponPolicyRule`, záměrně NENÍ napojeno do `createNexusPricingCalculator` — samostatná eligibility vrstva.
- **`DiscountLimitPolicy` fix z pricing-engine-platform — NEMIGROVAT** (ověřeno 2026-09-05 přímo na GitHub `origin/main` okfish-pricing-engine): živý produkční okfish má STÁLE starou VAGNER logiku (`salePrice` vyhrává bezpodmínečně, i když je mělčí než cap-floor) — platform fix (`salePrice` vyhrává jen když je hlubší než cap) nikdy nebyl nasazen do produkce, je to nepotvrzený experiment na jiné větvi. Nexus `DiscountLimitRule.ts` dnes odpovídá 1:1 ověřené produkční logice — to je správná parita, ne zaostávání. Než se cokoli mění, je potřeba u Jose/Lucky potvrdit, jestli má platform fix vůbec jít do produkce.
- **REGRESSION TEST**: portovat celou golden-dataset sadu (`tests/golden.test.ts` + fixtures) beze změny výsledků
- **RECONCILIATION**: nový modul musí projít stejnou reconciliation logikou jako `reconcile-pricelist-drift.ts`, srovnáno proti živému okfish výstupu na identickém vstupu

### Fáze 2 — SafeOrder (Risk)
- **OLD**: `~/safeorder-3.0/src/core/{risk-engine,risk-graph,calibration,economics,policy-engine}/`
- Už dnes multi-tenant navržený (`tenant_id` všude) — nejmenší migrační tření ze všech domén
- **Zachovat beze změny**: blind-token privacy vrstva, `CalibrationEngine` state machine (GENERATED→VALIDATED→SHADOW→ACTIVE), economic decision model, outcome learning
- **Otevřená bezpečnostní mezera k opravě při migraci** (Phase 14 adversarial audit, `~/Downloads/safeorder-3.0-main`): `state`/`health` pole nejsou součástí `CalibrationProfile` checksumu — opravit v NEXUS verzi, ne přenášet mezeru dál

### Fáze 3 — Availability + Procurement
- **OLD**: `~/availability-intelligence-engine/src/core/{availability,procurement}/`
- Nejlépe hexagonálně oddělený kód ze všech zdrojů — `ports.ts` mapuje téměř 1:1 na NEXUS Connector Layer koncept
- **Zachovat beze změny**: `ProcurementEngine.plan/receive`, `SupplierSelectionEngine` scoring, idempotency pattern
- **NEW BUILD, ne migrace**: `ShoptetOutboundSync` je jen mock — reálný zápis do Shoptetu čeká na Connector Layer V1 (no-API, GOLIÁŠ vzor)
- **Nepřenášet**: `frontend/nexustp/dashboard.js` logiku 1:1 — je to shadow-test UX vzor (schválený vizuál), ne funkční kód s napojením; UI se staví nově proti skutečnému NEXUS Core API, jen re-použije schválený UX jazyk (CO SE DĚJE/CO SE STANE/CO MÁTE UDĚLAT)

### Fáze 4 — Connector Layer V1 (Shoptet no-API)
- **OLD**: GOLIÁŠ (`~/shoptet-variant-matrix/shoptet/golias.js`) — nativní `cartShared.addToCart` + DOM fallback
- **OLD**: Omega CSV parser (`~/omega-bridge/src/adapters/shoptet-file/`) + AIE `NoApiCsvAdapter`
- **PŘEHODNOCENO 2026-09-05** — původní věta "3 nezávislé Shoptet CSV parsery, sjednotit do jednoho" byla nepřesná: `connectors/shoptet/legacy/cart/golias.js` (GOLIÁŠ) je nativní košík/DOM add-to-cart adapter, ŽÁDNÝ CSV parser vůbec — nepatří do tohoto bodu. Zbylé dva (`connectors/shoptet/legacy/csv/` pro OBJEDNÁVKY, schema-driven s validation gates; `connectors/supplier-csv/legacy/NoApiCsvAdapter.ts` pro DODAVATELE, poziční `split(',')`) parsují zcela odlišná schémata dat (jiné sloupce, jiný delimiter, jiná doména) — sloučení do jednoho parseru by bylo věcně špatně. **Není co migrovat/sjednocovat** — obě zůstávají oddělené, správně specializované na svou doménu dat. Pokud se v budoucnu ukáže potřeba sdíleného delimiter/row-parsing kódu, jde o extrakci společné utility (core/), ne sloučení business logiky.
- Bod 41 zadání: musí fungovat bez API. Toto je blokující předpoklad pro Fázi 1-3 reálného nasazení (ne jen testů)

### Fáze 5 — Omega/ERP adapter
- **OLD**: `~/omega-bridge/src/adapters/targets/omega/{OmegaMapper,OmegaAdapter}.ts`
- **Zachovat beze změny**: R01/R02 generátor, sanitizace, Windows-1250 encoding, hash triáda
- **`OmegaExecutor.ts` reálný `child_process.spawn` — HOTOVO** (2026-09-05): `connectors/omega/legacy/agent/OmegaExecutor.ts`, NEW BUILD (ne migrace simulace). Threat model pokrytý přímo v souboru (timeout+SIGTERM/SIGKILL, spawn-failure bez crashe procesu, whitelist na přesný basename místo `.endsWith()`, output cap proti runaway procesu) — 9/9 sanity testů (`tests/regression/connectors/omega-executor-sanity.test.ts`) proti mock Node skriptům. **NEOVĚŘENO PROTI REÁLNÉMU WINDOWS AGENTOVI** — žádný takový stroj nebyl při psaní dostupný; před prvním ostrým během nutno ověřit proti skutečnému `AkciaOmega.bat` (skutečný formát stdout/logu, chování při zamčeném Pohoda souboru).

### Fáze 6+ — Billing, Marketing, B2B, Campaign, Creative
**Čistě NEW BUILD.** Žádný zdrojový systém neobsahuje kód k migraci. Postavit až po Fázi 0-5, na hotovém Canonical Model + Connector Layer — jinak vzniknou stejné hardcoded/single-tenant chyby, co řešíme u Pricing Engine dnes.

## Co explicitně NEPŘENÁŠET

- `okfish-pricing-engine` hardcoded `SECRET_TOKEN` (aktivní bezpečnostní díra, viz paměť) — NEXUS Connector Layer musí od začátku používat env/secret store
- Fingovaný rollback snapshot mechanismus (zápis na efemérní CI disk) — root cause řešit v `core/snapshot/` od nuly
- `sync-coupon-fields-diff.ts`-style situace, kde je jeden modul (kupóny) bez pravidelného fallbacku, jen na nespolehlivém webhooku — Error Isolation + State Machine framework v NEXUS Core musí tohle strukturálně vyloučit
