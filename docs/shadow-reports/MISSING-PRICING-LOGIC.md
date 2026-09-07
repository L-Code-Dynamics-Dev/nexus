# Doplnění chybějící cenové logiky okfish → NEXUS

**Datum:** 2026-09-07
**Status:** Rules NAPSANÉ A OTESTOVANÉ, **ZÁMĚRNĚ NEZAPOJENÉ** do `createNexusPricingCalculator`.
Zapojení do produkčního chainu je rozhodnutí Lucky (Non-Interference).

**Zdroj pravdy:** živý klon `hlancaric-ship-it/okfish-pricing-engine`,
`/Users/lucky/.claude/jobs/99e48aa8/tmp/okfish-live`, HEAD `3a910e2`. Pouze čteno.
**Podklad:** `docs/design-proposals/Pricing-Shadow-Migration.md` §3.1 a §3.4.

---

## 1. Co bylo doplněno

| Rule | Soubor | Portováno z (okfish) |
|---|---|---|
| `NoOpActionPriceRule` | `domains/pricing/NoOpActionPriceRule.ts` | `cloudflare-worker/src/engine/pricing.ts:119-125` + `shoptet-api/pricing-bridge.ts:56` |
| `BrandSaleDiscountRule` | `domains/pricing/BrandSaleDiscountRule.ts` | `engine/config.ts:34`, `engine/pricing.ts:127-139`, `pricing-bridge.ts:66-72` |
| `ClearanceWindowRule` | `domains/pricing/ClearanceWindowRule.ts` | `engine/config.ts:61-73` (`resolveClearancePct`) |
| `ProductLimitCompositionRule` | `domains/pricing/ProductLimitCompositionRule.ts` | `engine/config.ts:92-115` (Stage 1) + `:117-123` (spread) |

Dále rozšířeno `PolicyConfig` (`domains/pricing/PricingConfigurationProvider.ts`)
o volitelné `brandSaleDiscounts?: Record<string, number>`. Pole v legacy
`policy-v1.json` existovalo od začátku, `PolicyConfig` ho jen zahazoval.
Žádná nová konfigurace.

### Závazné pořadí aplikace

```
NoOpActionPriceRule       -> zahodí actionPrice >= basePrice
BrandSaleDiscountRule     -> doplní brandovou, JEN když žádná nezůstala
    (mimo per-produkt smyčku)
    ClearanceWindowRule       -> aktivní/neaktivní výprodej pro `now`
    ProductLimitCompositionRule -> složí PRODUCT_LIMITS ze tří zdrojů
HighestDiscountRule       -> akce vs loyalty        (už existovalo)
DiscountLimitRule         -> strop / VAGNER pravidlo (už existovalo)
RoundingRule                                          (už existovalo)
```

Pořadí 1 → 2 je kritické: bez guardu by mrtvá `actionPrice` zablokovala
brandovou syntézu i celou loyalty/cap logiku. Reálný dopad: **8908 z 16633**
řádků v okfish `products.csv` má `actionPrice` přesně rovné `price`.

---

## 2. Testy

Nové soubory v `tests/regression/golden-pricing/`:

| Soubor | Testů | Co ověřuje |
|---|---|---|
| `noop-action-price-rule-parity.test.ts` | 10 | guard proti oběma okfish variantám, 28 reálných řádků z `products.csv` |
| `brand-sale-discount-rule-parity.test.ts` | 20 | syntéza + vyčerpávající rounding parita (2,1 mil. dvojic) |
| `clearance-window-rule-parity.test.ts` | 20 | hranice okna den po dni, jednostranná okna, fail-closed |
| `product-limit-composition-rule-parity.test.ts` | 17 | kompozice ze tří reálných JSON + Stage 1 konflikty |
| `okfish-missing-logic-integration.test.ts` | 10 | všechna 4 pravidla + existující chain proti reálnému okfish výstupu |

**Fixtures** (`tests/regression/golden-pricing/fixtures/okfish-policy/`) jsou
bitové kopie produkčních souborů z okfishe:
`policy-v1.json`, `clearance-sale-products.json` (40 kódů),
`zero-discount-products.json` (206 kódů), `product-max-discount-overrides.json` (2 kódy),
`okfish-products-import-snapshot.csv` (100 reálných produktů s vypočtenými
cenami pro všech 10 ZR ceníků) a `okfish-products-actionprice-sample.csv`
(28 řádků z `products.csv`, všechny čtyři třídy actionPrice).

Integrační test porovnává **1000 reálných cen** (100 produktů × 10 tierů)
proti tomu, co okfish skutečně zapsal do Shoptetu. Shoda na cent, 0 rozdílů.

---

## 3. NÁLEZY — okfish se sám se sebou neshoduje

Tohle nejsou chyby portu. Jsou to reálné rozpory mezi dvěma okfish engines,
které musí do shadow porovnávače jako **known divergence**, jinak se budou
tvářit jako regrese NEXUSu.

### 3.1 Zaokrouhlení brandové syntézy: worker ≠ bridge (1,13 % katalogu)

```
worker  (pricing.ts:57-60):     Math.round(Math.round(base*100) * (100-pct) / 100) / 100
bridge  (pricing-bridge.ts:69): Math.round(base * (1 - ratio) * 100) / 100
```

Vzorec v bridge trpí přesně tou float chybou, kvůli které `applyPercent`
ve workeru vzniklo — komentář `pricing.ts:50-56` ji popisuje, ale bridge
tu opravu nikdy nedostal.

Změřeno na reálném `products.csv` (16633 řádků × 3 sazby = 49899 dvojic):
**564 dvojic (1,13 %) se liší o 1 cent.** Např. base 1,15 @ 10 % →
worker 1,04, bridge 1,03.

Okfish vlastní testy to nechytí, protože všechny používají `base = 100`.

**NEXUS jde s WORKEREM** (matematicky správná varianta, shodná s badgem,
který vidí zákazník). Ověřeno vyčerpávajícím testem: `Decimal.toDecimalPlaces(2,
ROUND_HALF_UP)` dává identický výsledek jako integer-cents `applyPercent`
na všech cenách 0,01–7 000,00 EUR × {15 %, 10 %, 9 %} — 2,1 mil. dvojic,
0 rozdílů. (Rozsah pokrývá celý katalog: nejdražší položka stojí 6 830,01 EUR.)

### 3.2 `actionPrice = 0`: worker ≠ bridge

```
worker: if (actionPrice !== undefined && actionPrice >= basePrice) → 0 PROJDE jako akce
bridge: p.actionPrice && ... → 0 je falsy → ZAHOZENO
```

NEXUS jde s workerem. Na reálných datech se to dnes neprojeví (v `products.csv`
není `actionPrice = 0` s kladnou `price`), ale je to tikající rozdíl.

### 3.3 `resolveClearancePct` míchá UTC a lokální čas

```
validFrom: new Date("2026-08-31")              → UTC půlnoc
validTo:   new Date("2026-09-04" + "T23:59:59") → LOKÁLNÍ čas (bez zóny!)
```

Zachováno 1:1, protože "oprava" by NEXUS rozešla s okfishem na strojích mimo
UTC. Na Cloudflare Workeru a v CI (obojí UTC) je to bez rozdílu.

### 3.4 Okfish clearance okno je nedeterministické

`config.ts:70` volá `new Date()` při načtení modulu. Dlouhoběžící Worker
isolate proto může držet zastaralé okno mezi deploymenty — okfish si toho
je vědom a v komentáři `config.ts:55-60` to označuje za "known, accepted
limitation".

**NEXUS to nepřebírá.** `now` je vstup `ClearanceWindowRule.evaluate()`,
podle požadavku `core/canonical/rules/Rule.ts` na determinismus.

### 3.5 Stage 1 v NEXUSu nehází, vrací data

Okfish `assertNoCrossFileConflicts` hází výjimku při načtení modulu
("refuse to build at all"). Rule kontrakt zakazuje side effects v `evaluate()`,
takže NEXUS konflikt vrací jako `{ valid: false, conflicts, reason }`.
Efekt je stejný — při konfliktu se mapa nepostaví, takže nelze omylem spočítat
cenu z nejednoznačné konfigurace. Rozhodnutí, jestli to shodí proces, patří
volajícímu.

---

## 4. Co se NEPODAŘILO ověřit — NEOVĚŘENO

Poctivě: následující je portované ze **zdrojového kódu** okfishe, ale
**neověřené proti reálnému produkčnímu výstupu**, protože ta data neexistují.

### 4.1 Clearance okna nikdy nebyla vidět v reálném výstupu

Jediný dohledatelný snapshot skutečných vypočtených cen
(`products_import.csv`, 100 produktů) vznikl **PŘED** zavedením
`clearance-sale-products.json`. Důkazy (zafixované testem):

- kód `112824` je dnes v `zero-discount-products.json` (strop 0 %), ale
  ve snapshotu má na ZR25 slevu ~24,9 %;
- kód `3963P-S` je dnes v `clearance-sale-products.json` (20 % v okně
  31. 8. – 4. 9.), ale ve snapshotu má −10 % (brand limit).

**NEOVĚŘENO:** že se clearance okno v produkci chová tak, jak ho `config.ts`
popisuje. Parita je ověřená jen proti okfish zdrojovému kódu (replikovanému
v testu jako oracle), ne proti tomu, co okfish reálně zapsal.

### 4.2 `manufacturer` v produkčním feedu chybí

Ani `products.csv`, ani `products_import.csv` nemají sloupec `manufacturer`.
Brandová syntéza i brandLimits jsou tedy ověřené jen proti okfish oracle
implementaci na syntetických (byť realistických, z katalogu odvozených)
cenách — **ne proti reálnému výstupu**.

To je zároveň potvrzení rizika z `Pricing-Shadow-Migration.md` §3.3 bod 5:
pokud shadow adapter zapomene `manufacturer` předat, dostane falešnou 100%
shodu na nekapovaných cenách.

**NEOVĚŘENO:** odkud přesně produkční sync bere `manufacturer`. Do
`pricing-bridge.ts` chodí jako `p.manufacturer` z volajícího
(`sync-orchestrator.ts`), tj. patrně ze Shoptet API, ne z CSV. Nedohledáno
do konce.

### 4.3 `PRODUCT_LIMITS` v reálném výstupu

Ze stejného důvodu jako 4.1: snapshot je starší než všechny tři JSON zdroje.
Kompozice mapy je ověřená proti okfish oracle (bit po bitu shodná mapa
pro tři různé okamžiky), ne proti produkčním cenám.

### 4.4 Nezpracované položky z §3.1, které NEJSOU v tomto scope

Ze zadání jsem řešil čtyři body. Z §3.1 zbývají nedotčené:

- **Worker mini-engine cesta** (`calculateAllTierPrices` jako celek /
  real-time badge endpoint) — NEXUS nemá protějšek. V testu je oracle replika,
  ale žádná produkční NEXUS cesta.
- **Fallback při neplatné basePrice** — worker vrací `basePrice` pro všechny
  tiery, NEXUS/legacy validace odmítne. Rozdíl typu "cena vs žádná cena".
- **`allowLoyaltyDiscount` parsing z CSV řetězce** (`"1"/"true"/"yes"/undefined`)
  — patří do adaptéru, ne do Rule. Nenapsáno.
- **Napojení na data** (KV, Shoptet API, feed) — mimo scope.
- **coupon policy interakce s cenou** (§3.4) — mimo scope.

### 4.5 Kde si nejsem jistý shodou

- ~~**Strop 0 % se chová jako ŽÁDNÝ strop.**~~ **VYŘEŠENO — Lucky potvrdil
  2026-09-07: „strop je jako že tam nesmí být žádná sleva".**

  Původní formulace byla zavádějící. `minAllowedPrice = applyPercent(base, 0)
  = base` znamená, že podlaha ceny je rovna základní ceně, takže **každá
  sleva se zvedne zpátky na plnou cenu** — tedy přesně „žádná sleva se
  nesmí dát". Není to „žádný strop", je to **nejpřísnější možný strop**.

  Ověřeno výpočtem přes `DiscountLimitRule`: limit 0 %, cena slevněná ze
  100 na 80 → `{"applied":true,"price":"100","rule":"PRODUCT_LIMIT"}`.
  Totéž u `BRAND_LIMIT`. Obě implementace (worker i NEXUS) se shodují
  a chovají se podle záměru.

  Souvisí to s tím, proč `DiscountLimitRule` kontroluje `!== undefined`
  a ne truthy hodnotu: kdyby testovala truthy, limit `0` by propadl jako
  „limit není nastaven" a chráněný produkt by šel do slevy bez omezení.
- **`brandSaleActionPrice` jako zápisový signál.** V okfishi ho
  `sync-orchestrator.ts` používá k rozhodnutí, které kódy potřebují reálný
  zápis `actionPrice` na základní/GUEST ceník. NEXUS ho vrací jako
  `synthesizedFromBrand`, ale **co s ním connector udělá, není navrženo**.
- **`categoryLimits`** jsou v produkci prázdné (`{}`), takže ta větev je
  i nadále mrtvá — stejně jako konstatuje §3.4.

---

## 5. Stav

```
npx tsc --noEmit   → čistý, 0 chyb
npx vitest run     → 67 souborů, 864 testů, VŠE ZELENÉ
                     (754 baseline + 110 nových)
```

Rozpad nových testů: 10 (no-op) + 20 (brand sale) + 20 (clearance)
+ 17 (product limits) + 10 (integrace) = 77 `it()` bloků, které se díky
`it.each` maticím rozpadají na 110 spuštěných testů.

Nová pravidla **nejsou** zapojena do `createNexusPricingCalculator`.
Integrační test si chain skládá ručně, jen jako důkaz, že dohromady sedí.
