# ENTITIES: Price / PriceList / QuantityTier (audit jako jeden propojený celek)

## SOURCE
- Pricing Engine: `PricingInput`/`PricingResult`/`PricingContext` (`src/core/{interfaces,PricingContext}.ts`) — výpočetní model, ne perzistovaná entita
- Pricing Engine: `ShoptetPricelistItem` (`cloudflare-worker/src/shoptet-api/client.ts`) — perzistovaný ceníkový záznam, `sales.{volumeDiscount, quantityDiscount}` jsou BOOLEAN FLAGY
- Pricing Engine: `TIER_PRICELIST_MAP` (`cloudflare-worker/src/coupon/tier-pricelist-map.ts`) — mapování `CustomerTier → Shoptet pricelist ID` (ZR4→2, ZR6→5, ..., ZR25→29)
- AIE sales-units: `order_step`/`minimum_quantity` — validace MNOŽSTVÍ objednávky, NE cenová hladina podle množství

## KRITICKÉ ZJIŠTĚNÍ: QuantityTier (ze zadání §4) NEEXISTUJE jako implementovaná logika nikde v portfoliu

`ShoptetPricelistItem.sales.volumeDiscount`/`quantityDiscount` jsou **jen booleovské flagy** ("je pro tento produkt povolena množstevní/objemová sleva ANO/NE") — **žádná struktura s min/max množstvím → cena/multiplikátor nikde nenalezena**. `AIE sales-units` řeší jinou věc: `order_step`/`minimum_quantity` je validace "musí se objednat po kartonech", ne "10+ ks = sleva 12%".

**→ `QuantityTier` je čistě NEW BUILD, stejně jako Invoice/Warehouse.**

## KLÍČOVÉ ZJIŠTĚNÍ: PriceList = Customer Tier, ne obecný cenový list

`PriceList` v zadání (§4) implikuje obecný koncept (různé ceníky pro různé účely). Realita v Pricing Engine: **`PriceList` = 1:1 s `CustomerTier`** (`TIER_PRICELIST_MAP`, deset ZR4-ZR25 tierů + GUEST). Neexistuje koncept "více ceníků nezávislých na loyalty tieru" (např. B2B ceník vs. B2C ceník jako nezávislá dimenze) — tenhle rozměr, pokud ho zadání chce (§29 B2B), je NEW BUILD.

## PRICE — vztah PricingInput/PricingResult k ShoptetPricelistItem

```
ShoptetPricelistItem (perzistováno na Shoptetu, PER pricelist/tier)
   price.price          -- aktuální cena na daném tieru
   price.commonPrice     -- "běžná" cena bez slev
   price.buyPrice         -- nákupní cena (Product audit: JINÁ hodnota než SupplierOffer)
   price.actionPrice      -- akční/sale cena
      │
      ▼ (čte se PŘI syncu jako feed row, NE přímo ShoptetPricelistItem)
PricingInput (VÝPOČETNÍ VSTUP, per SKU, per customer tier)
   basePrice, salePrice, customerTier, productMaxDiscount, ...
      │
      ▼ (PricingEngine.calculatePrice())
PricingResult (VÝPOČETNÍ VÝSTUP)
   finalPrice, appliedRules[], rejected, rejectReason
      │
      ▼ (PricelistWriter.processDiff(), viz dnešní okfish audit)
ZPĚT do ShoptetPricelistItem.price.price (write-back, s post-write verifikací)
```

**`Price` (Canonical) NENÍ jednoduchá entita** — je to buď (a) vstup do výpočtu (`PricingInput`, efemérní, per sync run), nebo (b) perzistovaný výsledek (`ShoptetPricelistItem.price.*`, per tier, na Shoptetu). Canonical Model potřebuje rozlišit tyto dvě role, ne slít je do jednoho `Price` objektu — přesně stejný typ chyby jako Product `purchasePrice` vs `SupplierOffer.unitPrice`.

## TYPE → PORT → WORKFLOW → REPOSITORY → DB
- **Žádný port/repository vzor** — `PricingEngine` je čistá command-pattern třída (`use(policy)`, `freeze()`, `calculatePrice()`), bez DB závislosti vůbec. Perzistence probíhá VÝHRADNĚ přes `PricelistWriter`/`ShoptetApiClient` (zápis zpátky do Shoptetu), ne do vlastní NEXUS DB.
- **`TIER_PRICELIST_MAP`** je hardcoded konstanta v kódu, ne DB konfigurace — to porušuje multi-tenant princip stejně jako `LOW_STOCK_THRESHOLD` u Stock. Per-klient mapování `tier → pricelistId` by musela být tenant-scoped konfigurace v Nexusu, ne kód.

## REAL RUNTIME VERIFICATION
| Vrstva | Stav |
|---|---|
| `PricingEngine.calculatePrice()` | PRODUCTION-VERIFIED — golden-dataset testy + živý denní provoz |
| `PricelistWriter` write-back | PRODUCTION-VERIFIED s post-write verifikací (dnešní audit) — nejsilnější runtime verifikace ze všech auditovaných entit |
| `QuantityTier` | NOT APPLICABLE — neexistuje |

## SOURCE-OF-TRUTH MATRIX

| Údaj | Shoptet | Pricing Engine | Canonical (návrh) |
|---|---|---|---|
| `PriceList` identita | ✓ (pricelist ID) | ✓ (`TIER_PRICELIST_MAP`, hardcoded) | **Shoptet** pro ID, **Nexus tenant config** pro mapování (ne hardcoded) |
| Cena na tieru | ✓ (`price.price`) | vypočítáno, pak zapsáno zpět | **Nexus Pricing** počítá, **Shoptet** je cíl zápisu |
| `volumeDiscount`/`quantityDiscount` flag | ✓ (boolean) | čteno, ne dál rozvinuto | **Shoptet** (flag), skutečná tier logika NENÍ implementována |
| Discount limits (brand/category/product) | ✗ | ✓ (`policy-v1.json`, tenant-owned) | **Nexus** — čistě konfigurační, žádný externí zdroj |

## ENTITY BOUNDARY (návrh)

```
PriceList              -- 1:1 s loyalty tier DNES, ale Canonical Model by
                           měl umožnit i jiné dimenze (B2B/B2C) -- NEW
                           BUILD rozšíření, ne migrace
      │
      ▼
Price                  -- rozdělit na:
   ├── PricingComputationInput   (efemérní, per sync run)
   └── PersistedPriceRecord      (Shoptet zrcadlo, per tier, per SKU)

QuantityTier           -- ZCELA NEW BUILD, žádný legacy vzor k převzetí,
                           kromě boolean flagů co signalizují "povoleno"
```

## OPEN QUESTIONS
1. Má `PriceList` v Canonical Modelu zůstat 1:1 s loyalty tier, nebo se má od začátku navrhnout jako nezávislá dimenze (umožňující B2B ceník × loyalty tier kombinace)?
2. `TIER_PRICELIST_MAP` hardcoded mapování — stejný multi-tenant problém jako `LOW_STOCK_THRESHOLD`. Řešit společně jako jeden vzor "tenant-scoped konfigurace nahrazující hardcoded konstanty" napříč Pricing i Availability?
3. `QuantityTier` — navrhnout od nuly. Má vazbu na `Product` (per-produkt tiery) nebo `PriceList` (per-tier obecná pravidla), nebo obojí?
