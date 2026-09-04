# ENTITIES: Promotion / PromoGroup / Campaign / CampaignPlacement / Creative (audit jako jeden celek)

## SOURCE — a co v nich NENÍ nalezeno
- Pricing Engine: `ClearanceEntry` (`cloudflare-worker/src/engine/config.ts:61`) = `number | {pct, validFrom?, validTo?}` — **jediný reálný "promotion-like" koncept v celém portfoliu**, s explicitní platností od/do.
- Pricing Engine: `BRAND_SALE_DISCOUNTS` (`policy-v1.json`) — permanentní, celoroční brand-wide akce (DELPHIN -15%), NENÍ časově omezená, jiná kategorie než ClearanceEntry.
- **`Campaign`, `PromoGroup`, `CampaignPlacement`, `Creative`, `Banner` — NULA výskytů kdekoli v portfoliu** (grep case-insensitive přes Pricing Engine, AIE, SafeOrder — `campaign` má 1 falešně pozitivní zásah, `placement`/`creative`/`banner` mají 0).

## ZÁVĚR: Promotion existuje jako PRAVIDLO, ne entita. Campaign/PromoGroup/Placement/Creative jsou 100% NEW BUILD.

### Promotion — je to entita, nebo pravidlo/cenová aplikace?
**Je to pravidlo, ne entita s vlastní identitou.** `ClearanceEntry` nemá `id`, žádnou vlastní tabulku, žádný lifecycle status — je to **konfigurační hodnota přiřazená k product code** v JSON policy souboru (`clearance-sale-products.json`, `{code: entry}` mapa). Neexistuje "seznam aktivních promocí" jako perzistovaná kolekce — existuje jen "je tenhle produkt v mapě, a je teď v jeho `validFrom`/`validTo` okně".

- **Identita**: product code (cizí klíč na Product), NE vlastní ID.
- **Kdo vlastní výslednou cenu**: `calculateAllTierPrices()` (Pricing Engine `pricing.ts`), přes "clearance-vs-cap" pravidlo (dnes už zdokumentované v `CORE_LOGIC_AND_VALIDATION.md` §1.1 bod 4: aktivní clearance + cap → clearance vyhrává, nikdy floor-clamped nahoru).
- **Platnost from/until**: `validFrom`/`validTo` na `ClearanceEntry`, vyhodnocováno při KAŽDÉM price-calculation běhu (`resolveClearancePct(entry, now)`) — NENÍ to state machine s přechody, je to čistě časové okénkové porovnání při každém čtení.
- **Kolize více promocí**: řešeno přes Stage 1 `assertNoCrossFileConflicts()` — produkt nesmí být současně v `zero-discount-products.json` + `clearance-sale-products.json` + `product-max-discount-overrides.json`. To řeší kolizi NAPŘÍČ RŮZNÝMI typy pravidel, ne "dvě aktivní promoce na stejný produkt zároveň" (protože je jen jeden mapový slot per product code — druhá promoce by přepsala první, ne zkolidovala).

### PromoGroup — persisted entity, nebo grouping/reference?
**Neexistuje jako implementovaný koncept vůbec.** Nejbližší analogie je `BRAND_SALE_DISCOUNTS` (skupina podle brandu, ne explicitní PromoGroup objekt) — je to `Record<manufacturer, discount>`, žádná vlastní entita, žádný lifecycle, žádný vytvořitel/konzument vzor.

### Campaign — obchodní objekt, nebo orchestrace? Skutečný lifecycle?
**Neexistuje ŽÁDNÝ kód.** Nelze odpovědět na otázku "je ACTIVE skutečně aktivní", protože žádný `Campaign.status` field, žádná orchestrace přes Pricing+Promotion+Creative+Marketing+B2B+Placement nikde neexistuje. `frontend/nexustp/dashboard.js` (AIE Nexus UI, dnes ověřený jako čistě klientská simulace bez API napojení — viz dřívější audit) NEOBSAHUJE Campaign koncept ani v mock datech (prohledáno dřív, žádná zmínka "campaign"/"kampaň" v jeho navigaci — ta byla orientovaná na procurement/logistiku, ne marketing).

**Odpověď na Janovu klíčovou otázku "je to jedna orchestrace, nebo několik nezávislých funkcí zpětně pojmenovaných Campaign"**: **ani jedno — je to nula funkcí.** Campaign/Creative/Placement/Marketing/B2B domény nemají v celém auditovaném portfoliu jediný řádek implementace. Doména `Promotion` (jen Pricing Engine ClearanceEntry) je jediná, co má reálný, byť úzký, základ.

## TYPE → PORT → WORKFLOW → REPOSITORY → DB → TESTS → REAL RUNTIME VERIFICATION

| Entita | TYPE | PORT | WORKFLOW | REPOSITORY/DB | TESTS | RUNTIME |
|---|---|---|---|---|---|---|
| Promotion (ClearanceEntry) | ✓ | — (JSON config, ne DB) | ✓ (`resolveClearancePct` při každém price calc) | JSON soubor, ne DB; Stage 1 validace | ✓ (pricing-parity testy zahrnují clearance profily) | PRODUCTION-VERIFIED (denní provoz) |
| PromoGroup | ✗ | ✗ | ✗ | ✗ | ✗ | NOT APPLICABLE |
| Campaign | ✗ | ✗ | ✗ | ✗ | ✗ | NOT APPLICABLE |
| CampaignPlacement | ✗ | ✗ | ✗ | ✗ | ✗ | NOT APPLICABLE |
| Creative | ✗ | ✗ | ✗ | ✗ | ✗ | NOT APPLICABLE |

## SOURCE FACT ≠ DERIVED STATE ≠ DECISION ≠ EXECUTED STATE ≠ RECONCILED STATE (jediné místo, kde to lze ukázat: Promotion)

```
SOURCE FACT:        ClearanceEntry.{pct, validFrom, validTo} v JSON (Nexus-owned config)
      ↓
DERIVED STATE:       resolveClearancePct(entry, now) -- je pravidlo PRÁVĚ TEĎ aktivní? (časové okno)
      ↓
DECISION:            calculateAllTierPrices() -- clearance-vs-cap rozhodnutí, který mechanismus vyhrává
      ↓
EXECUTED STATE:       PricelistWriter zapisuje finalPrice na Shoptet (s post-write verifikací)
      ↓
RECONCILED STATE:      reconcile-pricelist-drift.ts (Stage 5) -- potvrzuje, že Shoptet skutečně má
                        očekávanou hodnotu
```

Tohle je jediná doména v celém auditu, kde všech 5 vrstev skutečně existuje a je runtime-verified. **Campaign by potřebovala stejných 5 vrstev přes 6 domén (Pricing/Promotion/Creative/Marketing/B2B/Placement) — dnes existuje jen [SOURCE FACT→DECISION→EXECUTED→RECONCILED] pro JEDNU z nich (Pricing/Promotion). Zbylých 5 chybí kompletně.**

## ENTITY BOUNDARY (návrh)

```
Promotion            -- pravidlo (ne entita s vlastním ID), vázané na Product/Brand/Category,
                         s validFrom/validTo, konzumované Pricing Decision Layer
      │
      ▼ (NEW, nemá se od čeho odvodit)
PromoGroup            -- pokud má sloužit jako cílení (produkty/kategorie/brandy dotčené
                          jednou promo akcí), navrhnout od nuly, žádný legacy vzor
      │
      ▼ (NEW, čistá orchestrace)
Campaign              -- musí explicitně rozlišit CAMPAIGN.status (orchestrační stav)
                          OD stavu KAŽDÉ jednotlivé domény, kterou aktivuje (Pricing
                          aktivní? Promo aktivní? Banner publikovaný? Newsletter odeslaný?
                          Shoptet potvrzuje?) -- přesně Janovo varování, žádný flat status
      │
      ▼ (NEW)
CampaignPlacement / Creative  -- 100% nová stavba, 0 referenčního kódu
```

**Kritické pravidlo pro Canonical Model**: `Campaign.status = ACTIVE` NESMÍ být jediný zdroj pravdy o tom, co se reálně stalo. Potřebuje strukturu analogickou k tomu, co Pricing Engine již řeší (Stage 4/5 fail-closed + reconciliation) — `Campaign` musí mít **per-subsystem reconciliation matici** (Pricing OK / Promo OK / Hero OK / Carousel ERROR / Badge OK / Landing OK — přesně formát z §27 zadání "PARTIAL_SUCCESS"), ne jeden status flag. Tohle je JEDINÝ vzor v celém portfoliu, co ukazuje, jak se to má dělat (Pricing Stage 5), ale je potřeba ho replikovat 6× (jednou per doména), ne 1× pro celou Campaign.

## OPEN QUESTIONS
1. Kolizní pravidlo u Promotion — dnešní model (jeden slot per product code v JSON mapě) implicitně zabraňuje dvěma SOUČASNĚ aktivním promocím na stejný produkt. Chce Nexus umožnit více současně platných promo pravidel s explicitní prioritizací (ne jen "poslední zápis vyhrává")?
2. Má `Campaign` v Canonical Modelu existovat jako řídící entita OD ZAČÁTKU s per-subsystem reconciliation, nebo se má stavět inkrementálně (nejdřív jen Pricing+Promotion orchestrace, Creative/Placement později)?
3. Kam patří `BRAND_SALE_DISCOUNTS` (permanentní, ne časově omezená akce) — je to `Promotion` s `validFrom=null/validTo=null`, nebo koncepčně jiná entita (`BrandPolicy`)?
