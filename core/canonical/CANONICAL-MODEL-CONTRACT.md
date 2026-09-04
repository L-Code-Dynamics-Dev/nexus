# CANONICAL MODEL CONTRACT

Toto NENÍ types.ts. Je to smlouva, kterou `entities/`, `rules/`, `states/`, `projections/` musí dodržet, až se začnou psát. Odvozeno z `docs/CANONICAL_MODEL_SYNTHESIS.md` (9 auditů).

---

## 1. Entity Taxonomy

**Test**: má vlastní identitu (ID nezávislé na výpočtu) a lifecycle (přechází mezi stavy v čase)?

- **ENTITY** — ano na obojí. Customer, Product, Order, PurchaseOrder, Supplier, RiskGraphNode.
- **RULE** — vypočítává/rozhoduje, ID je odvozené od subjektu (product code), ne vlastní. Promotion, DiscountLimitPolicy, PricingRule, RiskRule.
- **DECISION** — výsledek Rule evaluace, NENÍ Rule samotné. `RiskDecision`, `PricingResult`. Má vlastní ID a je perzistovaný výstup, ale nevzniká mutací — vzniká z `RiskRule → RiskEvaluation → RiskDecision → Action → Outcome`.
- **PROJECTION** — čistě odvozený pohled, přepočítávaný, NIKDY vlastní perzistovaný stav. inStock, AvailabilityStatus. Přestává být Projection ve chvíli, kdy se stane perzistovaným Canonical State (viz §4 — canonicalStatus, jednou zapsaný, je STATE entity, ne Projection).
- **STATE** — hodnota v čase, patřící entitě, ale sama netvoří vlastní identitu. External/Canonical/Derived/Execution/Reconciled.

Žádný modul nesmí definovat Entity tam, kde audit potvrdil Rule nebo Projection (viz Synthesis §1, §6).

## 2. Rule Taxonomy

Rule MUSÍ mít (referenční vzor: Promotion/ClearanceEntry, jediný plně ověřený):
```
input → source → derived → decision → execution → reconciliation → outcome
```
Rule NESMÍ mít vlastní CRUD lifecycle — jestli něco potřebuje `create`/`update`/`delete` s auditní stopou nezávislou na vstupu, je to Entity, ne Rule (viz PromoGroup diskuse — pokud PromoGroup potřebuje vlastní správu, přestává být čistý Rule).

## 3. Projection Taxonomy

Projection MUSÍ:
- být čistá funkce zdrojových faktů (žádný vlastní stav)
- nikdy skrývat zdrojová fakta, na kterých je založená (viz Stock: `quantity=0 + canPreorder=true + inTransit=true` — Projection nesmí tohle zredukovat na jeden flat status bez možnosti se vrátit k faktům)
- být volně přepočitatelná — pokud se pravidlo výpočtu změní, historická data se NEMUSÍ migrovat (protože Projection nikdy nebyla source of truth)

## 4. State Taxonomy — nejsilnější cross-entity princip ze Synthesis

```
External State        -- co říká externí systém (Shoptet status.id, Shoptet stock)
      ↓ mapping (config, per tenant/connector, NIKDY hardcoded)
Canonical State        -- Nexus interpretace, NAVRŽENÁ nezávisle, ne odvozená přejmenováním
      ↓ decision (Rule evaluace)
Decision               -- výstup Rule (RiskDecision, PricingResult)
      ↓ execution
Expected Execution State -- co by mělo nastat po zápisu
      ↓
Actual External State   -- co externí systém skutečně má PO zápisu
      ↓ reconciliation
Reconciliation           -- porovnání Expected vs Actual, DIFF, resolution
      ↓
Outcome                  -- uzavřený zápis do outcome-learning smyčky (SafeOrder/Pricing
                             vzor), vstup pro budoucí Decision evaluace
```

**Tvrdé pravidlo** (Synthesis §4): Canonical State se NESMÍ vytvořit pouhým přejmenováním External State. Order.canonicalStatus je navrhovaný nezávisle na Shoptet status.id/name, i když se to zdá pohodlnější zkratka.

## 5. Entity Contract — společná kostra, ne společný interface

Každá Entity musí mít definováno (ne každá musí mít VYPLNĚNO vše — např. Order nemá "Version" ve smyslu mutable verzování, protože je read-only zrcadlo):

| Prvek | Povinné pro | Poznámka |
|---|---|---|
| Identity (canonicalId) | všechny | musí být Nexus-generated, NE totéž jako external identity |
| Tenant scope | všechny | `assertTenantOwnership()` (core/tenant/) na každou mutaci |
| Source references | entity s external mirror (Order, Product, Customer) | `externalIdentities: {connectorType, externalId}[]` |
| Business data | všechny | |
| Relationships | všechny | explicitně typované, NE string FK bez kontraktu (viz `customerOrderLineId`-style volné odkazy, co ztěžují audit) |
| Lifecycle | entity s reálným lifecycle (Order, PurchaseOrder) | State Taxonomy vrstva výše, NE jeden `status: string` |
| Invariants | entity, kde jsou potvrzené (PurchaseOrder receivedQty ≤ orderedQty) | zapsat explicitně, ne implicitně v kódu |
| Source of truth | všechny | musí odpovědět "kdo smí tohle pole zapsat" |
| Version | entity s mutovatelným obsahem přes čas | NE pro read-only zrcadla |
| Audit contract | všechny mutace | kdo/kdy/staré/nové/proč |
| Reconciliation contract | entity, kde Expected≠Actual je možné | Order, PurchaseOrder, RiskGraphNode (dnes chybí), Stock (dnes chybí) |

## 6. Confirmed Conflicts, k řešení PŘED psaním entities/*.ts

1. `PurchaseOrder.status` — musí se rozdělit na nezávislé osy (lifecycle / cancellationState / supplierEcho), ne jeden sloupec.
2. `Product.purchasePrice` vs `SupplierOffer.unitPrice` — musí zůstat DVĚ pole, nikdy sloučená.
3. Multi-tenant hardcoded konstanty (`TIER_PRICELIST_MAP`, `LOW_STOCK_THRESHOLD`) — musí se stát tenant config, ne kód, při migraci.

## 7. Confirmed Gaps, k řešení jako součást core/state-machine + core/reconciliation (ne ignorovat)

1. PurchaseOrder RECEIVED/PARTIALLY_RECEIVED — Decision vrstva existuje, Execution chybí (nikdy se nezapíše).
2. RiskGraphNode — Execution existuje jen pro bulk import, chybí pro live feedback loop.
3. Stock/Availability — Projection existuje, ale nikdy se neperzistuje → Reconciliation nemá s čím porovnávat historicky.

## 8. Validation Boundary — POZOR na pořadí

Validation Framework (5-stage: INPUT→PARSER→CORE→OUTPUT→POST/OUTCOME) se NAVRHUJE AŽ PO tomto kontraktu, ne před ním. Framework chrání to, co tady definujeme — nedefinuje to sám. (Viz Jan's bod 6: "Validation Framework nesmí definovat Canonical Model.")

## 9. New-Build vs Migration — explicitní seznam (ze Synthesis §12-13)

**Migration** (existující, ověřený kód k přenosu): Pricing Engine core, SafeOrder risk-engine/calibration (s oprava feedback loop), AIE ProcurementEngine/AvailabilityEngine (s oprava write-back), GOLIÁŠ connector vzor, Omega hash triáda.

**New-Build** (nula legacy kódu, potvrzeno): Invoice, Warehouse, PromoGroup, Campaign, CampaignPlacement, Creative, Billing/Marketing/B2B domény, Order.canonicalStatus (samo o sobě).

**QuantityTier = NEW BUILD / TBD** (forenzně dohledáno, ne domněnka). Quantity discount calculation NENÍ přítomen v legacy Pricing Engine. Quantity-related pole se jen přenášejí z master feed do Shoptet XML, kde skutečné slevové chování vykonává nativní Shoptet quantity-discount funkce:
```
minimumAmount / maximumAmount / applyQuantityDiscount / applyVolumeDiscount
        │
        ▼  Source / Product data (master feed CSV)
        │
        ▼  Projection / Connector mapping (feed-generator.ts, 1:1 přepis)
        │
        ▼  Shoptet native execution (quantityDiscount* schémata v shoptet_openapi.json)
     QuantityTier
```
Pricing Engine tato pole nepočítá, nevyhodnocuje, nevybírá tier, nepočítá výslednou cenu, nečte zpět, nerozhoduje o nároku — je to čistě transportní/projekční vrstva pro tuto Shoptet funkci. **Nexus nesmí předstírat, že přebírá logiku, která v Pricing Engine nikdy neexistovala.** Pokud NEXUS bude chtít vlastní quantity pricing (nezávislý na nativní Shoptet funkci, potřebný např. pro Shopify), je to nová business capability, ne migrace. Detail: `docs/entity-audit/Price-PriceList-QuantityTier.md`, sekce "FORENZNÍ DOŘEŠENÍ".

## 10. Explicit TBDs (nerozhodnuto, čeká na další audit nebo rozhodnutí)

- Variant: povinná vrstva vždy, nebo opt-in?
- Discount limits: vlastnost Product, nebo samostatná Rule/RuleVersion?
- `CustomerOrderLine.ownStockQuantity` zdroj — totéž jako Shoptet `stock`?
- PriceList: 1:1 loyalty tier navždy, nebo nezávislá B2B dimenze?
- ~~QuantityTier: dohledat...~~ **VYŘEŠENO** — New-Build, potvrzeno (viz §9 výše).
- PromoGroup: čistý Rule, nebo potřebuje vlastní Entity lifecycle?

---

**Než se napíše první `entities/*.ts`**: potvrdit s Janem, že tento kontrakt (taxonomie, state model, entity kostra) je schválený jako závazný — psaní kódu proti nepotvrzenému kontraktu by zopakovalo přesně to riziko, které celý tento audit měl předejít.
