# CANONICAL MODEL — SYNTHESIS

Destilace 8 entity-by-entity auditů (`docs/entity-audit/*.md`) do jedné konzistentní mapy reality Nexusu. Toto NENÍ implementace — je to kontrakt, ze kterého se `core/canonical/` má napsat.

---

## 1. Entity Taxonomy — tři kategorie, ne jeden plochý seznam

| Kategorie | Definice | Příklady z auditu |
|---|---|---|
| **ENTITY** | vlastní identita, lifecycle, perzistovaný stav | Customer, Product, Order, PurchaseOrder, Supplier, RiskGraphNode |
| **RULE** | logika, která vypočítává/rozhoduje, NENÍ perzistovaná se svým vlastním ID | Promotion (ClearanceEntry), DiscountLimitPolicy, RiskDecision logika |
| **PROJECTION** | odvozený pohled na jinou entitu/systém, přepočítávaný, ne uložený stav | inStock, AvailabilityStatus, ShoptetOrder.status→canonicalStatus mapping |

Původní plochý seznam z master promptu (§4) mísí všechny tři kategorie do jedné `types.ts` — to byl přesně ten mechanický přístup, který audit rozbil.

---

## 2. Cross-Entity Source-of-Truth Matrix

| Concept | Source of Truth | Canonical Role | Derived? | External? | Reconciled? |
|---|---|---|---|---|---|
| Order identity | Shoptet (`code`/`guid`) | Entity (external mirror) | No | Yes | Yes (Stage 5 pattern applicable, not built) |
| Order.status | Shoptet (dynamic per-shop enum) | External State | No | Yes | TBD |
| Order.canonicalStatus | **NEEXISTUJE, musí se navrhnout** | Canonical State (mapping target) | Yes (od externalStatus) | No | TBD |
| PurchaseOrder identity | Nexus (AIE) | Entity | No | No | Partial (orphan/duplicate detection existuje) |
| PurchaseOrder.status | AIE DB (nekonzistentní s TS) | Entity lifecycle — **CONFLICTED** | Partially (RECEIVED je computed, never written) | No | No (confirmed bug) |
| Invoice (celá entita) | **NEEXISTUJE** | N/A | — | — | — |
| Customer (commerce) | Shoptet (`ShoptetCustomer.guid`) | Entity | No | Yes | TBD |
| RiskIdentity | SafeOrder (blind token) | Entity, nezávislá na Customer | No | No (interní SafeOrder) | Partial |
| RiskGraphNode | SafeOrder DB | Risk entity, NENÍ Customer | No | No | **No — confirmed missing feedback loop** |
| Product (fragmented) | fragmentováno (Shoptet+Pricing+Availability+Procurement) | Entity, composed | No | Yes (z většiny) | No |
| Product.purchasePrice | Shoptet `buyPrice` | Source fact | No | Yes | No |
| SupplierOffer.unitPrice | Procurement (dodavatel) | Source fact — **CONFLICTS s Product.purchasePrice** | No | Partially | No |
| Stock.quantity | Shoptet (`v.stock`) | Source fact | No | Yes | No (žádná perzistence snapshotu) |
| Stock.inStock | `quantity > 0` | Derived | Yes | No | N/A |
| AvailabilityStatus | AvailabilityEngine výpočet | Projection | Yes | No | N/A (nikdy neperzistováno) |
| PriceList | Pricing Engine (`TIER_PRICELIST_MAP`, hardcoded) | Entity — **hardcoded, ne tenant config** | No | Partially | N/A |
| Price (computed) | Pricing Engine `PricingResult` | Decision/output | Yes | No | Yes (nejsilnější reconciliation v celém portfoliu) |
| Price (persisted) | Shoptet `price.price` po write-back | Executed state | No | Yes | Yes |
| QuantityTier | **NEEXISTUJE** | N/A | — | — | — |
| Promotion | Pricing Engine `ClearanceEntry` (JSON config) | Rule, ne entity | No | No (Nexus-owned config) | Yes (jediný plně reconciled případ) |
| PromoGroup/Campaign/Placement/Creative | **NEEXISTUJE** | N/A | — | — | — |

---

## 3. External vs. Canonical Identity — kritické rozlišení nalezené 3×

Vzorec opakovaný u Order, Product, a implicitně Customer: **externí identifikátor (Shoptet code/guid) ≠ Nexus canonical ID**. Dnes žádný systém tohle rozlišení nedělá explicitně — `sku`/`code` se používá zaměnitelně jako "ta jediná identita", což je bezpečné jen dokud je Shoptet jediný connector. Multi-connector budoucnost (Shopify, ERP) tohle rozbije, pokud se identita nerozdělí na `canonicalId` (Nexus-generated) + `externalIdentities[]` (per-connector mapování) od začátku.

---

## 4. External vs. Canonical State — nejdůležitější nález celé synthesis

Potvrzeno nezávisle u Order (Shoptet status), Stock (inStock/AvailabilityStatus), Campaign (status=ACTIVE varování): **žádný systém dnes nerozlišuje "co externí systém říká" od "co Nexus interpretuje"**. Order.status je toho nejčistší příklad — Shoptet status je dynamický per-shop enum, canonicalStatus musí být nezávisle navržený, NE odvozený z toho, co Shoptet náhodou má.

**Toto je jedno z 2-3 nejdůležitějších architektonických pravidel vzešlých z celého auditu.**

---

## 5. Derived Values — musí zůstat oddělené od source fields

| Derived value | Zdrojová fakta | Kde se počítá |
|---|---|---|
| `inStock` | `stock > 0` | Normalizer (AIE) |
| `AvailabilityStatus` (IN_STOCK/LOW_STOCK/...) | `stock`, `purchasable`, `canPreorder`, `inTransit` — 4 nezávislá fakta | `AvailabilityEngine.evaluate()`, hardcoded threshold=3 |
| `PricingResult.finalPrice` | `PricingInput` + policy chain | `PricingEngine.calculatePrice()` |
| `resolveClearancePct()` výsledek | `ClearanceEntry.{pct, validFrom, validTo}` + `now` | Vyhodnoceno při každém price calc, ne uloženo |

Pravidlo (z Jan's oprav u Stock): **derived value nikdy nesmí nahradit/skrýt zdrojová fakta** — kombinace `quantity=0 + canPreorder=true + inTransit=true + purchasable=true` je validní a informačně bohatší než jeden enum.

---

## 6. Rules vs. Entities — potvrzeno u Promotion, platí obecně

Test, jestli je něco Entity nebo Rule: **má vlastní ID a lifecycle nezávislý na tom, co vypočítává?**
- Promotion (ClearanceEntry): NE → Rule.
- DiscountLimitPolicy, HighestDiscountPolicy: NE → Rule.
- RiskDecision: MÁ vlastní ID a je perzistovaný výsledek → Entity (ale je to výstup Rule evaluace, ne subjekt vlastní mutace).

---

## 7. Relationships — nově zjištěné, nestandardní vazby

- `Product.purchasePrice` **NENÍ** totéž jako `SupplierOffer.unitPrice`, přestože obě znamenají "nákupní cena" — jsou to dva různé koncepty s různým zdrojem pravdy a různou aktuálností.
- `Customer` **NENÍ** rodič `RiskIdentity`/`RiskGraphNode` — je to volitelná reference, ne ownership. Guest checkout má RiskIdentity bez Customer.
- `PurchaseOrder.status` **NENÍ** jedno pole — je to minimálně 2 nezávislé osy (interní lifecycle + supplier echo `ACCEPTED`/`SHIPPED`), dnes chybně sloučené do jednoho DB sloupce.

---

## 8. Lifecycle Patterns — REFERENCE PATTERN: Nexus Decision Lifecycle

Jediné místo v celém portfoliu s kompletním 5-vrstvým lifecycle (Promotion/ClearanceEntry):

```
SOURCE → DERIVED → DECISION → EXECUTED → RECONCILED
```

Porovnání proti ostatním auditovaným entitám:

| Entita | SOURCE | DERIVED | DECISION | EXECUTED | RECONCILED |
|---|---|---|---|---|---|
| **Promotion** (referenční) | ✓ ClearanceEntry | ✓ resolveClearancePct | ✓ calculateAllTierPrices | ✓ PricelistWriter | ✓ Stage 5 |
| Price (obecně) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Stock/Availability | ✓ (4 fakta) | ✓ AvailabilityStatus | — chybí decision vrstva | — nikdy se nezapisuje | ✗ nikdy neperzistováno |
| PurchaseOrder receiving | — | ✓ (in-memory computed) | ✓ ProcurementEngine.receive() | **✗ CHYBÍ — nezapisuje se do DB** | částečně (orphan detection) |
| Order | ✓ Shoptet | — chybí canonicalStatus | — | — (read-only zrcadlo) | — |
| RiskGraphNode | ✓ (bulk import) | — | ✓ evaluateContextualRisk | ✓ (jen bulk import) | **✗ chybí live feedback loop** |
| Campaign | — | — | — | — | — (nic neexistuje) |

**Vzorec**: lifecycle se rozpadá nejčastěji na přechodu DECISION→EXECUTED (vypočítáno, ale nezapsáno — PurchaseOrder, RiskGraphNode) nebo chybí od začátku (Order canonicalStatus, celá Campaign doména).

---

## 9. Confirmed Conflicts (ne TBD — reálně doloženo kódem)

1. **PurchaseOrder.status** — TS union širší než DB CHECK; `updateStatus()` píše `ACCEPTED`/`SHIPPED` do stejného sloupce jako lifecycle.
2. **Product.purchasePrice vs. SupplierOffer.unitPrice** — riziko kruhové závislosti stejného tvaru jako již vyřešené INC-011.
3. **RiskGraphNode.node_type** — TS enum (`ORDER`,`OUTCOME`) neshoduje se s DB CHECK (`MERCHANT_CLUSTER`).
4. **Hardcoded multi-tenant porušení** — `TIER_PRICELIST_MAP`, `LOW_STOCK_THRESHOLD=3` — obojí by mělo být tenant config, dnes je to kód.

## 10. Confirmed Gaps (potvrzené chybějící write-back, ne teoretické)

1. **PurchaseOrder RECEIVED/PARTIALLY_RECEIVED** se počítá správně, nikdy nezapisuje do DB.
2. **RiskGraphNode** se aktualizuje jen z bulk CSV importu, live checkout evaluace nikdy nezapisuje výsledek zpátky.
3. **Stock/Availability** se nikdy nikde nepersistuje — vždy compute-on-read, žádný historický snapshot k reconciliaci.

## 11. TBD / Unresolved Questions (nerozhodnuto, ne domyšleno)

- Je Variant povinná vrstva vždy, nebo opt-in?
- Kam patří discount limits — vlastnost Product, nebo samostatná Rule/RuleVersion entita?
- Odkud přesně `CustomerOrderLine.ownStockQuantity` — je to totéž jako Shoptet `stock`?
- Má PriceList zůstat 1:1 s loyalty tier, nebo nezávislá dimenze (B2B)?

## 12. Migration Candidates (existující kód, přenositelný s úpravou)

- Pricing Engine core (`PricingEngine`, policy chain) — Fáze 1, nejzralejší.
- SafeOrder risk-engine/calibration — Fáze 2, ale s opravou feedback loop mezery.
- AIE ProcurementEngine/AvailabilityEngine — Fáze 3, s opravou write-back mezer.
- GOLIÁŠ cart-write adapter vzor — Connector Layer V1.
- Omega hash triáda + gate pipeline — referenční vzor pro `core/audit`/`core/reconciliation`.

## 13. New-Build Candidates (nula legacy kódu, potvrzeno auditem)

Invoice, Warehouse, QuantityTier, PromoGroup, Campaign, CampaignPlacement, Creative, celá Billing/Marketing/B2B doména.

---

## Otevřený závěr

Osm auditů potvrzuje: **Canonical Model nemá být databázový model — je to kontrakt reality Nexusu**, se třemi vrstvami (Entities/Rules/States), explicitním rozlišením external-vs-canonical na identitě i stavu, a referenčním Decision Lifecycle vzorem (Promotion), který se má vědomě replikovat tam, kde dnes chybí — ne vynucovat mechanicky na entity, kde nedává smysl (Campaign nemá být "Order s jiným jménem").

Další krok (mimo tento dokument, k rozhodnutí s Janem): návrh `core/canonical/` struktury, která tuhle synthesis odráží — tj. oddělené `entities/`, `rules/`, `states/` moduly, ne jeden plochý `types.ts`.
