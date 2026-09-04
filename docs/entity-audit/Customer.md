# ENTITY: Customer

## SOURCE
- Pricing Engine (okfish): `ShoptetCustomer` (`cloudflare-worker/src/shoptet-api/client.ts`) — **jediný zdroj s trvalou, identifikovatelnou customer entitou** (guid)
- SafeOrder: `RawCustomerIdentity` (`src/core/types.ts`) — **efemérní PII payload, ne trvalá entita** + `risk_graph_nodes` (`migrations/0006`) — **graf uzlů, ne 1:1 customer záznam**
- AIE: žádná `Customer` entita — jen `CustomerOrderLine.customerOrderLineId` jako opaque cizí klíč, bez rozvinutí

## KLÍČOVÉ ZJIŠTĚNÍ: "Customer" znamená ve třech zdrojích TŘI NESLUČITELNÉ věci

1. **Pricing Engine pohled** — Customer = trvalá entita s `guid`, `customerGroup`, `priceList`, `accounts[].email`. Identita je 1:1 se Shoptet zákaznickým účtem. Tenhle pohled potřebuje Pricing/Billing/B2B domény (§10, §14, §29 zadání).

2. **SafeOrder pohled (checkout-time)** — `RawCustomerIdentity` je surová PII (phone/email/street/city/zip) přijatá PŘI KAŽDÉM checkoutu, okamžitě normalizovaná (`canonicalizePhone`, `canonicalizeEmail`, ...) a HMAC blind-tokenizovaná. **Neexistuje "SafeOrder customer record"** — je to vstup do výpočtu, ne uchovávaná entita.

3. **SafeOrder pohled (risk graph)** — `risk_graph_nodes` s `node_type IN ('IDENTITY','ADDRESS_CLUSTER','PAYMENT_FINGERPRINT','MERCHANT_CLUSTER')`. Jeden reálný člověk může mít VÍCE uzlů (jeden pro email/telefon identitu, jeden pro adresní cluster, jeden pro platební fingerprint) — graf mezi nimi (`risk_graph_edges`, zmíněné v `ARCHITECTURE_MAP.md`) modeluje VZTAHY mezi uzly (např. "tahle adresa je spojená se 3 různými emaily" = podezřelé). Tohle je **fundamentálně jiná datová struktura** než "jeden zákazník = jeden záznam".

## PROČ TOHLE MÁ VYSOKOU PRIORITU (Jan's řazení, potvrzeno nálezem)
Canonical `Customer` NENÍ jen "sjednotit tři podobné typy". Je to rozhodnutí, jak sladit:
- **Pricing potřebuje** identifikovatelnou, trvalou entitu s cenovou skupinou (Customer 1:1 s tier/priceList)
- **SafeOrder potřebuje** privacy-preserving, ne nutně 1:1 identitu (jeden člověk = potenciálně víc risk-graph uzlů, a naopak jeden blind token nemusí odpovídat jednomu Shoptet customer guid, pokud zákazník použije jiný email)
- **Tyto dva pohledy se musí PROPOJIT** (aby SafeOrder risk decision mohla vzít v potaz Customer.customerGroup/priceList pro ekonomický model, viz SafeOrder `decision-economics.ts` z předchozího auditu), ale nesmí se **sloučit do jednoho flat modelu**, jinak se ztratí privacy-preserving vlastnost SafeOrderu (Zero Raw PII v audit trail).

## TYPE
- `ShoptetCustomer.guid: string`, `customerGroup?: {id, name}`, `priceList?: {id, name}`, `accounts?: {email}[]`
- `RawCustomerIdentity`: `phone?`, `email?`, `street?`, `city?`, `zip?`, `country` (zod schema, validováno na vstupu)
- `GraphNode`: `id`, `tenantId`, `nodeType`, `blindToken`, agregační počítadla (`totalOrders`, `successfulDeliveries`, `rtoCount`, `returnCount`, `totalSpend`, `lastSeenAt`)

## PORT / CONTRACT
- Pricing Engine: žádný port — `ShoptetCustomer` se čte přímo přes `ShoptetApiClient.getCustomers()`, žádná abstrakce.
- SafeOrder: `identity.ts` normalizační funkce jsou čisté funkce, ne port/repository vzor — TBD ověřit, jestli existuje `IdentityPort`/`RiskGraphPort` abstrakce nebo je to přímé SQL v `risk-engine`.
- AIE: žádný port pro Customer — nepřekvapivé, protože žádná Customer entita neexistuje.

## WORKFLOW
- Pricing: žádný explicitní customer lifecycle — `customerGroup`/`priceList` se čte při syncu, promítá se do tier mapování (`customer-writer.ts` z Pricing Engine auditu).
- SafeOrder: `RawCustomerIdentity → normalize → blind token → graph node lookup/create → risk evaluation` — toto JE workflow, ale je to čistě computational pipeline, ne CRUD lifecycle jako u Order/PurchaseOrder.

## REPOSITORY / DB
- Pricing Engine: **žádná vlastní DB** pro Customer — čte se ze Shoptetu, cachuje se v KV (`customer:<hash>` klíč, viz dnešní `RemoteCustomerCache` audit).
- SafeOrder: `risk_graph_nodes` tabulka (potvrzeno výše), `risk_graph_edges` (nekontrolováno detailně v tomto průchodu — TBD).

## REAL RUNTIME VERIFICATION
| Vrstva | Stav |
|---|---|
| Pricing Engine `ShoptetCustomer` čtení | REAL DB TEST — ne, je to živé API čtení proti produkčnímu Shoptetu (ověřeno v jiných auditech, `getCustomers()` je produkčně používaná, ne testovaná proti mocku) — spíš **PRODUCTION-VERIFIED**, jiná kategorie než "testováno" |
| SafeOrder `canonicalizePhone`/`canonicalizeEmail` | TBD — nekontrolováno, jestli má unit testy |
| SafeOrder risk graph node CRUD | TBD — nekontrolováno v tomto průchodu, jestli testy mockují DB stejným způsobem jako u AIE PurchaseOrder (vysoké riziko podle vzorce, co jsme právě viděli) |

**NEDOKONČENO — potřeba další průchod na SafeOrder risk-graph vrstvu specificky, než can be `CANONICAL DECISION`.**

## OPEN QUESTIONS
1. Má Canonical `Customer` být 1:1 s Pricing `ShoptetCustomer.guid`, a SafeOrder risk graph nody jsou SAMOSTATNÁ, připojená struktura (ne totéž jako Customer)? Tohle je moje pracovní hypotéza, needituji ji jako rozhodnutí.
2. Jak se propojí `Customer.id` (Canonical) s `risk_graph_nodes.blind_token`, aniž by se porušila anonymizace, kterou SafeOrder garantuje (blind token je nevratná HMAC, nesmí se dát dekódovat zpět na Customer.id přímo v audit logu)?
3. `CustomerGroup` (Canonical, ze seznamu zadání) — je to totéž jako Shoptet `customerGroup`, nebo NEXUS koncept navíc?

## RiskGraphNode — Persistence (rozšířené hledání dokončeno)

| Oblast | Stav |
|---|---|
| `risk_graph_nodes` schema | EXISTS (`migrations/0006_risk_graph_and_outcomes.sql`) |
| DELETE/reset path | EXISTS (`onboarding-service.ts:162`, offboarding flow) |
| GraphNode creation/INSERT v `src/` | **EXISTS** — `csv-importer.ts:184`, `INSERT INTO risk_graph_nodes ... ON CONFLICT(tenant_id, blind_token) DO UPDATE SET total_orders = total_orders + 1, ...` (real upsert pattern) |
| Read path v `src/` | EXISTS — `validation/pipeline.ts:109`, `SELECT ... FROM risk_graph_nodes WHERE tenant_id = ? AND blind_token = ?` (Stage 4, live checkout evaluation čte graph node) |
| Repository/adapter abstrakce risk-graph | NOT FOUND — SQL je psané přímo v `csv-importer.ts`/`validation/pipeline.ts`, žádný pojmenovaný port/repository vzor (na rozdíl od AIE, kde `PostgresProcurementRepository` alespoň centralizuje SQL) |
| Alternativní Node/IdentityNode abstrakce | SEARCHED, NOT FOUND |
| Generic SQL write mimo `csv-importer.ts` | SEARCHED (`src/core/learning/outcome-engine.ts` — 0 výskytů `risk_graph`/`GraphNode`/`INSERT`/`UPDATE`), NOT FOUND |
| Write path mimo `src/` (scripts, packages, migrations, triggers) | SEARCHED — `packages/dashboard`, `packages/checkout-scripts`: 0 výskytů; DB triggery: 0 nalezeno; `run-okfish-orders-audit.ts` obsahuje jen in-memory mock DB pro backtest simulaci (`db.tables.risk_graph_nodes = []`), NENÍ produkční write path |
| Tests creating/persisting nodes | `tests/unit/risk-graph.test.ts` testuje jen čistou funkci `evaluateContextualRisk()` s ručně sestavenými `GraphNode` objekty — **NENÍ to persistence test**, nepoužívá DB vůbec |
| Runtime verification | NOT VERIFIED (žádný integrační test proti reálné DB nalezen) |

### ZJIŠTĚNÍ (opraveno z předchozí, příliš rychlé formulace)

**Write path EXISTUJE** — `csv-importer.ts` má funkční upsert do `risk_graph_nodes`. Moje dřívější tvrzení "stejná třída mezery jako AIE PurchaseOrder" bylo **předčasné a nesprávné** — write path tam skutečně je, jen jsem ho napoprvé nenašel kvůli úzkému hledání (hledal jsem pojmenovanou abstrakci `GraphNodePort`/`upsertNode`, která neexistuje — SQL je psané přímo inline).

**Ale je tu jiný, přesnější a stále platný nález**: upsert do `risk_graph_nodes` je volaný **jen z `csv-importer.ts`** — tedy z **historického/bulk CSV importu** (backtest/onboarding scénář). **V živém checkout evaluation flow (`validation/pipeline.ts`) se graph node jen ČTE (Stage 4), nikde jsem nenašel odpovídající zápis zpátky PO vyhodnocení nové objednávky** (prohledáno `src/core/learning/outcome-engine.ts` a celý `src/core` grep na `risk_graph`/`INSERT`/`UPDATE` mimo `csv-importer.ts` — nula výsledků).

**Přesná formulace nálezu**: Ne "CRITICAL ARCHITECTURAL GAP — DECLARED STORAGE WITHOUT IDENTIFIED WRITE PATH" (write path byl nalezen). Spíš: **"write path existuje pro bulk/historický import, ale nebyl nalezen odpovídající write path pro průběžnou aktualizaci grafu z živého provozu"** — pokud je to potvrzené, znamenalo by to, že risk graph node data zestárnou (nové RTO/úspěšné doručení se nikdy nepropíše zpátky do `total_orders`/`rto_count` po prvním CSV importu). Tohle je stále jen TBD, ne potvrzený bug — je možné, že live write-back se děje asynchronně jinde (např. cron/batch job přes Cloudflare Queue, mimo `src/core`), co jsem v tomto průchodu neprohledal.

**Navíc, samostatně**: `GraphNodeType` v `graph.ts` (`'IDENTITY'|'ADDRESS_CLUSTER'|'PAYMENT_FINGERPRINT'|'ORDER'|'OUTCOME'`) **nesedí** s DB CHECK constraintem v migraci (`'IDENTITY'|'ADDRESS_CLUSTER'|'PAYMENT_FINGERPRINT'|'MERCHANT_CLUSTER'`) — stejný vzorec TS/DB nesouladu jako u AIE `PurchaseOrder.status`. `csv-importer.ts` samo píše natvrdo `'IDENTITY'` do `node_type`, takže tenhle konkrétní nesoulad dnes nezpůsobuje runtime chybu (protože se nikdy nezapisuje `ADDRESS_CLUSTER`/`PAYMENT_FINGERPRINT`/`ORDER`/`OUTCOME` hodnota) — ale je to further evidence stejného vzorce neudržovaných typů napříč TS/DB.

### DALŠÍ DŮKAZNÍ KROK — DOPLNĚNO
- `src/queue/` a `worker.ts` existují a byly prohledány — **0 výskytů `risk_graph_nodes`/`GraphNode` v žádném z nich**. Žádný queue/worker/cron write-back nalezen.
- **Závěr, ne TBD**: v celém `~/safeorder-3.0` repu (src, tests, packages, migrations, scripts) existuje přesně **jeden** write path do `risk_graph_nodes` (`csv-importer.ts`, bulk/historický import), a **žádný** identifikovaný write path pro průběžnou aktualizaci z živého checkout provozu. Live evaluace graph node čte, ale výsledek objednávky (úspěšné doručení/RTO) se nikam nezapisuje zpátky.
- Tohle JE reálný nález k řešení v Nexus Risk Graph modulu — ne kritická architektonická díra (schema bez write path vůbec), ale **chybějící smyčka zpětné vazby** (write-once-at-import, read-forever, never-updated-by-live-outcomes). Ekonomicky relevantní: risk graph by se bez tohoto zpětného zápisu nikdy nezlepšoval/nezhoršoval podle skutečného provozu po prvním importu.

## ENTITY BOUNDARY (klíčové architektonické rozhodnutí — Jan)

**Customer ≠ RiskIdentity ≠ RiskGraphNode.** Tři oddělené, propojitelné, ale nesměnitelné koncepty:

```
Customer                          -- commerce entity
   │ (reference / correlation, NE ownership)
   ▼
RiskIdentity                      -- SafeOrder identita, nemusí být 1:1 s Customer,
   │                                 existuje i pro guest checkout
   ▼
RiskGraph
   ├── RiskGraphNode              -- IDENTITY | ADDRESS_CLUSTER | PAYMENT_FINGERPRINT | ...
   └── RiskGraphEdge              -- vztahy mezi uzly (např. dva různí Customer, stejná adresa)
```

1. **Commerce Customer** — účet, email, jméno, fakturační/dodací údaje, `customerGroup`, `priceList`, historie objednávek, externí identity platformy, tenant scope. Odpovídá `ShoptetCustomer` pohledu.
2. **Risk Identity** — SafeOrder identita pro risk rozhodování. NEMUSÍ být 1:1 s Customer (guest checkout nemá Customer záznam vůbec, ale má Risk Identity).
3. **Risk Graph Node/Edge** — grafová struktura, ne customer reprezentace. Edge mezi uzly odhaluje vztahy (dva různé Customer účty, stejná adresa = signál, ne vlastnost jednoho Customera).

**Důsledek**: Canonical Model NESMÍ modelovat `Customer.riskGraphNode` jako vlastnost/podmodel Customer entity. `Customer` je jedna commerce entita v `core/canonical/`; `RiskIdentity`/`RiskGraphNode`/`RiskGraphEdge` patří do `domains/safeorder/` jako vlastní model s volitelnou referencí na `Customer.id` (ne naopak).

**Customer NENÍ primární identita celého Nexusu** — je to jedna z několika identitních projekcí (commerce, risk, případně budoucí marketing/loyalty identity), ne kořen, ze kterého se všechno odvozuje.

## STATUS
Customer audit dokončen v rozsahu TYPE→PORT→WORKFLOW→REPOSITORY→DB→ENTITY BOUNDARY. Risk-graph persist vrstva zůstává TBD (viz výše) — nezahrnuto do CANONICAL DECISION, protože to není blokující pro entity boundary rozhodnutí samotné.
