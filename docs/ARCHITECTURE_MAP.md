# NEXUS — Architecture Map

Zdrojový audit: `~/nexus-audit/*.md` (2026-09-04) + přímé ověření proti kódu (viz odkazy na konkrétní soubory/řádky). Toto je krok 1+2 z master promptu (Codebase Audit → Architecture Map) — sepsáno před jakýmkoli přenosem kódu.

## Zdrojové systémy a jejich reálný stav

| Systém | Cesta | Produkční stav | Klíčová hodnota k přenesení |
|---|---|---|---|
| Pricing Engine (okfish) | `~/okfish-pricing-engine` | Živá produkce, 1361 commitů, incident log (11 incidentů) | `PricingEngine`/`PricingPolicy` command pattern, Decimal aritmetika, golden-dataset testy |
| Pricing Engine (platform) | `~/pricing-engine-platform` | Fork jádra + multi-platform R&D (Shopify/Medusa live-verified) | `EcommercePlatformAdapter` rozhraní — nejblíž k tomu, co NEXUS Connector Layer potřebuje |
| Pricing Engine (Desktop) | `~/Desktop/L-Code Pricing Engine(API)doplnek Shoptet` | Rané stádium, nikdy nasazeno | `VoucherCouponPolicy`, D1 multi-tenant schema (`shops`, `tier_configs`) — jediný z pricing kandidátů navržený multi-tenant |
| SafeOrder | `~/safeorder-3.0` | Kompletní, testovaný, nikdy živě nenasazen | 5-stage pipeline, blind-token privacy, `CalibrationEngine` (per-merchant), risk graph s time-decay |
| AIE / Availability + Procurement | `~/availability-intelligence-engine` | Jádro (Procurement/Availability) testované a hotové; frontend "Nexus" je vizuální shadow-test bez napojení na backend | Hexagonální ports/adapters, `ProcurementEngine.plan/receive`, idempotency claim/complete pattern |
| Shoptet integrace / GOLIÁŠ | `~/shoptet-variant-matrix`, `~/shoptet-cart-bypass-poc`, `~/Lay-Spa` | GOLIÁŠ produkčně nasazen (hecmania.cz); cart-bypass-poc je HMAC shipping calculator ve shadow mode | Cart-write adapter vzor (nativní API → DOM fallback), HMAC+nonce+rate-limit vzor |
| Omega účetní integrace | `~/omega-bridge` | 5-stage gate pipeline hotová, `OmegaExecutor` je simulace (mock) | Hash triáda (source/canonical/target payload), karanténní state machine, blind-retry fix |

## Opakující se vzorec napříč VŠEMI systémy (= základ NEXUS Core)

Potvrzeno nezávisle ve 3+ systémech, než jsme o tom vůbec začali mluvit v master promptu:
- **State machine s karanténním stavem** (Omega: `QUARANTINED`/`UNKNOWN`; Pricing: `rejected`/`rejectReason`; AIE: `PurchaseOrder` status enum)
- **5-stage/N-stage validace** (Pricing Engine `CORE_LOGIC_AND_VALIDATION.md`; Omega Gate 1-5; SafeOrder 5-stage pipeline)
- **Hash/audit trojice** (Omega source/canonical/target hash; Pricing audit log s requestId)
- **Idempotence claim/complete** (AIE `procurement_idempotency_keys`; Omega orchestrator blind-retry fix)
- **Reconciliation jako nezávislá vrstva, ne self-report** (Pricing Stage 5 `reconcile-*-drift.ts`; AIE `RetryAndReconciliation.ts`)

Toto NENÍ vynález master promptu — je to **extrakce vzorce, který už 3-4 nezávislí autoři objevili nezávisle**. NEXUS Core tohle jen sjednocuje do jedné implementace místo N kopií.

## Kritický nesoulad, který migrace musí řešit

**Žádný ze zdrojových systémů dnes nemá skutečný multi-tenant Canonical Model:**
- Pricing (okfish): `CustomerTier` je union type `"ZR4"|"ZR6"|...` — hardcoded na jednoho klienta, žádné `tenantId` (`src/core/interfaces.ts`)
- SafeOrder: má `tenant_id` v DB, ale ne jednu společnou `Product`/`Customer`/`Order` entitu sdílenou s ostatními systémy
- AIE: má `tenant_id` v migracích a `TenantConfig` interface, ale `InMemoryTenantSecretsManager` — netrvalé, per-instance

→ **Canonical Model (krok 3) musí vzniknout jako nová abstrakce, ne extrakce z jednoho zdroje.** Nejblíž realitě je AIE `tenant_id`-per-tabulka vzor + SafeOrder `tenant_policies`/`tenant_plans` model.

## Co v žádném zdrojovém systému dnes NEEXISTUJE (nová stavba, ne migrace)

- Billing/fakturace domain (ISDOC, číselné řady, VS, dobropisy) — 0 kódu nikde v portfoliu
- Campaign Engine + Creative Automation — 0 kódu nikde v portfoliu
- B2B nabídkový modul — 0 kódu nikde v portfoliu
- Marketing domain — 0 kódu nikde v portfoliu
- Jednotný Connector Layer (Shoptet V1 no-API + ERP generic) — existují jen fragmenty (GOLIÁŠ cart adapter, Omega CSV parser, AIE Shoptet read client), nikdy jako jedna abstrakce

Tyto domény jsou v `MIGRATION_PLAN.md` označené jako **NEW BUILD**, ne MIGRATE — bod 48 zakazuje "hádat chybějící business rules", takže se nepředstírá, že existuje něco, co neexistuje.
