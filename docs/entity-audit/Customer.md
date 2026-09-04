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

## DOPLNĚNÍ PO DALŠÍM PRŮCHODU: risk-graph persist vrstva

- `graph.ts`'s `evaluateContextualRisk()` je **čistá funkce** — nepřistupuje k DB, testy (`tests/unit/risk-graph.test.ts`) jsou tedy legitimně pure-unit, ne skryté mocky (na rozdíl od AIE PurchaseOrder, kde mock skrýval chybějící integraci).
- **DB perzistence `risk_graph_nodes` nalezena jen jako `DELETE FROM risk_graph_nodes WHERE tenant_id = ?`** v `onboarding-service.ts` (offboarding/reset flow). **Žádný `INSERT`/`UPDATE` nalezen v tomto průchodu prohledaných souborů** (`csv-importer.ts`, `validation/stages/4-risk-policy-validator.ts`).
- **TBD, ne uzavřeno**: buď (a) persist logika žije v souboru mimo dosud prohledané (repository vrstva SafeOrderu nebyla v tomto auditu mapována stejně důkladně jako AIE `PostgresProcurementRepository`), nebo (b) je to stejná třída mezery jako u AIE PurchaseOrder — vypočítaný graph node se nikde neuloží. **Nerozhoduji mezi (a)/(b) bez dalšího průchodu na SafeOrder repository vrstvu specificky.**
- Navíc: `GraphNodeType` v `graph.ts` (`'IDENTITY'|'ADDRESS_CLUSTER'|'PAYMENT_FINGERPRINT'|'ORDER'|'OUTCOME'`) **nesedí** s DB CHECK constraintem v migraci (`'IDENTITY'|'ADDRESS_CLUSTER'|'PAYMENT_FINGERPRINT'|'MERCHANT_CLUSTER'`) — stejný vzorec TS/DB nesouladu jako u AIE `PurchaseOrder.status`. Nutno ověřit, který je aktuální/zamýšlený.

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
