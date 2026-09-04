# ENTITY: Product

## SOURCE
- Pricing Engine: `PricingInput` (`src/core/interfaces.ts`) — výpočetní vstup, NE perzistovaná entita; `ShoptetPricelistItem` (`cloudflare-worker/src/shoptet-api/client.ts`) — perzistovaný Shoptet ceníkový záznam; master feed CSV řádek (`row['code']`, `row['manufacturer']`, `row['categoryText']`, atd., `sync-coupon-fields-live.ts`)
- AIE Availability: `ProductAvailabilityInput` (`src/core/availability/types.ts`) — dostupnostní projekce, jen `id`+`variants[]`+volitelné `sku`
- AIE Procurement: `productId`+`variantId`+`sku` — TŘI pole odkazující na produkt/variantu napříč `CustomerOrderLine`, `PurchaseOrderLine`, `SupplierOffer`
- GOLIÁŠ/variant-matrix: CSV feed s konfigurovatelným column mapping (per-klient, hecmania.cz specific), ne obecná struktura
- Omega: žádný Product koncept — pracuje jen s hotovými doklady (řádky faktury), ne s katalogem

## KLÍČOVÉ ZJIŠTĚNÍ Č. 1: minimálně 4 nekompatibilní "produktové" reprezentace, žádná nemá `name`+`stock`+`category`+`purchasePrice` současně

| Reprezentace | Má name | Má stock | Má category/brand | Má purchasePrice | Má variant vztah |
|---|---|---|---|---|---|
| `PricingInput` (Pricing) | ✗ | ✗ | ✓ (`manufacturer`,`category`) | ✓ (`purchasePrice`) | ✗ |
| `ShoptetPricelistItem` (Pricing) | ✗ | ✗ | ✗ | ✓ (`price.buyPrice`) | ✗ |
| `ProductAvailabilityInput` (AIE Availability) | ✗ | ✓ (přes `variants[].stockAmount`) | ✗ | ✗ | ✓ (`variants[]`) |
| AIE Procurement (`productId`/`variantId`/`sku`) | ✗ | ✗ (jen `ownStockQuantity` na `CustomerOrderLine`) | ✗ | ✗ (má `unitPrice` na `SupplierOffer`, jiná věc) | ✓ (odděleně `productId` vs `variantId`) |

**Žádný zdrojový systém nemá jeden "Product" objekt s úplnými daty** — každý systém řeší jen tu podmnožinu polí, kterou potřebuje pro svou vlastní výpočetní úlohu. To je fundamentálně jiná situace než u Order/PurchaseOrder (kde šlo o nekonzistentní lifecycle jedné entity) — tady jde o **chybějící jednotný zdroj dat vůbec**, ne jen nekonzistentní stav.

## KLÍČOVÉ ZJIŠTĚNÍ Č. 2: EAN je jen komentář, ne datové pole
`feed-generator.ts:93`: *"automatic import happens via CODE (or EAN), not import-code"* — to je jediná zmínka EAN v celém prohledaném kódu. Žádná struktura (`PricingInput`, `ShoptetPricelistItem`, AIE typy) obsahuje `.ean` jako pole. Identifikace produktu se dělá výhradně přes `code`/`sku`.

## KLÍČOVÉ ZJIŠTĚNÍ Č. 3: Product vs. Variant hranice je nekonzistentní napříč zdroji
- Pricing Engine **nemá Variant koncept vůbec** — `PricingInput.sku` je atomická jednotka, žádné rozlišení "produkt má varianty".
- AIE **explicitně rozlišuje** `productId` vs `variantId` jako dvě různá pole ve všech procurement typech, a `ProductAvailabilityInput.variants[]` jako array — varianta je jasně poddruh produktu.
- variant-matrix (GOLIÁŠ) **existuje právě proto**, že samotný Shoptet feed/frontend nerozlišuje varianty dobře — je to řešení nedostatku, ne odraz existujícího konceptu.

**→ Otázka pro Canonical Model**: je `Variant` vždy povinná mezivrstva (i pro produkt bez variant, kde by byla 1 "default" varianta), nebo je `Product` sám o sobě nákupní jednotka a `Variant` je opt-in rozšíření? AIE a Pricing Engine na tuhle otázku odpovídají různě.

## SOURCE-OF-TRUTH MATRIX

| Údaj | Shoptet | Pricing | Availability | Procurement | Campaign | Canonical (návrh) |
|---|---|---|---|---|---|---|
| Identita/SKU | ✓ (`code`) | ✓ (`sku`) | ✓ (`sku`, volitelné) | ✓ (`sku`) | — (TBD, žádný zdroj) | **Shoptet** (externí zdroj pravdy), zrcadleno |
| Název | ✓ (feed, ne v prohlédnutých typech přímo) | ✗ | ✗ | ✗ | — | **Shoptet** |
| Base price | ✓ (`price.price`/`price.commonPrice`) | ✓ (`basePrice`) | ✗ | ✗ | — | **Shoptet** čte, **Pricing** počítá odvozené ceny — TBD kdo "vlastní" výsledný zápis zpět |
| Sale/action price | ✓ (`price.actionPrice`) | ✓ (`salePrice`) | ✗ | ✗ | TBD (Campaign má aktivovat) | **Pricing** vypočítá, **Shoptet** dostane zápis (potvrzeno dnešním PricelistWriter auditem) |
| Purchase price | ✓ (`price.buyPrice`) | ✓ (`purchasePrice`) | ✗ | ✓ (na `SupplierOffer.unitPrice`, JINÁ hodnota — nákupní cena OD DODAVATELE, ne totéž jako Shoptet buyPrice) | — | **DVĚ nezávislé "nákupní ceny"**: Shoptet/Pricing `buyPrice` (historická/evidenční) vs. Procurement `SupplierOffer.unitPrice` (aktuální nabídka konkrétního dodavatele) — NESMÍ se sloučit do jednoho pole |
| Stock | ✓ (feed) | ✗ | ✓ (`VariantAvailability.stockAmount`) | ✓ (`CustomerOrderLine.ownStockQuantity`, jiné pojmenování téže věci) | — | **Availability** je autoritativní výpočetní vrstva, ale primární data čte ze Shoptetu/vlastního skladu — TBD přesný zdroj |
| Category | ✓ (`categoryText` ve feedu) | ✓ (`category`, pro brand/category limit lookup) | ✗ | ✗ | TBD (Campaign cílí na kategorie) | **Shoptet** |
| Brand | ✓ (feed `manufacturer`) | ✓ (`manufacturer`, pro brand limit lookup) | ✗ | ✗ | TBD | **Shoptet** |
| Variant vztah | ✓ (implicitně, žádná explicitní varianta v prohlédnutých typech) | ✗ nemá | ✓ (`variants[]`) | ✓ (`productId`+`variantId`) | — | **TBD — Zjištění č.3 výše, nerozhodnuto** |
| Discount limits | ✗ (Shoptet o tom neví) | ✓ (`productMaxDiscount`, `brandLimits`, `categoryLimits` v `policy-v1.json`) | ✗ | ✗ | TBD | **Pricing** — čistě Nexus/tenant-owned konfigurace, ŽÁDNÝ externí zdroj |

## TYPE → PORT → WORKFLOW → REPOSITORY → DB
- **Pricing Engine**: žádný port/repository vzor pro Product — čte se přímo z master feed CSV (streamované, `CsvParserStream`) nebo přes `ShoptetApiClient`. Není to CRUD entita, je to per-sync-run vstup do výpočtu.
- **AIE Availability**: `AvailabilityEngine.evaluate(ProductAvailabilityInput)` — čistá funkce, žádná DB vrstva pro Product samotný (na rozdíl od Procurement, které MÁ `PostgresProcurementRepository`).
- **AIE Procurement**: Product/Variant nemá vlastní tabulku — `product_id`/`variant_id` jsou jen cizí klíče (stringy) uvnitř `procurement_supplier_offers`, `procurement_purchase_order_lines`. **Product samo o sobě není perzistovaná Nexus entita nikde v AIE.**

## REAL RUNTIME VERIFICATION
| Vrstva | Stav |
|---|---|
| Pricing Engine feed čtení | PRODUCTION-VERIFIED (živý denní provoz na okfish.sk) |
| AIE `AvailabilityEngine.evaluate()` | MOCK ONLY — `AvailabilityEngine.test.ts` testuje čistou funkci s ručně sestavenými vstupy, žádná DB vrstva k testování ani neexistuje |
| AIE Procurement product/variant FK | MOCK ONLY — stejný vzorec jako `PostgresProcurementRepository.test.ts` u PurchaseOrder (mockovaná transakce) |

## ENTITY BOUNDARY (návrh k diskusi)

```
Product                    -- commerce entity, Shoptet je zdroj pravdy pro
  │                            identitu/název/kategorii/brand/ceny
  ├── Variant                -- TBD zda povinná vrstva vždy, nebo opt-in
  │
  ├── PricingPolicy data     -- Nexus/tenant-owned (discount limits), NENÍ
  │                            v Shoptetu, patří do domains/pricing/, ne
  │                            do Product samotného
  │
  ├── AvailabilitySnapshot   -- odvozený, přepočítávaný stav (IN_STOCK/...),
  │                            NENÍ pole na Product, je to samostatná
  │                            projekce s vlastním timestampem/source
  │
  └── SupplierOffer[]        -- Procurement-owned, purchasePrice TADY je
                                 JINÁ hodnota než Product.purchasePrice
                                 (historická/Shoptet) -- nesmí se zaměnit
```

**Klíčové pravidlo navrhované k schválení**: `Product.purchasePrice` (zrcadlo Shoptet `buyPrice`, evidenční/historická hodnota) a `SupplierOffer.unitPrice` (aktuální nabídka konkrétního dodavatele pro Procurement rozhodování) jsou DVĚ NEZÁVISLÉ hodnoty se stejným významem slova "nákupní cena", ale jiným zdrojem pravdy a jiným účelem. Sloučení by způsobilo přesně ten typ kruhové závislosti, co `coupon-sales-writer.ts` (Pricing Engine, INC-011) už jednou zdokumentoval a opravil pro jiný pár polí (feedovo `maxDiscount` vs. vypočtený kupónový výstup).

## OPEN QUESTIONS
1. Je Variant povinná vrstva vždy (i pro produkt bez variant), nebo opt-in? (Pricing Engine ji nemá vůbec, AIE ji má jako array.)
2. Kdo "vlastní" zápis vypočtené `salePrice` zpátky do Shoptetu — je to Product.price mutace, nebo samostatná write-only operace mimo Canonical Product model?
3. `AvailabilitySnapshot` — má to být pole na `Product`/`Variant`, nebo úplně samostatná time-series entita (výpočet se dělá opakovaně, stav zastarává)?
4. Discount limits (`productMaxDiscount`, `brandLimits`, `categoryLimits`) — jsou to vlastnosti `Product`, nebo samostatná `Rule`/`RuleVersion` entita (ze seznamu Canonical Model) vázaná na `Product.id`/`Brand.id`/`Category.id`?
