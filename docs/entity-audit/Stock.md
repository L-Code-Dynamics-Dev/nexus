# ENTITY: Stock

## SOURCE
- Shoptet API: `apiProduct.variants[].{stock, purchasable, canPreorder, inTransit}` (čteno přes `apiNormalizer.ts`)
- Shoptet CSV export: `exportProduct.ParsedVariants[].{Stock, Purchasable, OnOrder, InTransit}` (stejná 4 pole, jiná serializace — `exportNormalizer.ts`)
- AIE Availability: `VariantAvailability` (`inStock`, `stockAmount`, `onOrder`, `inTransit`) + `AvailabilityStatus` enum (odvozená klasifikace, NE zdroj)
- AIE Procurement: `CustomerOrderLine.ownStockQuantity` (JINÉ pojmenování/kontext), `Allocation.allocatedQuantity` (ČTVRTÝ, nezávislý koncept)
- Pricing Engine: **žádný stock koncept** — `ShoptetPricelistItem` má jen `negativeStockAllowed`/stockout-behavior nastavení (co dělat PŘI nule skladem), ne samotné množství

## KRITICKÉ ZJIŠTĚNÍ Č. 1: quantity ≠ available stock — potvrzeno, NE 1:1

Skutečná zdrojová pole ze Shoptetu (obě normalizer varianty čtou identickou sadu):
```
stock: number          -- surové množství skladem
purchasable: boolean   -- lze objednat (nezávislé na stock > 0! může být false i při stock > 0)
canPreorder: boolean   -- (API) / OnOrder (CSV) -- lze předobjednat
inTransit: boolean     -- je na cestě
```

**`inStock` NENÍ surové pole ze Shoptetu — je to odvozený boolean uvnitř normalizeru** (`inStock: v.stock > 0`), ne přímo z API. `AvailabilityStatus` (IN_STOCK/LOW_STOCK/PARTIALLY_AVAILABLE/IN_TRANSIT/ON_ORDER/OUT_OF_STOCK/UNKNOWN) je DRUHÁ vrstva odvození, počítaná `AvailabilityEngine.evaluate()` z těchto čtyř polí přes variant-level agregaci (viz níže) — je to klasifikace, ne zdroj.

## KRITICKÉ ZJIŠTĚNÍ Č. 2: Shoptet nemá ON_HAND/RESERVED/AVAILABLE/ALLOCATED/BACKORDERED rozlišení

Žádné z těchto pojmů (na které jsi se ptal explicitně) neexistuje jako pole ze Shoptetu. Shoptet vystavuje jen syrové `stock` číslo — **nerozlišuje kolik je fyzicky na skladě vs. kolik je rezervováno pro nevyřízené objednávky**. To je zásadní mezera, pokud NEXUS potřebuje "kolik je REÁLNĚ k dispozici k prodeji" (available = on_hand - reserved) — tahle informace se dnes ze Shoptetu vůbec nedostane, musí se počítat NEXUS-side.

**`allocatedQuantity`** (AIE Procurement, `Allocation` typ) JE nejblíž konceptu "reserved" — ale je to počítáno až PO přijetí zboží od dodavatele (`ProcurementEngine.receive()`), ne jako průběžná rezervace při vytvoření objednávky. Je to jiná časová fáze než "reserved stock at order time".

## KRITICKÉ ZJIŠTĚNÍ Č. 3: AvailabilityStatus klasifikační logika je variant-úrovňová agregace, ne přímý odraz jednoho čísla

`AvailabilityEngine.evaluate()` (viz kód):
1. Pro KAŽDOU variantu produktu klasifikuje: `!isPurchasable → OUT_OF_STOCK`; `inStock && stockAmount <= 3 → LOW_STOCK (per-variant)`; `inStock && stockAmount > 3 → IN_STOCK (per-variant)`; `inTransit → IN_TRANSIT`; `onOrder → ON_ORDER`; jinak `OUT_OF_STOCK`.
2. Pak agreguje NAPŘÍČ variantami na produkt-level status (všechny in-stock → IN_STOCK; mix in-stock/low-stock → LOW_STOCK; atd. — přesná pravidla viz kód, řádky 60+, nekompletně prohlédnuto v tomto průchodu).
3. `LOW_STOCK_THRESHOLD = 3` je hardcoded konstanta (`AvailabilityEngine.ts`), NE tenant-scoped konfigurace — to porušuje multi-tenant princip (§5 zadání), pokud různí klienti chtějí jiný threshold.

**→ `IN_STOCK`/`LOW_STOCK`/`OUT_OF_STOCK`/`IN_TRANSIT` JSOU skutečné odvozené klasifikace, ne přímé stavy uložené kdekoli.** Nejsou to "stavy" v smyslu state machine (nemají transitions/lifecycle) — jsou to výsledky opakovaného přepočtu při každém volání `evaluate()`.

## STOCK DIAGRAM (dle Jan's struktury, ověřeno)

```
SOURCE STOCK (Shoptet: stock, purchasable, canPreorder/onOrder, inTransit)
      ↓
[normalizer: apiNormalizer.ts / exportNormalizer.ts -- 1:1 přepis, žádná byznys logika]
      ↓
VariantAvailability (stejná 4 pole, jen typované)
      ↓
[AvailabilityEngine.evaluate() -- per-variant klasifikace, pak produkt-level agregace,
 hardcoded LOW_STOCK_THRESHOLD=3]
      ↓
AvailabilityStatus (IN_STOCK/LOW_STOCK/.../UNKNOWN) -- ODVOZENÁ KLASIFIKACE, přepočítávaná,
                                                        ne perzistovaný stav
      ↓
[TBD -- kde se AvailabilityResult ukládá? Není nalezena DB tabulka pro Stock/Availability
 v žádné migraci -- na rozdíl od Procurement, které MÁ vlastní schema]
      ↓
PROCUREMENT DECISION (ProcurementEngine.plan() čte CustomerOrderLine.ownStockQuantity,
                       JINÉ pole, nepropojené s AvailabilityResult explicitně nalezeným kódem)
      ↓
Allocation.allocatedQuantity (počítáno až při receive(), čtvrtý nezávislý koncept)
      ↓
EXPECTED STATE vs ACTUAL STOCK -- RECONCILIATION: NENALEZENO nikde v kódu pro Stock/
                                    Availability doménu (na rozdíl od Pricing Stage 5,
                                    které Stock reconciliation nemá ekvivalent)
```

## TYPE → PORT → WORKFLOW → REPOSITORY → DB
- **AIE Availability**: ŽÁDNÁ DB vrstva nalezena. `AvailabilityEngine.evaluate()` je čistá, stateless funkce. Žádná migrace pro "stock"/"availability" tabulku existuje (`migrations/001_procurement_core.sql`, `002_sales_units.sql` — ani jedna neobsahuje stock/availability schema).
- **AIE Procurement**: `CustomerOrderLine.ownStockQuantity` je vstupní pole (odkud přesně přichází při vytvoření `CustomerOrderLine`? — TBD, nenalezeno v tomto průchodu, pravděpodobně ze Shoptet importu, ale přesný write path neověřen).
- **Pricing Engine**: nulová relevance — negativeStockAllowed je Shoptet konfigurace pro zobrazení, ne stock tracking.

## REAL RUNTIME VERIFICATION
| Vrstva | Stav |
|---|---|
| `AvailabilityEngine.evaluate()` | MOCK ONLY / PURE FUNCTION TEST — `AvailabilityEngine.test.ts`, žádná DB, žádný live Shoptet call v testu |
| `apiNormalizer.ts`/`exportNormalizer.ts` | TBD — nekontrolováno, jestli má testy proti reálným Shoptet response fixtures |
| Perzistence Stock/Availability stavu | NOT FOUND — žádná DB tabulka, žádný repository. Je to čistě "compute on read", nikdy uloženo |

## SOURCE-OF-TRUTH MATRIX

| Údaj | Shoptet | Availability | Procurement | Canonical (návrh) |
|---|---|---|---|---|
| Surové `stock` množství | ✓ (jediný zdroj) | čte přes normalizer | — | **Shoptet** |
| `purchasable` flag | ✓ | čte přes normalizer | — | **Shoptet** |
| `inTransit`/`onOrder` | ✓ | čte přes normalizer | — | **Shoptet** |
| `inStock` (boolean) | ✗ (odvozeno) | odvozeno (`stock > 0`) | — | **Availability** (odvozená, ne zdroj) |
| `AvailabilityStatus` klasifikace | ✗ | ✓ (vypočítává) | — | **Availability**, přepočítávaná, ne perzistovaná |
| `ownStockQuantity` (Procurement) | TBD zdroj | — | ✓ (vstupní pole) | **TBD — nejasný vztah k Shoptet `stock`** |
| `allocatedQuantity` | ✗ | ✗ | ✓ (počítáno při receive) | **Procurement**, nezávislý na Availability |
| "Reserved"/"Available po odečtení rezervací" | ✗ NEEXISTUJE | ✗ NEEXISTUJE | částečně (`allocatedQuantity`, ale jiná fáze) | **NENÍ implementováno nikde — nová práce pro Nexus** |

## ENTITY BOUNDARY (návrh k diskusi)

```
StockSourceSnapshot          -- syrová data ze Shoptetu (stock/purchasable/inTransit/onOrder),
                                 per variant, s timestampem -- Shoptet je zdroj pravdy
      │
      ▼
AvailabilityClassification    -- ODVOZENÁ, přepočítávaná (ne perzistovaný stav), tenant-scoped
                                  threshold (NE hardcoded 3), výstup: IN_STOCK/LOW_STOCK/...
      │
      ▼ (spotřebovává Procurement)
ProcurementStockView          -- CustomerOrderLine.ownStockQuantity -- TBD přesný vztah
                                  k StockSourceSnapshot, dnes nejasný
      │
      ▼ (po skutečném naskladnění)
Allocation                    -- allocatedQuantity, časově POZDĚJŠÍ fáze, nezávislá
                                  na Availability klasifikaci
```

**Klíčové pravidlo navrhované k schválení**: Stock/Availability by NEMĚLO být perzistovaná entita s vlastním lifecycle — je to **odvozená klasifikace, vždy přepočítávaná ze `StockSourceSnapshot`**. To je odlišné od Order/PurchaseOrder (kde lifecycle DÁVÁ smysl), a odlišné od Product (kde je to composed-from-multiple-sources, ale stále "je" entita). Stock je blíž konceptu "reconciliation output" než "canonical entity" — ale zadání (bod 4) ho žádá jako entitu, takže je potřeba rozhodnout, jestli `Stock` v Canonical Modelu = `StockSourceSnapshot` (syrová data, perzistovaná), a `AvailabilityStatus` zůstává čistě výpočetní projekce nad ním, nikdy vlastní tabulka.

## OPRAVA STRUKTURY (Jan's zpřesnění)

Místo `StockSourceSnapshot`/`AvailabilityClassification` přesnější dělení, zachovávající fakta oddělená od odvozenin:

| Canonical údaj | Původ | Typ |
|---|---|---|
| `stockQuantity` | `v.stock` | source field |
| `canPreorder` | `v.canPreorder`/`OnOrder` | source field |
| `inTransit` | `v.inTransit` | source field |
| `purchasable` | `v.purchasable`/`Purchasable` | source field |
| `inStock` | `stockQuantity > 0` | **derived**, ne zdrojové pole |

```
StockPosition (fakta, per variant, ze Shoptetu)
├── quantity
├── canPreorder
├── inTransit
└── purchasable

Derived Availability (klasifikace, přepočítávaná nad StockPosition)
├── inStock
├── lowStock
└── availability classification (IN_STOCK/LOW_STOCK/...)
```

**Kritický příklad, proč se to nesmí slít do jednoho enumu**: `quantity=0` současně s `canPreorder=true`+`inTransit=true`+`purchasable=true` je validní kombinace — produkt nemá fyzický sklad, JE na cestě, LZE předobjednat, JE koupitelný. Jeden flat `AvailabilityStatus` enum by tuhle kombinaci fakt musel zredukovat na jedinou hodnotu a ztratil by informaci. `StockPosition` zachovává všechna 4 fakta nezávisle; `Derived Availability` je čistě výpočetní projekce nad nimi, měnitelná bez ztráty zdrojových dat.

**NEVYMÝŠLET** `reserved`/`available`/`allocated`/`backordered` jako Stock pole — pro tyto koncepty neexistuje zdrojové pole ani reálná business logika kdekoli v portfoliu (viz Zjištění č. 2 výše, `allocatedQuantity` je jiná časová fáze v Procurement, ne totéž).

## WAREHOUSE — ŽÁDNÝ KONCEPT NENALEZEN
`grep -rl "Warehouse\|warehouse"` v celém `src/` AIE — **nula výsledků** mimo Canonical Model draft, který jsem sám napsal. Ani normalizery, ani Availability, ani Procurement rozlišují multi-warehouse. Shoptet `stock` je jedno číslo bez skladové lokace. `Warehouse` (ze seznamu Canonical entit v zadání) je **čistě NEW BUILD** — žádný zdrojový systém ho neřeší, stejně jako Invoice.

## OPEN QUESTIONS
1. Odkud přesně přichází `CustomerOrderLine.ownStockQuantity` — je to totéž jako `StockSourceSnapshot.stock`, nebo NEXUS-specific "vlastní sklad" koncept odlišný od Shoptet čísla (např. pro klienta s vlastním skladem nezávislým na Shoptet evidenci)?
2. `LOW_STOCK_THRESHOLD = 3` — musí být tenant-scoped konfigurace (porušuje multi-tenant princip jako hardcoded konstanta). Kam patří v Canonical Modelu — `TenantPlan`? Samostatná `AvailabilityPolicy`?
3. Kde se má perzistovat `StockSourceSnapshot` (dnes NENÍ uloženo nikde — je to compute-on-read z live Shoptet čtení)? Reconciliation (bod 9 zadání) vyžaduje EXPECTED vs ACTUAL — bez perzistovaného snapshotu není co porovnávat historicky.
4. "Reserved"/"skutečně dostupné po odečtení rezervací pro nevyřízené objednávky" NEEXISTUJE nikde — je to nová práce. Má se řešit v `core/canonical` (obecný koncept) nebo v `domains/availability` (Availability-specific)?
