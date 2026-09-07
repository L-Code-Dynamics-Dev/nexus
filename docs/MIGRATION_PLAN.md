# NEXUS — Migration Plan

Postup pro každý modul (per master prompt bod 47):
`OLD IMPLEMENTATION → NEW CANONICAL INTERFACE → NEW NEXUS MODULE → REGRESSION TEST → VALIDATION → RECONCILIATION`

Dokud nový modul nedosahuje parity se starým, **starý zůstává referenční a produkční** (bod 47). Nic se nevypíná předčasně.

---

## ZÁVAZNÉ POŘADÍ PRACÍ (rozhodnutí Lucky, 2026-09-07)

**NEXUS se nerozšiřuje do dalších domén.** Nejdřív se uzavře řetěz
`Canonical → Tenant → Domain → Connector → Execution → Audit → Reconciliation`.
Toto pořadí má přednost před jakýmkoli fázováním níže. Fáze 1–6.5 popisují, co už vzniklo; P0/P1/P2 popisuje, co se dělá teď.

### P0 — sjednocení architektury (běží)

| # | Úkol | Stav |
|---|---|---|
| 1 | Duplicitní `CanonicalEntity`/`TenantId`/`EntityId` — jeden zdroj pravdy v `core/canonical/entities/base.ts` | **HOTOVO** (commit `ebdb2fd`) |
| 2 | Zrušit hardcoded `tenantId: 'ten_1'` (`domains/pricing/createNexusPricingCalculator.ts:62`) — `TenantContext` přichází zvenku | otevřené |
| 3 | `PricingConfigurationProvider` — pricing NESMÍ číst filesystem (`fs.readFileSync` na `policy-v1.json`, tamtéž ř. 56); ve Workeru to nikdy nepoběží | otevřené |
| 4 | README odpovídající realitě | **HOTOVO** (2026-09-07) |
| 5 | Migration Plan odpovídající realitě | **HOTOVO** (2026-09-07, tento dokument) |

### P1 — NEXUS Runtime: jednotná execution pipeline

Dnes žádná jednotná pipeline neexistuje. Rules se volají ad hoc, Worker route volá Store přímo, Execution/Reconciliation existují jako typy v `core/`, ale nic jimi neprotéká. P1 to sjednocuje:

```
Request → TenantContext → Canonical Input → Validation → Domain Rule Engine
→ Decision → Execution Plan → Connector → Expected State → External Write
→ Actual State → Reconciliation → Outcome → Audit
```

Nová vrstva **Execution Intent** mezi `Decision` a `Connector`: rozhodnutí domény se nepřekládá rovnou na volání konektoru, ale na zaznamenatelný, idempotentní záměr, který teprve konektor provádí. Bez ní nejde odlišit "nerozhodli jsme se to udělat" od "rozhodli, ale zápis selhal".

### P2 — migrace domén, v tomto pořadí

`Core → Pricing → SafeOrder → Availability → Procurement → Shoptet Connector → ERP Connector → Voucher → Campaign → Invoice → Billing`

Doména se považuje za zmigrovanou, teprve když protéká celou P1 pipeline, ne když má Rules a testy.

### Voucher Fáze B — ČEKÁ (rozhodnutí Lucky)

Fáze A je hotová (D1 migrace, Rules, Store, Worker API, DO, CI zelené 19/19). **Fáze B se nezačíná, dokud není hotové P0 a P1.** Konkrétně se teď nedělá: Shoptet injector, validace instalace v UI, ostrý provoz u klienta.

---

## Fázování (odpovídá bodu 49, s realistickým rozsahem "ne roky, ale ne jeden týden")

### Fáze 0 — Infrastruktura (kroky 49.1–49.11)

**Stav: kostra hotová, běhové vrstvy z velké části otevřené.** Původní věta "Fáze 0 rozjeto, žádná doména neobsahuje přenesenou business logiku" už neplatí — entity existují, Rules existují, 754 node testů je zelených. Neplatí ani opak: existence typu v `core/` neznamená, že jím něco protéká.

| Krok | Modul | Stav k 2026-09-07 |
|---|---|---|
| Canonical Model | `core/canonical/` | **HOTOVO** — 17 souborů / 1 520 ř., `base.ts` je po `ebdb2fd` jediný zdroj pravdy pro `CanonicalEntity`/`TenantId`/`EntityId` |
| Tenant Core | `core/tenant/` | Typy a `TenantConfig` hotové (171 ř.), ale **TenantContext se nikam nepředává** — pricing má hardcoded `'ten_1'` (P0.2) |
| Validation Framework | `core/validation/` | Kostra (66 ř.) + testy. Není zapojený do jednotné pipeline (P1) |
| State Machine Framework | `core/state-machine/` | **HOTOVO** — `evaluateTransition()` používají všechny lifecycle Rules (105 ř.) |
| Audit | `core/audit/` | Typy + testy (159 ř.). Reálný audit zápis existuje jen pro voucher (`migrations/0002_voucher_audit.sql`) |
| Reconciliation | `core/reconciliation/` | Generic reconciliation (164 ř.) + testy. **Neběží proti žádnému externímu systému** |
| Error Isolation | `core/error-isolation/` | **HOTOVO** (133 ř.) — `PARTIAL_SUCCESS` vzor |
| Snapshot/Rollback | `core/snapshot/` | Kostra (172 ř.). **Žádné perzistentní úložiště** — R2/D1 backend nenapsán, takže dnes je to stejná past jako fingovaný snapshot v okfish, jen bez falešného pocitu bezpečí |
| Idempotency | `core/idempotency/` | **HOTOVO** (140 ř.) — claim/complete, in-memory store |
| Connector Layer (kostra) | `connectors/` | **Kontrakt bez implementace.** `grep "implements Connector"` = 0 výsledků. 79 z 83 souborů v `connectors/` je 1:1 legacy port (5 963 ř.), volaný přímo, ne přes rozhraní. `erp-generic/` a `custom/` jsou prázdné adresáře |
| **Perzistence** | `migrations/`, `connectors/d1/` | **Nový krok, přidán 2026-09-06.** Existuje jen pro voucher — viz Fáze A níže |
| **Runtime** | `workers/`, `wrangler.jsonc` | **Nový krok, přidán 2026-09-06.** Existuje jen pro voucher. `database_id` jsou stále placeholdery, **nikdy se nedeploylo** |

> **Čtenáři pozor:** čísla testů uvedená u jednotlivých fází níže (466/466, 527/527, … 644/644) jsou **historický záznam ke dni dané fáze**, ne aktuální stav. Aktuální stav k 2026-09-07: **754/754 node testů (61 souborů) + 19/19 Workers/D1 testů na CI**, `npx tsc --noEmit` čistý. Aktuální měření je vždy v `README.md`.

### Fáze 1 — První doménový modul: Pricing
Vybráno jako první proto, že má nejvyšší produkční zralost (1361 commitů, 11 zdokumentovaných incidentů, golden-dataset testy) — pokud fáze 0 infrastruktura neobstojí proti tomuhle nejnáročnějšímu modulu, neobstojí proti ničemu.

- **OLD**: `~/okfish-pricing-engine/src/core/{PricingEngine,interfaces,PricingContext}.ts` + `src/policies/*.ts`
- **Migrace `CustomerTier` union type → Canonical `PriceList`/`QuantityTier`**: tvrdě zadrátovaný `"ZR4"|"ZR6"|...` se musí stát tenant-scoped konfigurací (`TenantConfig.tiers: PriceList[]`), ne kódovým typem. Toto je jediná skutečná změna chování, kterou migrace vyžaduje — zbytek (policy chain, Decimal aritmetika, rounding) se přenáší 1:1.
- **Zachovat beze změny**: `HighestDiscountPolicy`, `DiscountLimitPolicy` (Product→Brand→Category fallback), `RoundingPolicy`, command pattern (`SetPriceCommand`/`WarningCommand`/`RejectCommand`), golden-dataset testy
- **`VoucherCouponPolicy` (VOUCHER vs COUPON distinkce) — HOTOVO** (2026-09-05): přeneseno z `~/Desktop/L-Code Pricing Engine(API)doplnek Shoptet/src/core/policies/VoucherCouponPolicy.ts` do `connectors/pricing-engine/legacy/voucher/VoucherCouponPolicy.ts` (1:1 legacy port) + `domains/pricing/VoucherCouponRule.ts` (Rule contract obal) + `tests/regression/golden-pricing/voucher-coupon-rule-parity.test.ts` (7/7 zelených). Stejně jako `CouponPolicyRule`, záměrně NENÍ napojeno do `createNexusPricingCalculator` — samostatná eligibility vrstva.
- **`DiscountLimitPolicy` fix z pricing-engine-platform — NEMIGROVAT** (ověřeno 2026-09-05 přímo na GitHub `origin/main` okfish-pricing-engine): živý produkční okfish má STÁLE starou VAGNER logiku (`salePrice` vyhrává bezpodmínečně, i když je mělčí než cap-floor) — platform fix (`salePrice` vyhrává jen když je hlubší než cap) nikdy nebyl nasazen do produkce, je to nepotvrzený experiment na jiné větvi. Nexus `DiscountLimitRule.ts` dnes odpovídá 1:1 ověřené produkční logice — to je správná parita, ne zaostávání. Než se cokoli mění, je potřeba u Jose/Lucky potvrdit, jestli má platform fix vůbec jít do produkce.
- **REGRESSION TEST**: portovat celou golden-dataset sadu (`tests/golden.test.ts` + fixtures) beze změny výsledků — **HOTOVO**, `tests/regression/golden-pricing/` (12 test souborů + 7 fixture scénářů × 10 ZR tierů)
- **RECONCILIATION**: nový modul musí projít stejnou reconciliation logikou jako `reconcile-pricelist-drift.ts`, srovnáno proti živému okfish výstupu na identickém vstupu — **NEHOTOVO**, `core/reconciliation/` neběží proti žádnému externímu systému

**Stav Fáze 1 k 2026-09-07: Rules hotové (12 souborů / 768 ř.), parity ověřená testy, ale modul NENÍ použitelný v produkci.** Dva P0 blokátory sedí přímo tady, v `domains/pricing/createNexusPricingCalculator.ts`:
- ř. 62 — hardcoded `tenantId: 'ten_1'` (P0.2). Porušuje "tenant-scoped od prvního řádku"; `TenantContext` musí přijít zvenku.
- ř. 56 — `fs.readFileSync(configPath)` na `policy-v1.json` (P0.3). Ve Workeru filesystem není; nutný `PricingConfigurationProvider`.

Dokud tyhle dva nepadnou, pricing nemůže projít P1 pipeline ani se dostat do Workeru. V P2 pořadí je Pricing druhý, hned po Core.

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
- **Stav k 2026-09-07: NEZAČATO jako connector.** `connectors/shoptet/legacy/` obsahuje 6 souborů / 486 ř. legacy portu (CSV objednávky + `golias.js`), ale žádná třída neimplementuje `Connector.ts` — `grep "implements Connector"` vrací nula výsledků v celém repu. V P2 pořadí je Shoptet Connector až na 6. místě.

### Fáze 5 — Omega/ERP adapter
- **OLD**: `~/omega-bridge/src/adapters/targets/omega/{OmegaMapper,OmegaAdapter}.ts`
- **Zachovat beze změny**: R01/R02 generátor, sanitizace, Windows-1250 encoding, hash triáda
- **`OmegaExecutor.ts` reálný `child_process.spawn` — HOTOVO** (2026-09-05): `connectors/omega/legacy/agent/OmegaExecutor.ts`, NEW BUILD (ne migrace simulace). Threat model pokrytý přímo v souboru (timeout+SIGTERM/SIGKILL, spawn-failure bez crashe procesu, whitelist na přesný basename místo `.endsWith()`, output cap proti runaway procesu) — 9/9 sanity testů (`tests/regression/connectors/omega-executor-sanity.test.ts`) proti mock Node skriptům. **NEOVĚŘENO PROTI REÁLNÉMU WINDOWS AGENTOVI** — žádný takový stroj nebyl při psaní dostupný; před prvním ostrým během nutno ověřit proti skutečnému `AkciaOmega.bat` (skutečný formát stdout/logu, chování při zamčeném Pohoda souboru).

### Fáze 6+ — Billing, Marketing, B2B, Campaign, Creative
**Čistě NEW BUILD.** Žádný zdrojový systém neobsahuje kód k migraci. Postavit až po Fázi 0-5, na hotovém Canonical Model + Connector Layer — jinak vzniknou stejné hardcoded/single-tenant chyby, co řešíme u Pricing Engine dnes.

**Doménová kostra + lifecycle (Fáze 6.1) — HOTOVO** (2026-09-05, Josovo zadání "Další kroky Fáze 6" + "Fáze 6.1 = lifecycle + základní invariants"):
- `core/canonical/entities/Campaign.ts` — `PromoGroup -> Product` (FK `productIds`, povinná `priority` pro řešení konfliktů více skupin), `Campaign -> PromoGroup` (1:N, `promoGroupIds`), `Campaign -> Creative`. Campaign lifecycle DRAFT→ACTIVE→PAUSED→ENDED (ENDED terminální, historie se nemaže). Creative vlastní lifecycle DRAFT→PUBLISHED→ARCHIVED. CampaignPlacement zůstává rozšiřitelný string (ne fixní enum).
- `core/canonical/entities/Invoice.ts` — `Invoice -> Order` striktně 1:1 (`orderId`). Lifecycle PENDING→ISSUED/CANCELLED (oba terminální). `omegaDocumentId` jako REFERENCE na Omega CanonicalAccountingDocument (ne kopie dat) — Omega zůstává účetním zdrojem pravdy, `omegaDocumentId` je optional (PENDING invoice může existovat před vznikem Omega dokladu).
- `core/canonical/entities/Warehouse.ts` + `Stock.ts` — `Warehouse -> StockPosition` 1:N přes volitelné `warehouseId` (Non-Interference: existující záznamy beze změny). Warehouse lifecycle ACTIVE↔INACTIVE, BEZ terminálního stavu (dočasné vypnutí, ne trvalé zrušení). Supplier zůstává úplně oddělený, žádná vazba.
- `core/canonical/entities/Billing.ts` — model Tenant→Subscription→Billing→Plan. Subscription lifecycle TRIAL→ACTIVE→PAST_DUE→CANCELLED (CANCELLED terminální, PAST_DUE↔ACTIVE obousměrné). `Subscription.planTier` sdílí typ s `core/tenant/types.ts` `TenantPlan.planTier`. Striktně BEZ vazby na Invoice/Order.
- `core/canonical/entities/Customer.ts` — B2B jako `BusinessProfile` (company/taxIdentifiers/pricingContext/paymentTerms) navázaný na Customer, NENÍ nová doména ani druhý pricing engine. `pricingContext` je jen reference (FK-like), žádná vlastní cenová logika.
- `tests/unit/Phase6DomainSkeleton.test.ts` — 26 testů (strukturální vztahy + `evaluateTransition()` lifecycle ověření pro všechny 4 stavové osy).
- `npm run build` čistý, `npm test` 466/466 (`omega-executor-sanity.test.ts` vyžaduje vyšší než default 5s timeout pod aktuální systémovou zátěží stroje, nesouvisí se Fází 6.1 změnou — ověřeno izolovaně s `--testTimeout=15000`, 9/9 zelených).

Marketing (`domains/marketing/`) a samostatná B2B doména (`domains/b2b/` jako nová business logika mimo BusinessProfile) zůstávají prázdné — Jose rozhodl: B2B je rozšíření Customer, ne vlastní doména; Marketing nebylo v zadání zmíněno jako samostatná kostra.

**Business Rules (Fáze 6.2) — HOTOVO** (2026-09-05, Josovo zadání "Fáze 6.2 – Business Rules nad existující kostrou", implementováno 3 paralelními forky na nezávislé domény):
- `domains/campaign/CampaignLifecycleRule.ts` — `evaluateTransition()` + invariant: DRAFT/PAUSED→ACTIVE vyžaduje aspoň jednu PromoGroup.
- `domains/campaign/PromoGroupPriorityRule.ts` — validace `priority` (konečné, nezáporné číslo) + `resolveConflict()` čistá funkce (nejvyšší priority vyhrává; remíza = `resolved: false`, žádný tichý tie-break).
- `domains/campaign/CreativeLifecycleRule.ts` — `evaluateTransition()` + invariant: DRAFT→PUBLISHED vyžaduje neprázdný `content`. ARCHIVED terminalita respektována přes existující definici, žádná nová logika.
- `domains/invoice/InvoiceLifecycleRule.ts` — `evaluateTransition()` + invariant: PENDING→ISSUED vyžaduje neprázdný `orderId`. `omegaDocumentId` nikdy negenerována, jen čtena jako informační poznámka.
- `domains/warehouse/WarehouseStockLinkRule.ts` — ověří `StockPosition.warehouseId` odkazuje na `Warehouse` se `status === 'ACTIVE'` (čistá funkce, žádné I/O, žádná vazba na Supplier).
- `domains/billing/SubscriptionLifecycleRule.ts` — `evaluateTransition()` + `planTier` validace proti existujícímu `PlanTier` typu (`core/tenant/types.ts`), žádná duplicitní logika, žádná vazba na Invoice.
- `domains/b2b/BusinessProfileAccessor.ts` — `getBusinessProfile()`/`isBusinessCustomer()`/`getB2BPricingContext()` jako jediný kontrakt pro čtení B2B dat jinými doménami (místo přímého sahání do `customer.businessProfile`).
- Testy: `tests/unit/{CampaignRules,InvoiceRules,WarehouseRules,BillingRules,B2BRules}.test.ts` — 61 nových testů (22+11+6+13+9).
- `npm run build` čistý, `npm test` 527/527 (466 před Fází 6.2 + 61 nových; `omega-executor-sanity.test.ts` ověřen izolovaně s vyšším timeoutem kvůli systémové zátěži stroje, nesouvisí se změnou).

**Rozhodnutí (Fáze 6.3) — HOTOVO** (2026-09-05, Josovo zadání "rozhodnutí těchto šesti bodů", implementováno 3 paralelními forky na nezávislé domény):
1. **Campaign ACTIVE vs PAUSED**: `shouldEvaluateCampaign(status)` v `CampaignLifecycleRule.ts` — `true` jen pro ACTIVE, žádná další odlišnost.
2. **PromoGroup tie-break**: `resolveConflict()` už NEVRACÍ `resolved: false` na remízu — deterministický tie-break: nejstarší `createdAt`, při shodě nejmenší `id`. Nové pole `tieBreakApplied` signalizuje, že rozhodlo víc než čistá priority.
3. **Invoice ISSUED + Omega**: `InvoiceLifecycleRule.ts` — PENDING→ISSUED teď vyžaduje i neprázdný `omegaDocumentId` (dřív jen `orderId`). `omegaDocumentId` STÁLE nikdy negenerována, jen vyžadována jako podmínka.
4. **Warehouse warehouseId undefined**: `WarehouseStockLinkRule.ts` — nový diskriminant `linkStatus: 'ACTIVE_LINK' | 'UNSCOPED' | 'MISMATCHED_WAREHOUSE' | 'INACTIVE_WAREHOUSE'`. `undefined` → `UNSCOPED` (globální/neurčený sklad), explicitně odlišené od chyby, žádný fallback na "hlavní sklad".
5. **Subscription ↔ TenantPlan**: `isConsistentWithTenantPlan()` v `SubscriptionLifecycleRule.ts` — čistá konzistenční kontrola (ne sync/přepis). Jisté shody: ACTIVE↔ACTIVE, CANCELLED↔CANCELED. Nejlepší odvození: PAST_DUE↔GRACE_PERIOD. Fail-safe `false`: TRIAL (nemá přímý ekvivalent), SUSPENDED proti čemukoliv.
6. **BusinessProfile validace**: nový `domains/b2b/BusinessProfileValidationRule.ts` — jen strukturální (neprázdné `company`/`taxIdentifiers`, optional pole neprázdná pokud přítomná). ŽÁDNÁ validace formátu (IČO/DIČ regex, délka) — to zůstává na budoucí konkrétní kontrakt.

Testy: 88 nových/upravených (Campaign 22→25, Invoice 11→14, Warehouse 6→7, Billing 13→20, B2B 9→19).
`npm run build` čistý, `npm test` 551/551 (542 hlavní běh + 9 omega-executor izolovaně s vyšším timeoutem kvůli systémové zátěži stroje).

**Stále UNRESOLVED po Fázi 6.3** (Jose fail-safe explicitně žádal nedomýšlet i tady):
- Subscription 'TRIAL' ↔ TenantPlan mapping — žádný přímý ekvivalent v TenantPlan enum, `isConsistentWithTenantPlan` vrací `false` (nekonzistentní/neověřitelné), ne tichou shodu.
- Subscription 'PAST_DUE' ↔ TenantPlan 'GRACE_PERIOD' — nejlepší dostupné odvození ze jmen, ne jistota (GRACE_PERIOD nebyl nikde jinde v repu blíž specifikován).

**Explicitně MIMO SCOPE** (Jose: "Neimplementovat zatím", nezměněno Fází 6.3) — konkrétní promo výpočty/ceny, marketingové distribuční kanály, skladové přesuny/rezervace/alokace, automatická fakturace, payment gateway, usage billing, B2B approval workflow, B2B credit limity, retargeting/email/affiliate, validace formátu BusinessProfile polí.

**Business Flows (Fáze 6.4) — HOTOVO** (2026-09-05, Josovo zadání "skutečné business flows... jen flows, které mají přímou oporu v dosavadních rozhodnutích", implementováno 3 paralelními forky na nezávislé domény). Žádné nové business rozhodnutí, žádná nová abstrakce — čistá kompozice existujících Rules do use-case výsledků:

- `domains/campaign/CampaignFlows.ts`:
  - `resolveCampaignPromoGroupForProduct()` — Campaign→PromoGroup→Product: filtruje `campaign.promoGroupIds` na skupiny obsahující daný produkt, volá `resolveConflict()`.
  - `evaluateCampaignForProduct()` — Campaign evaluation ACTIVE/PAUSED: `shouldEvaluateCampaign()` jako krátké zkrácení, PAUSED/DRAFT/ENDED nevolá `resolveConflict()` vůbec.
  - `publishCreative()` — Creative publication: tenký wrapper nad `CreativeLifecycleRule` s `targetStatus: 'PUBLISHED'`.
  - (PromoGroup conflict resolution jako samostatný flow VYNECHÁN — `resolveConflict()` z Fáze 6.3 už JE ten obecný use-case, další alias by byl čistá duplicita jména.)
- `domains/invoice/OrderInvoiceOmegaFlow.ts` — `evaluateOrderInvoiceOmegaFlow()` — Order→Invoice→Omega reference: use-case wrapper nad `InvoiceLifecycleRule` s explicitním Order/omegaDocumentId kontextem.
- `domains/warehouse/WarehouseStockFlow.ts` — `evaluateWarehouseStockLink()` (1:1) + `resolveWarehouseStockLinks()` (pole-varianta, čistý `Array.map()`, žádná agregace/nová logika) — Warehouse→StockPosition.
- `domains/billing/TenantSubscriptionPlanFlow.ts` — `evaluateTenantSubscriptionPlanFlow()` — Tenant→Subscription→Plan: skládá `SubscriptionLifecycleRule` (určuje `allowed`) + `isConsistentWithTenantPlan()` (jen reportuje, NIKDY neblokuje — potvrzeno testem "allowed zůstává true i při nekonzistenci").
- `domains/b2b/CustomerBusinessContextFlow.ts` — `resolveCustomerBusinessContext()` — Customer→BusinessProfile→ostatní domény: skládá `isBusinessCustomer()` + `BusinessProfileValidationRule` + `getB2BPricingContext()`, validace neblokuje čtení pricingContext.

Testy: 43 nových (Campaign 11, Invoice 8, Warehouse 7, Billing 10, B2B 7).
`npm run build` čistý, `npm test` 594/594 (585 hlavní běh + 9 omega-executor izolovaně s vyšším timeoutem kvůli systémové zátěži stroje).

**Explicitně MIMO SCOPE** (Jose: "zatím vůbec neřešit", nezměněno Fází 6.4) — konkrétní promo výpočet, platební provider, subscription payment flow, B2B schvalování/limity, skladové přesuny, marketingové kanály, TRIAL mapping, PAST_DUE/GRACE_PERIOD jistota.

Cesta 6.0 kostra → 6.1 lifecycle → 6.2 business rules → 6.3 rozhodnutí → 6.4 business flows je uzavřená bez domýšlení na žádném kroku.

**Domain Rules (Fáze 6.5) — Campaign/PromoGroup HOTOVO** (2026-09-05, Josovo zadání "Fáze 6.5 – Domain Rules... Začal bych Campaign + PromoGroup"). PRVNÍ konkrétní business logika, ne jen kompozice/kostra — implementováno JEDNOU sekvenčně (ne paralelní forky, přesné pořadí v cenovém modelu je jeden provázaný celek):

- `core/canonical/entities/Campaign.ts` — `PromoGroup` rozšířena o volitelné `discount: PromoGroupDiscount` (`type: 'PERCENTAGE' | 'FIXED_AMOUNT'`, `value`). Non-Interference: optional pole, existující PromoGroup záznamy/testy beze změny chování.
- `domains/campaign/PromoGroupDiscountRule.ts` (nový) — implementuje PŘESNÝ Josův architektonický model: `PromoGroup se aplikuje na currentPrice (cena PO Pricing chainu), NIKDY na basePrice`. Kandidátní model, NE řetězení procent — vytvoří promo cenu z vítězné PromoGroup a vrátí **minimum** z `currentPrice` a promo ceny (nikdy tiché zdražení, nikdy sčítání s jinými slevami). Přesná shoda (promoPrice === currentPrice) → zdroj zůstává `CURRENT_PRICE` (deterministické). PERCENTAGE/FIXED_AMOUNT defenzivně ořezány proti záporné ceně (config chyba nesmí projít, i když Jose tuhle konkrétní hranici výslovně nezopakoval — označeno jako defenzivní krok, ne potvrzené pravidlo).
- `domains/campaign/CampaignFlows.ts` — nová `evaluateCampaignPromoPricingForProduct()` skládá Flow 2 (conflict resolution, Fáze 6.3) + `PromoGroupDiscountRule` (Fáze 6.5) v přesném pořadí, které Jose zadal: "nejdřív se vyřeší konflikt podle priority → createdAt → id... Teprve vítězná PromoGroup vytvoří kandidátní cenu."
- QuantityTierRule (Fáze 1, design proposal §6 stále nerozhodnut) zůstává **nedotčena** — tato Rule o ní vůbec neví, jen vytváří PromoGroup kandidáta na stejné úrovni cenového modelu (currentPrice). Obecný N-way výběr mezi VÍCE kandidáty (PromoGroup + QuantityTier + budoucí typy najednou) je MIMO SCOPE — Jose zadal jen párové porovnání "currentPrice vs. PromoGroup cena".

Testy: 14 nových (`PromoGroupDiscountRule.test.ts` 9 + `CampaignFlows.test.ts` +5).
`npm run build` čistý, `npm test` 608/608 (599 hlavní běh + 9 omega-executor izolovaně s vyšším timeoutem kvůli systémové zátěži stroje).

**UNRESOLVED** (defenzivní implementace, ne potvrzené business pravidlo — Jose to explicitně nezopakoval pro tuto konkrétní Rule): horní hranice PERCENTAGE (0 ≤ value < 1) a FIXED_AMOUNT clamp na 0 jsou odvozeny z konvence jiných existujících Rules (DiscountLimitRule/D1 schema), ne z tohoto konkrétního zadání.

**Hraniční testovací matice (Fáze 6.5 pokračování) — HOTOVO** (2026-09-06, Josovo zadání "Nejprve doplnit testovací matici přesně na hraniční kombinace" před pokračováním na Creative). End-to-end ověření celého kandidátního cenového modelu napříč Pricing chainem (Fáze 1), PromoGroup (Fáze 6.5) a QuantityTier (design proposal placeholder):

- `connectors/pricing-engine/legacy/promo/free-units.ts` + `domains/pricing/XPlusXRule.ts` (nové) — X+X ("2+1 zdarma") přeneseno 1:1 z `~/hecmania-quantity-pricing` jako legacy port (analogicky k VoucherCouponPolicy). Per-varianta paid/free split, nezávislé na ceně. `inScope: false` explicitně odlišuje "produkt mimo X+X scope" od "v scope, 0 kusů".
- `domains/pricing/BestCandidatePriceRule.ts` (nový) — finální krok kandidátního modelu: `currentPrice` je VŽDY jeden z kandidátů, absolutní minimum napříč `PROMO_GROUP`/`QUANTITY_TIER`/`CURRENT_PRICE` — nikdy sčítání procent, nikdy zdražení. Přesná shoda → `CURRENT_PRICE` vyhrává (deterministické).
- `tests/integration/PromoQuantityBoundaryMatrix.test.ts` (nový) — 10/10 hraničních scénářů z Josova zadání, doslovně: (1) běžná cena + loyalty + quantity, (2) akční cena + loyalty (VAGNER pravidlo respektováno), (3) akční cena + quantity (počítáno ze sale ceny, ne z basePrice), (4) loyalty + PromoGroup, (5) loyalty + PromoGroup + QuantityTier (nejnižší vyhrává, ne součet), (6) X+X + QuantityTier (quantity počítáno z CELKOVÉHO počtu včetně X+X zdarma kusů), (7) produkt mimo X+X scope, (8) více PromoGroup → priority → výpočet, (9) PAUSED campaign → žádná promo cena, (10) kandidát vyšší než currentPrice → nesmí zdražit.
- Testy: 23 nových (X+X parity 5, BestCandidatePriceRule 8, boundary matrix 10).
- `npm run build` čistý, `npm test` 631/631 (622 hlavní běh + 9 omega-executor izolovaně, ověřeno s `--testTimeout=30000` kvůli extrémní systémové zátěži stroje v době běhu — load average přes 600, ne regrese).

Testovací matice záměrně používá existující `policy-v1.json`/ZR tier konfiguraci (jediná funkční Pricing chain konfigurace v repu) — jde o ověření produkčního kódu, ne o vlastní klientská data.

**Domain Rules (Fáze 6.5 pokračování) — Creative HOTOVO** (2026-09-06, Josovo zadání: "Creative není další cenová vrstva. Je to obsahová vrstva kampaně, která říká co se má zákazníkovi zobrazit a v jakém kontextu."):

- `core/canonical/entities/Campaign.ts` — `Creative` rozšířena o `placementTypes: string[]` (1:N, ne 1:1 — Jose: "jeden Creative může mít více placementů") a vlastní `priority: number` (nezávislé na PromoGroup.priority — řeší vykreslovací pořadí, ne cenový konflikt). `INITIAL_PLACEMENT_TYPES` = `homepage`/`category`/`product`/`checkout` jako doporučené hodnoty, string zůstává rozšiřitelný (ne enum). **`CampaignPlacement` entita zůstává explicitně nevyužitá** — vazba Creative↔placement jde přes `Creative.placementTypes`, ne přes `CampaignPlacement.campaignId`.
- `domains/campaign/CreativeResolutionRule.ts` (nový) — resolve řetězec (NE nový lifecycle): Campaign ACTIVE? → Creative PUBLISHED? → placement odpovídá? → produkt patří do PromoGroup Campaign? → shouldRender. Creative NIKDY nepočítá/nemění cenu — žádné volání Pricing/PromoGroup/QuantityTier Rules.
- `domains/campaign/CampaignFlows.ts` — nová `resolveCreativesForPlacement()` skládá `CreativeResolutionRule` přes více kandidátních Creative a vrací jen eligible, seřazené podle `priority` (vyšší první, stabilní řazení).
- Testy: 34 nových (`CreativeResolutionRule.test.ts` 9, `CampaignFlows.test.ts` +4, existující testy opraveny na nový povinný shape).
- `npm run build` čistý, `npm test` 644/644 (635 hlavní běh + 9 omega-executor izolovaně).

**UNRESOLVED** (Jose nezadal, NEIMPLEMENTOVÁNO): tie-break při shodné `priority` dvou+ Creative ve stejném placementu (řazení je jen stabilní/deterministické, ne odsouhlasený algoritmus jako u PromoGroup createdAt/id); přesný vztah "odpovídá kategorie" v resolve řetězci (Product má `categoryId`, ale PromoGroup nemá vazbu na kategorii vůbec, jen na `productIds` — Rule řeší jen produkt-přes-PromoGroup scope).

**Zbývající Domain Rules (Fáze 6.5 pokračování, JEDNA doména najednou, podle Josova pořadí):** B2B (obchodní pravidla firemních zákazníků) → Invoice/Omega (skutečný dokladový workflow) → Warehouse (skutečná skladová logika) → Billing/Subscription (skutečný SaaS billing).

**POZASTAVENO 2026-09-07 (Lucky).** Fáze 6.5 se dál nerozšiřuje. Další domény přijdou na řadu až v P2, a to až po dokončení P0 a P1 — nemá smysl přidávat business rules k doménám, které neprotékají žádnou execution pipeline.

---

### Fáze A — Digital Voucher: první perzistence a runtime v NEXUSu (2026-09-06 až 07) — HOTOVO

Tohle je zlom, který v tomto plánu do teď nebyl zapsaný. **Do 6. 9. 2026 byl NEXUS knihovna business logiky bez runtime** — entity, Rules, testy, ale žádná databáze, žádný proces, žádný deployment. Voucher Fáze A poprvé přidala běhovou vrstvu:

| Co vzniklo | Kde |
|---|---|
| První D1 migrace | `migrations/0001_credit_voucher.sql` (peníze INTEGER v haléřích, `version` sloupec, partial unique index, CHECK `current_balance >= 0`), `migrations/0002_voucher_audit.sql` |
| První Worker config | `wrangler.jsonc` — dev + `env.production` s fyzicky oddělenou databází, D1 binding `DB`, DO binding `VOUCHER_SECURITY`, `new_sqlite_classes` |
| První HTTP entry point | `workers/api/` — `index.ts`, `hmac.ts`, `http.ts`, `types.ts`, `SecurityCoordinator.ts`, `routes/voucher.ts`, `routes/issuance.ts` |
| První Durable Object | `SecurityCoordinator` — nonce (replay protection §6.2) + rate limit (§4) |
| První perzistentní store | `connectors/d1/D1CreditVoucherStore.ts` + `moneyMapper.ts` (1 210 ř.) — jediný nativní konektor v repu |
| Doménová logika | `domains/voucher/` — `CreditVoucherValidityRule`, `RedemptionRule`, `LifecycleRule`, `Store`, `CodeGenerator` (5 souborů / 1 462 ř.) |
| Entita | `core/canonical/entities/CreditVoucher.ts` |
| První CI | `.github/workflows/test.yml` — joby `node` a `workers`, oba `ubuntu-latest` |

Commity: `d6eecc8` → `93eb4b1` → `ca70a5b` → `8b70c3e` → `01d842b`.

**Klíčový nález, prokázaný během na reálné D1 (ne odvozený z dokumentace):** D1 `batch()` se rollbackuje jen při SQL chybě. `UPDATE ... WHERE version = ?`, který nematchne žádný řádek, chybou není — batch projde, `success: true` u obou statementů, zůstatek se nezmění a transakce o čerpání se **zapíše**. Naivní `db.batch([UPDATE, INSERT])` by znamenal voucher k utracení donekonečna, a hůř: zabraný unique index by způsobil, že retry vyhodnotí situaci jako idempotentní replay a vrátí `consumed: true`. Opraveno v `ca70a5b` (nejdřív UPDATE, ověřit `meta.changes === 1`, teprve pak INSERT).

**Status atomického čerpání: OVĚŘENO** — `tests/workers/schema.test.ts` 19/19 zelených na CI proti reálné D1.

**Co Fáze A NEMÁ:** nasazení. `database_id` a `preview_database_id` ve `wrangler.jsonc` jsou pořád placeholdery `<vyplnit-po-wrangler-d1-create>`, databáze `nexus-voucher-dev` ani `nexus-voucher` fyzicky neexistují. Runtime je napsaný a otestovaný, ne provozovaný.

**Známý blokátor:** Workers/D1 testy nejdou spustit na vývojovém stroji — workerd vyžaduje macOS 13.5+, Mac Mini 2014 jede 12.7.6. Hardwarový strop, ne konfigurace. Jediné ověření je CI job na Ubuntu.

**Fáze B ČEKÁ** (Lucky, 2026-09-07) — Shoptet injector, validace instalace v UI a ostrý provoz u klienta se nezačínají před dokončením P0 a P1.

---

### Design proposals — stav

| Dokument | Stav |
|---|---|
| `docs/design-proposals/Digital-Voucher.md` | **v3, UZAVŘENO.** Všechna tři blokující rozhodnutí padla (Lucky): (a) atomicita = optimistický zámek se `version` sloupcem, DB je autorita, ne Durable Object; (b) cesta do košíku = kredit produkt `1 Kč × N ks` + kupón 100 % omezený na kategorii; (c) daňový režim = víceúčelový poukaz (MPV) dle § 15b ZDPH. Otevřený požadavek Lucky: naše UI musí instalaci validovat a průběžně kontrolovat (kredit produkt za 1 Kč, kategorie, omezení kupónu, nasazený JS) — bez toho nejde systém zapnout; v návrhu zatím nezapsáno. |
| `docs/design-proposals/ERP-Generic-Layer.md` | **Návrh, neimplementováno.** `connectors/erp-generic/` je prázdný. Klíčové nálezy: Pohoda dedupuje server-side, Omega vůbec → slepý retry = duplicitní faktura; Omega nemá strojovou odpověď (úspěch se čte z logu regexem) → nutné `confirmationQuality: SYSTEM_CONFIRMED \| LOG_INFERRED`; `taxRate: number` nerozliší osvobozeno / mimo předmět / PDP (dotýká se MPV — "bez DPH" ≠ "0 %"); `cancel()` do rozhraní nepatří (storno je účetně nový doklad). Blokátor: `OmegaExecutor` neověřený proti reálnému Windows agentovi. |
| `docs/design-proposals/Shoptet-Premium-Template.md` | **Návrh, neimplementováno.** Shoptet nemá editovatelné server-side šablony (žádný Twig), HTML nevlastníme. Blank template mode jen na Premium (~12 tis./měs) — blokuje škálovatelnost. Nativní konfigurace = 6 barev + 2 fonty. Konfigurátor generuje statický `theme.css` → SFTP na Shoptet CDN, produkce nikdy nevolá naši infrastrukturu. Dlaždice primárně čistým CSS, ne JS přeskládáním DOM. Odhad: MVP 12–15 týdnů, plný self-service 22–28 týdnů. |
| `docs/design-proposals/Pricing-Shadow-Migration.md` | Návrh stínového běhu pricingu proti živému okfish. Neimplementováno — předpokládá P1 pipeline. |
| `docs/design-proposals/QuantityTier-Hecmania.md` | Otevřeno, §6 nerozhodnut. `domains/pricing/QuantityTierRule.ts` je placeholder. |
| `docs/design-proposals/Fase6-new-domains-status.md` | Stavový dokument k Fázi 6, překonaný sekcí P0/P1/P2 nahoře. |

---

## Co explicitně NEPŘENÁŠET

- `okfish-pricing-engine` hardcoded `SECRET_TOKEN` (aktivní bezpečnostní díra, viz paměť) — NEXUS Connector Layer musí od začátku používat env/secret store
- Fingovaný rollback snapshot mechanismus (zápis na efemérní CI disk) — root cause řešit v `core/snapshot/` od nuly
- `sync-coupon-fields-diff.ts`-style situace, kde je jeden modul (kupóny) bez pravidelného fallbacku, jen na nespolehlivém webhooku — Error Isolation + State Machine framework v NEXUS Core musí tohle strukturálně vyloučit
