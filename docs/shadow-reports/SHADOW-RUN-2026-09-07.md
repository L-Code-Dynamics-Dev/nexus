# Shadow run 2026-09-07 — offline replay, P3 + P2

**Typ běhu:** Varianta 0 (offline replay) podle `docs/design-proposals/Pricing-Shadow-Migration.md` §4.2.
**Produkční zápisy:** ŽÁDNÉ. Jediné síťové volání celého běhu byl `GET` na veřejný `MASTER_FEED_URL`.
Okfish klon po běhu ověřen: `git status --porcelain` = **0 změn**. Žádný Shoptet token nebyl v prostředí
(harness na jeho přítomnost tvrdě padá — `assertNoShoptetToken()`).

---

## 1. Co běželo

| | |
|---|---|
| Data | živý `MASTER_FEED_URL` (`products.csv` export, HTTP 200, 58,3 MB, 16 758 produktů) |
| Katalog | 16 758 produktů × 10 tierů (ZR4–ZR25) = **167 580 porovnání na režim** |
| P3 doba | **14,0 s** (celý katalog) |
| P2 doba | **32,4 s** (celý katalog × 3 režimy = 502 740 porovnání) |
| okfish HEAD | klon `/Users/lucky/.claude/jobs/99e48aa8/tmp/okfish-live`, importován přímo, needitován |
| Konfigurace | `policy-v1.json` v NEXUSu a v okfishi jsou **bajtově identické** (ověřeno `diff`) |

**Oba okfish enginy se importují z klonu**, nekopírují se: `cloudflare-worker/src/engine/pricing.ts`
(worker mini-engine) a `cloudflare-worker/src/shoptet-api/pricing-bridge.ts` → `calculateProductsPricing`
(root engine přes `EngineBuilder`). Reimplementovaná je jen konfigurační vrstva (`PRODUCT_LIMITS` merge),
protože okfish `engine/config.ts` je Worker modul s JSON importy — logika je zkopírovaná 1:1 včetně
Stage 1 konfliktní validace.

Spuštění: `tools/shadow/run.sh {p3|p2} [--limit N] [--offline] [--out file.json]`

---

## 2. P3 (priorita 0) — shoduje se okfish sám se sebou?

**Odpověď: skoro, ale NE. Na 4 produktech se rozchází, a u dvou z nich jde o rozdíl až 1,50 €.**

```
porovnání:  167 580
shoda:      167 554  (99,9845 %)
rozdílů:    26  na  4 produktech
```

| Třída | Rozdílů | Produktů | Závažnost |
|---|---|---|---|
| `ALLOW_LOYALTY_DIVERGENCE` | 14 | 2 | **VYSOKÁ** — až −1,50 €/kus |
| `BRAND_SALE_ROUNDING` | 12 | 2 | nízká — přesně 1 haléř |

### 2.1 `ALLOW_LOYALTY_DIVERGENCE` — reálná divergence, ne zaokrouhlení

**Příčina:** `pricing-bridge.ts` řádek 87 posílá do root enginu `allowLoyaltyDiscount: true`
**natvrdo**. Worker mini-engine naproti tomu čte `applyLoyaltyDiscount` z feedu
(`resolveAllowLoyaltyDiscount`, pricing.ts:98). Když je ve feedu `0`, worker loyalty vypne,
root engine ji spočítá.

Ve feedu má `applyLoyaltyDiscount = "0"` **8 produktů**. Rozdíl se projevil jen u 2 —
u zbylých 6 ho náhodou zamaskovala jiná ochrana:

| Kód | Značka | Proč (ne)protéká |
|---|---|---|
| `30P`, `50P`, `9899`, `100P` | Slovenský RYBÁR | `zero-discount-products.json` → limit 0 % zastaví obě strany |
| `16912`, `56319` | MIVARDI | má actionPrice + brandLimit 0,10 → sale-wins větev obejde loyalty |
| **`93683`** | DELPHIN | **nic ho nechrání → rozdíl protéká** |
| **`31406`** | (bez značky) | **nic ho nechrání → rozdíl protéká** |

Konkrétně:

| Kód | base | action | tier | root engine | worker engine | Δ |
|---|---|---|---|---|---|---|
| 93683 | 14,95 | 12,71 | ZR16 | 12,56 | 12,71 | −0,15 |
| 93683 | 14,95 | 12,71 | ZR18 | 12,26 | 12,71 | −0,45 |
| 93683 | 14,95 | 12,71 | ZR20 | 11,96 | 12,71 | −0,75 |
| 93683 | 14,95 | 12,71 | ZR25 | 11,21 | 12,71 | **−1,50** |
| 31406 | 1,00 | — | ZR4 | 0,96 | 1,00 | −0,04 |
| 31406 | 1,00 | — | ZR25 | 0,75 | 1,00 | **−0,25** |

**Praktický dopad dnes:** zákazník v ZR25 vidí na detailu produktu 93683 badge s cenou **12,71 €**
(worker), zatímco v ceníku, který mu sync zapsal do Shoptetu, má **11,21 €** (root engine).
Badge a skutečná cena se rozcházejí o 1,50 €. To není teoretický nález — je to živý stav.

**Který engine má pravdu?** Podle sémantiky pole má pravdu **worker** (`applyLoyaltyDiscount=0`
zjevně znamená „na tenhle produkt loyalty ne"). Root engine to pole vůbec nevidí, protože
`ProductsReader` ho ze Shoptet API nedostává — stejný důvod, proč se dřív musel dotahovat
`manufacturer` z feedu (sync-orchestrator.ts:24). To je **rozhodnutí pro Luckyho**, ne pro harness.

### 2.2 `BRAND_SALE_ROUNDING` — 1 haléř, oba enginy počítají brandSale jinak

Root engine (`pricing-bridge.ts:69`): `Math.round(base * (1 - d) * 100) / 100`
Worker engine (`pricing.ts:137` → `applyPercent`): `Math.round(round(base*100) * (100-pct) / 100) / 100`

Na hraně půl haléře se rozejdou:

| Kód | base | značka | root | worker | Δ |
|---|---|---|---|---|---|
| 39786 | 2,30 | DELPHIN | 1,95 | 1,96 | −0,01 |
| 93914 | 1,50 | DELPHIN | 1,27 | 1,28 | −0,01 |

Ověřeno ručním přepočtem: `2.30 * 0.85 = 1.955`; float dá `1.9549999…` → root zaokrouhlí dolů
na 1,95, worker přes integer-cents na správných 1,96. **Ironicky tady má pravdu worker**, přestože
komentář v `pricing.ts` popisuje `applyPercent` jako obranu proti přesně téhle chybě — root engine
ji při brandSale syntéze nemá, protože ji nepočítá přes Decimal, ale nativním `Math.round`.

Projeví se jen na tierech ZR4–ZR14; od ZR16 výš loyalty přebije brandSale, a shoda se vrátí.

### 2.3 Verdikt P3

Okfish se sám se sebou shoduje na **99,9845 %**. Zbývající rozdíly nejsou náhodné —
obě třídy jsou **plně vysvětlené, reprodukovatelné a ručně přepočítané**. `UNCLASSIFIED = 0`.

Podle §4.6 návrhu je P3 podmínkou startu P1/P2: **splněno v tom smyslu, že baseline je změřená
a vysvětlená**, ale `ALLOW_LOYALTY_DIVERGENCE` je otevřený produkční nález, který by se měl
opravit v okfishi bez ohledu na to, jestli k migraci vůbec dojde.

---

## 3. P2 — NEXUS chain vs okfish root engine

Tři režimy, všechny nad stejnými 167 580 kombinacemi:

| Režim | Co NEXUS dostal | Shoda | Rozdílů | Produktů |
|---|---|---|---|---|
| `naive` | to, co dnes reálně umí přijmout | 98,6663 % | 2 235 | 251 |
| `with-limits` | + složené `PRODUCT_LIMITS` | 99,9021 % | 164 | 35 |
| `adapted` | + no-op guard + brandSale syntéza | **100,0000 %** | **0** | **0** |

`okfish failures: 0`, `NEXUS výjimek: 0`, produktů s víc příznaky současně: **0**
(tedy žádná klasifikace není nejednoznačná).

### 3.1 Rozdíly podle PŘÍČINY

| Příčina | naive | with-limits | Poznámka |
|---|---|---|---|
| `LIMIT_SOURCE` (skládání `PRODUCT_LIMITS`) | 2 071 / 216 prod. | 0 | zmizí, jakmile NEXUS limity dostane |
| `BRAND_SALE_MISSING` | 164 / 35 prod. | 164 / 35 prod. | **zůstává — chybí logika, ne data** |
| `NOOP_ACTION` | 0 | 0 | viz §4.1 — mezera v pokrytí, ne důkaz nepřítomnosti |
| `CLEARANCE_WINDOW` | 0 | 0 | 1 kód (`3963P-S`) má okno neaktivní, ale limit ani tak nerozhoduje |
| `VALIDATION_DIVERGENCE` | 0 | 0 | |
| `ROUNDING_CENT` | 0 | 0 | **Decimal vs Decimal — obě strany používají stejnou aritmetiku** |
| **`UNCLASSIFIED`** | **0** | **0** | **žádný nevysvětlený rozdíl** |

`LIMIT_SOURCE` rozpad podle zdrojového JSON: `zero-discount` 205 produktů, `clearance` 9,
`override` 2.

### 3.2 Konkrétní příklady

**`LIMIT_SOURCE` (naive) — nejdražší případy, HONDA se zero-discount limitem:**

| Kód | tier | base | okfish | NEXUS | Δ |
|---|---|---|---|---|---|
| 99694 | ZR25 | 6 830,00 | 6 830,00 | 5 122,50 | **−1 707,50 €** |
| 99695 | ZR25 | 6 830,00 | 6 830,00 | 5 122,50 | −1 707,50 € |
| 99697 | ZR25 | 6 730,00 | 6 729,99 | 5 047,50 | −1 682,49 € |
| 112824 | ZR4 | 9,90 | 9,90 | 9,50 | −0,40 € |

Tohle je přesně ten scénář, proti kterému vznikl `zero-discount-products.json`: motory HONDA
nesmí dostat žádnou slevu. NEXUS bez složených limitů by na ZR25 prodával motor o 1 707 € levněji.

**`BRAND_SALE_MISSING` (with-limits) — zůstává i po dodání limitů:**

| Kód | tier | base | značka | okfish | NEXUS | Δ |
|---|---|---|---|---|---|---|
| 93904 | ZR4 | 79,95 | DELPHIN | 67,96 | 76,75 | **−8,79 €** |
| 93902 | ZR4 | 69,95 | DELPHIN | 59,46 | 67,15 | −7,69 € |
| 56331 | ZR4 | 119,99 | MIVARDI | 107,99 | 115,19 | −7,20 € |
| 55907 | ZR8 | 12,99 | MIVARDI | 11,69 | 11,95 | −0,26 € |
| 39786 | ZR14 | 2,30 | DELPHIN | 1,95 | 1,98 | −0,03 € |

Rozdělení 35 dotčených produktů: **DELPHIN 20, MIKADO 8, MIVARDI 7.**
Rozdíl je největší na ZR4 a s rostoucím tierem se zmenšuje — od ZR16 výš loyalty brandSale
přebije a shoda se vrátí. Proto se projeví jen na 6 z 10 tierů (ZR4–ZR14).

Pozor na směr: NEXUS počítá **dražší** cenu než okfish. Kdyby se přepnulo dnes, zákazníci
v nižších tierech by u DELPHIN/MIVARDI/MIKADO zaplatili víc, než mají — a e-shop by přestal
plnit celoroční brandovou akci.

### 3.3 „Neznámé" rozdíly: **nula — a je to dokázané, ne odhadnuté**

`UNCLASSIFIED = 0` by samo o sobě nic neznamenalo, kdyby byla klasifikace příliš benevolentní.
Proto harness počítá **třetí kontrolní režim `adapted`**: NEXUS chain dostane přesně ty čtyři
kusy logiky, které mu podle §3.1 chybí (no-op guard, brandSale syntéza, složené `PRODUCT_LIMITS`
s clearance oknem) — a nic víc.

**Výsledek: 167 580 / 167 580 = 100,000000 %, reziduum 0.**

Tím je dokázáno, že rozdíly v `naive`/`with-limits` vysvětlují právě ty čtyři chybějící kusy
a **nic jiného**. Kdyby v NEXUS chainu byl skutečný bug, `adapted` by 100 % nedal. Nedal by ho
ani při chybě v zaokrouhlování — a §3.3 bod 1 návrhu očekával rozdíly ±0,01 €. **Nenastaly:**
root engine i NEXUS chain používají shodně Decimal.js `toDecimalPlaces(2)`, takže haléřová
třída je prázdná. Rozdíl v zaokrouhlování existuje jen mezi root a **worker** enginem (§2.2).

`adapted` NENÍ implementace chybějící logiky — žije v `tools/shadow/adapters.ts` jako kontrola
poctivosti. Skutečná implementace patří podle §4.8 do adapteru v `connectors/`, a harness tuhle
návrhovou otázku záměrně nerozhoduje.

---

## 4. Kde harness NEPOKRÝVÁ, co by měl

Poctivý seznam. Nic z toho není zamlčené v číslech výše.

### 4.1 `NOOP_ACTION = 0` neznamená, že no-op actionPrice neexistují

V dnešním feedu **není ani jeden** produkt s `actionPrice >= price` (ověřeno: 7 708 produktů má
actionPrice, z toho 0 no-op). Guard tedy nemá co chytat.

Jenže: **root engine v produkci bere `actionPrice` ze Shoptet API** (`ProductsReader` →
`item.price.actionPrice.price`), ne z feedu. Incident 2026-08-05 (LOWRANCE 111139,
`actionPrice == price == 1167,20`) se stal právě tam. Feed může být „čistý", zatímco API
no-op hodnotu nese. **Harness tenhle rozdíl nemůže vidět bez tokenu** — a token mít nesmí.

Závěr: `NOOP_ACTION = 0` platí **pro feed**, ne pro produkci. Guard v NEXUSu je nadále nutný
a před přepnutím se musí ověřit proti API datům (nebo v shadow Fázi 1 přes worker/KV cestu).

### 4.2 Vstupní data nejsou 100% totožná s produkcí

Root engine v produkci čte `basePrice`/`actionPrice`/`productMaxDiscount` ze Shoptet **API**
(pricelist item), harness je bere z **feedu**. Harness proto neměří „co by sync dnes zapsal
do Shoptetu", ale „jak se enginy zachovají nad stejným vstupem" — což je přesně otázka P3/P2,
ale není to end-to-end ověření sync výstupu.

Věrně replikováno je: `productMaxDiscount` z `PRODUCT_LIMITS` (ne z feedu), `manufacturer` z feedu
(stejná cesta jako `loadManufacturerMap`), hardcoded `allowLoyaltyDiscount: true` pro root engine.

### 4.3 `products.csv` v repu je pro tenhle účel NEPOUŽITELNÝ

Ověřeno prakticky: běh P3 nad `products.csv` (3 000 produktů) dal **100,0000 % shodu, 0 rozdílů**.
To je **falešná shoda** — soubor má jen 12 sloupců a **chybí mu `manufacturer`, `categoryText`
i `applyLoyaltyDiscount`**. Bez nich se nenapojí brandLimity, brandSale ani loyalty guard,
takže obě strany počítají tutéž zjednodušenou cenu.

Přesně před tímhle varuje §3.3 bod 5 návrhu. **Kdyby se shadow pustil nad `products.csv`,
vykázal by 100% shodu a nenašel by ani jeden ze 4 nálezů P3.** Harness ho proto používá
jen jako poslední fallback a hlásí zdroj dat v každém výstupu.

### 4.4 Co se neměří vůbec

- **P1 (real-time badge)** — neběželo. Worker mini-engine se v P3 porovnává proti root enginu,
  ale NEXUS proti němu nemá protějšek (nemá worker-sémantiku: fallback při neplatné basePrice,
  integer-cents, parsing z KV řádku).
- **Coupon vrstva** (`CouponPolicyRule`) — mimo scope, viz §4A.3 návrhu. Otevřené INC-011/012.
- **Clearance datová okna v čase** — běh proběhl k jednomu datu. Aktivní okno má dnes 39 ze 40
  clearance kódů, neaktivní 1 (`3963P-S`). Podmínka §4.6 („≥ 1 běh po reálné změně
  `clearance-sale-products.json`") **není splněna**.
- **Kritéria objemu z §4.6** — proběhl 1 běh, ne 3 po sobě jdoucí přes ≥ 7 dní.
- **Kategoriální limity** — produkce má 0 `categoryLimits`, větev je mrtvá i tady.

---

## 5. Co z toho plyne pro migraci

1. **Nejdůležitější nález není o migraci, ale o dnešní produkci.**
   `ALLOW_LOYALTY_DIVERGENCE` (§2.1) je živý rozpor mezi cenou v badge a cenou v ceníku,
   až 1,50 € na kus. Existuje bez ohledu na NEXUS a měl by se opravit v okfishi — buď
   protažením `applyLoyaltyDiscount` do root enginu (stejnou cestou jako `manufacturer`),
   nebo vědomým rozhodnutím, že to pole se ignoruje, a jeho odstraněním z worker enginu.
   Dokud existují dva enginy, tenhle typ chyby se bude vracet.

2. **NEXUS cenové jádro je prokazatelně v pořádku.** `adapted` režim dal 100,000000 % na
   167 580 kombinacích, reziduum 0. Chybějící kusy nejsou bugy v Rules — je to **konfigurační
   a transformační vrstva, která zatím neexistuje**. Migrace tedy není o přepisování cenové
   matematiky, ale o dopsání adapteru.

3. **Rozdíly mají velmi nerovnoměrnou váhu.** Skládání `PRODUCT_LIMITS` se týká 216 produktů,
   ale jeden z nich (HONDA motor na ZR25) by byl podprodaný o 1 707 €. brandSale se týká
   35 produktů s rozdílem do 8,79 €. Priorita implementace: **`PRODUCT_LIMITS` skládání první**,
   brandSale druhé.

4. **§3.3 bod 1 návrhu se nepotvrdil — a to je dobrá zpráva.** Očekávané haléřové rozdíly
   Decimal vs integer-cents mezi NEXUSem a root enginem **nenastaly** (obě strany Decimal).
   Tolerance `ROUNDING_CENT` pro P2 tedy není potřeba; §4.6 může u batch cesty vyžadovat
   přesných 100 %. Pro P1 (worker) to neplatí — tam se ±0,01 € projeví (§2.2).

5. **Před dalším krokem chybí ověřit no-op actionPrice proti API datům** (§4.1). Je to jediný
   ze čtyř chybějících kusů, jehož dopad harness **nedokázal změřit**, protože ho ve feedu nelze
   vidět. Neznamená to, že je bezvýznamný — znamená to, že jeho velikost neznáme.

6. **Doporučené pořadí zůstává jako v §6 návrhu**, s jednou úpravou: bod „P3 offline" je hotový,
   ale otevírá produkční nález, který podle mě patří vyřešit **před** dopisováním adapteru —
   jinak se do NEXUSu bude portovat chování, o kterém ještě není rozhodnuto, které z dvou
   je správné.

---

## 6. Reprodukce

```bash
# P3 -- okfish sám se sebou (14 s)
tools/shadow/run.sh p3 --out /tmp/p3.json

# P2 -- NEXUS vs okfish, tři režimy (32 s)
tools/shadow/run.sh p2 --out /tmp/p2.json

# offline nad staženým feedem, bez sítě
tools/shadow/run.sh p3 --offline --feed /tmp/okfish_master_feed.csv

# testy harnessu
npx vitest run tests/regression/shadow
```

Soubory: `tools/shadow/{run.sh,feed.ts,okfishConfig.ts,okfishEngines.ts,adapters.ts,
p3-okfish-selfcheck.ts,p2-nexus-vs-okfish.ts}`, testy `tests/regression/shadow/shadow-harness.test.ts`.

Testy po tomto běhu: **864/864 zelených** (3× po sobě, žádná flakiness). Z toho 26 nových
testů harnessu; zbytek beze změny.
