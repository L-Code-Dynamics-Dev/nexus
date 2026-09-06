# Pricing Shadow Migration — návrh shadow režimu pro migraci okfish → NEXUS

**Status:** NÁVRH — čeká na schválení Lucky. Žádný produkční kód nenapsán.
**Datum:** 2026-09-07
**Rozhodnutí Lucky (2026-09-07):** NEXUS počítá ceny PARALELNĚ vedle okfish enginu, výsledky se porovnávají, rozdíly logují. Nic ostrého se nemění, žádné produkční zápisy. Přepnutí se řeší až po čistém shadow běhu.

**Zdroj pravdy pro analýzu:** čerstvý klon `hlancaric-ship-it/okfish-pricing-engine` v `/Users/lucky/.claude/jobs/99e48aa8/tmp/okfish-live` (HEAD `3a910e2`). Lokální kopie `~/okfish-pricing-engine` je 200 commitů pozadu a byla použita jen pro první čtení — viz §0.

---

## 0. Co bylo přeověřeno proti živému klonu

Před opravou zadání jsem četl ze zastaralé kopie `~/okfish-pricing-engine`. Vše podstatné jsem znovu ověřil `diff` proti živému klonu:

| Soubor | Výsledek |
|---|---|
| `cloudflare-worker/src/engine/pricing.ts` | **IDENTICKÝ** |
| `cloudflare-worker/src/engine/config.ts` | **IDENTICKÝ** |
| `cloudflare-worker/src/shoptet-api/pricing-bridge.ts` | **IDENTICKÝ** |
| `src/core/PricingEngine.ts` | **IDENTICKÝ** |
| `ZR4.csv`, `ZR25.csv` | **IDENTICKÉ** |
| `cloudflare-worker/src/index.ts` | **LIŠÍ SE** — přečteno znovu z živého klonu |

Rozdíl v `index.ts` se cenové matematiky netýká: přibyla in-memory cache `active_customer_version` (KV úspora), odebral se `/dashboard` a `/v1/sync-stats`, přibyl `/v1/products/feed-hash` a `/v1/price-cache/:pricelistId`, feed vrací 503 při nedostupném R2. Endpoint `/v1/product-discount/:code/:tier` je v obou verzích shodný. **Cenové jádro se za těch 200 commitů nezměnilo** — commity jsou z drtivé většiny `chore: aktualizace času poslední synchronizace [skip ci]` plus KV/perf optimalizace.

Poslední incident v živém repu je INC-016 (2026-09-05) — stejný jako v lokální kopii. Otevřené a nedořešené zůstávají **INC-011** (kupónová pole napříč katalogem nespolehlivá) a **INC-012** (kupónová rekonciliace false-positive).

---

## 1. Co okfish reálně umí

### 1.1 Dva nezávislé cenové enginy (klíčové zjištění)

okfish nemá jeden engine, ale **dva, které počítají cenu odlišným kódem**:

**A) Root engine** — `src/core/PricingEngine.ts` + `src/policies/*.ts`, Decimal.js.
Volá ho `cloudflare-worker/src/shoptet-api/pricing-bridge.ts` → `calculateProductsPricing()` → `sync-orchestrator.ts`. Tohle je **batch cesta**: cron 5× denně (`12 6,10,14,18,22 * * *`) přepočítá katalog a zapíše ceny do Shoptet ceníků přes API.

**B) Worker mini-engine** — `cloudflare-worker/src/engine/pricing.ts` → `calculateAllTierPrices()`, nativní `number`, žádný Decimal.
Volá ho endpoint `GET /v1/product-discount/:code/:tier`. Tohle je **real-time zákaznická cesta**: frontend `vip_detail.js` na detailu produktu volá worker a vykreslí VIP badge se slevou.

Oba enginy čtou stejné `policy-v1.json`, ale mají **odlišnou implementaci i odlišné vstupy** (A čte produkty ze Shoptet API, B čte řádek z KV `product:${code}`). Historie souborů je plná fixů typu „stejný bug opraven potřetí v třetím enginu".

### 1.2 Cenová pravidla (živý stav)

- **Loyalty tiery:** ZR4, ZR6, ZR8, ZR10, ZR12, ZR14, ZR16, ZR18, ZR20, ZR25 (ratio 0.04–0.25). Zdroj `src/config/policies/policy-v1.json`. `ZR*.csv` v rootu jsou jen 2řádkové testovací fixtures, ne produkční data.
- **HighestDiscount:** vybírá nižší z {actionPrice, basePrice × (1 − tierRatio)}.
- **No-op actionPrice guard:** `actionPrice >= basePrice` → považuje se za neexistující. (INC z 2026-08-05, LOWRANCE 111139.)
- **brandSaleDiscounts:** DELPHIN 0.15, DELPHIN BOMB 0.15, MIVARDI 0.10, MIKADO 0.09 — **syntetizuje** actionPrice, ale jen když produkt žádnou vlastní nemá. Existující sale se nikdy nepřepíše.
- **DiscountLimit:** hierarchie Product → Brand → Category. 33 brandLimits, **0 categoryLimits** (kategorie jsou dnes prázdná větev).
- **Sale-wins pravidlo:** je-li aktivní limit A zároveň existuje actionPrice, actionPrice je autoritativní — cap ji nezvedne, hlubší loyalty ji nepřebije. Klientský požadavek, INCIDENTS "2026-08-04 VAGNER".
- **PRODUCT_LIMITS** se skládá ze tří JSON souborů, merge v tomto pořadí: `zero-discount-products.json` (0 %) → `clearance-sale-products.json` (22/30 % výprodej, s volitelným datovým oknem `validFrom`/`validTo`) → `product-max-discount-overrides.json`. Konflikt mezi soubory shodí module load (Stage 1 validace).
- **`row['maxDiscount']` z feedu se ZÁMĚRNĚ NEČTE** — to pole obsahuje kupónový „room", ne cenový strop. Čtení způsobilo živý incident 2026-08-05 (kód 106645).
- **allowLoyaltyDiscount:** `"1"|"true"|"yes"|undefined` → povoleno. Jen explicitní jiná hodnota vypne.
- **Zaokrouhlení:** 2 desetinná místa. Worker engine používá integer-cents math (`applyPercent`), aby se vyhnul float chybě typu `4.3 * 0.75 = 3.2249999…`.
- **Coupon policy:** oddělená vrstva, `coupon-policy.json` (defaultMaxDiscount, lockedTiers, disabledBrands, disabledProducts s datovými okny). Needituje cenu, jen eligibility.
- **Množstevní slevy:** okfish je **NEMÁ**. Žádný quantity-tier kód v repu.
- **Clearance datová okna** se vyhodnocují jednou při module load — dlouhoběžící Worker isolate může vidět zastaralé okno mezi deploymenty (známé, akceptované omezení, popsané v `config.ts`).

### 1.3 Kde cena skutečně běží — webhooky, GitHub Actions, Worker

Lucky upřesnil: „to jsou webhooky". Ověřeno v živém klonu — a skutečnost je ještě příznivější, než ta poznámka naznačuje.

**Webhook handler cenu vůbec nepočítá.** `POST /v1/webhook/shoptet` (index.ts:301) dělá přesně tohle:
1. ověří HMAC-SHA1 podpis (`Shoptet-Webhook-Signature`), nevalidní → 401,
2. rozparsuje payload a pokusí se najít `code`,
3. `ctx.waitUntil(triggerGithubSync(...))` — odpálí GitHub `repository_dispatch`,
4. vrátí `{ok:true}`.

Musí stihnout ack do **4s timeoutu Shoptetu**. Registrované eventy: `order:create`, `order:update`, `product:create`, `product:update` (posledních dvou `sendPayload:"full"`, ale reálný tvar payloadu **není potvrzený** — kód to sám přiznává a hádá tři možná umístění `code`).

**Skutečný cenový výpočet běží v GitHub Actions**, ne ve Workeru. `sync.yml` se spouští z `repository_dispatch` (typ `shoptet-webhook`), hodinového cronu jako záložky, nebo ručně. Tam běží `scripts/run-real-sync.ts` → `SyncOrchestrator` → `calculateProductsPricing()` (root engine) → zápis do Shoptet ceníků. `concurrency: shoptet-sync-job, cancel-in-progress: false`, timeout 60 min.

**Worker mini-engine** (`calculateAllTierPrices`) běží jen v `/v1/product-discount/:code/:tier` — a to **JE** synchronní zákaznická cesta (frontend `vip_detail.js` na ni čeká při vykreslení badge).

Shrnuto:

| Cesta | Kde běží | Zákazník čeká? | CPU limit Workeru? |
|---|---|---|---|
| Batch ceník (root engine) | GitHub Actions runner | Ne | **Ne** — běžný Node, 60 min |
| Webhook handler | CF Worker | Shoptet čeká (4 s) | Ano — ale **necení** |
| Badge (worker mini-engine) | CF Worker | **Ano** | Ano |

**Důsledek pro shadow — tohle je dobrá zpráva:**

- Body 3 a 4 z Luckyho doplnění (`waitUntil`, CPU limit Workeru) **se na cenový výpočet nevztahují**, protože ten ve Workeru neběží. `ctx.waitUntil` už okfish používá (index.ts:325 webhook, index.ts:526 feed generation) — ale pro GitHub dispatch a feed, ne pro ceny.
- Shadow pro **batch cestu (P2)** patří do GitHub Actions, ne do Workeru. Tam je CPU limit 60 minut místo pár desítek milisekund a pád jobu neohrozí žádnou objednávku.
- Do webhook handleru **není důvod sahat vůbec** — nic tam k porovnání není.

**Body 1 a 2 z Luckyho doplnění platí i tak, jen jinde:** kritická věc, kterou nesmím rozbít, není HTTP odpověď, ale **dokončení sync jobu**. Když shadow shodí `sync.yml`, neproběhne zápis cen do Shoptetu. To je stejně zlé jako ztracená objednávka.

**Idempotence:** webhook je idempotentní bezpečně — opakované doručení jen znovu odpálí `repository_dispatch`, a `concurrency: shoptet-sync-job` souběh serializuje. Sync sám je diff-based (`RemotePriceCache`, `processDiff`), takže opakovaný běh nad nezměněnými daty nezapíše nic. Shadow tenhle model nesmí narušit — proto **nesmí psát do `.sync_state.json` ani do žádného stavu, ze kterého sync čte**.

### 1.4 Shoptet REST API — co okfish reálně volá

Lucky: „okfish má REST API". Ověřeno — `cloudflare-worker/src/shoptet-api/client.ts`.

**Autentizace:** `Shoptet-Private-API-Token` header, base URL `https://api.myshoptet.com/api`. **Není to OAuth** — je to privátní API token. Uložený jako GitHub secret `SHOPTET_PRIVATE_API_TOKEN`, injektovaný do `sync.yml` jako env. Token drží GitHub Actions, **ne Worker** — Worker sám do Shoptet API nepíše (má jen `CF_WORKER_TOKEN` pro vlastní auth).

**Čtecí operace:** `getPricelists`, `getPricelistItems`, `getPricelistItemByCode`, `getPricelistProducts`, `getCustomers`, `getCustomerDetail`, `getCustomerGroups`, `getCustomerOrders`, `getProductDetail`, `getAllOrders`, `getOrdersByChangeTime`, `getOrderChanges`, `getProductChanges`, `getCustomerChanges`, `getAvailabilities`.

**Zápisové operace — přesně 5 PATCH endpointů:**

| Metoda | Co dělá |
|---|---|
| `updatePricelistBatch` | ceny + actionPrice do ceníku |
| `updatePricelistSalesBatch` | `discountCoupon` (bool) + `minPriceRatio` — kupónová pole |
| `updateNegativeStockAllowed` | povolení záporného skladu |
| `updateStockoutBehavior` | chování při vyprodání |
| `updateCustomerGroup` | přiřazení zákazníka do ceníku/skupiny |

**Žádný POST, PUT ani DELETE. Všechno jsou PATCH.**

**Rate limity:** vlastní `ShoptetRateLimiter` — `maxConcurrency 3`, `maxRetries 15`, exponenciální backoff 1 s → 60 s, retryable statusy `{429, 500, 502, 503, 504}`. Mimo ně a mimo `passThroughStatuses` → throw. Po zápisu se dělá **okamžitá post-write verifikace** čtením zpět (`getPricelistItemByCode`) — reakce na INC-016, kde Shoptet Premium potvrdil, že „HTTP 200 nestačí".

**Použitelnost pro voucher — POZOR, tady je návrh Digital-Voucher.md §6.3 optimistický:**

`grep` na `createCoupon`, `/coupons`, `couponCode` nenašel **žádné zakládání kupónů**. Jediná zmínka je frontend `vip_cart_coupon_lock.js`, který kupónové pole v košíku vizuálně **zamyká** pro ZR20/ZR25.

Kupónová vrstva okfishe je dnes: `discountCoupon: bool` + `minPriceRatio` jako **atributy položky ceníku** — tedy „smí se na tenhle produkt v tomhle tieru uplatnit kupón a do jaké výše", nikoli generování kódu.

Takže: **okfish API scope na zakládání jednorázových kupónů dnes prokazatelně nesahá.** Jestli to Shoptet API vůbec umí, z tohohle repa **NELZE zjistit** — `shoptet_openapi.json` v repu je, ale neověřoval jsem v něm existenci coupon endpointů; a i kdyby existovaly, současný privátní token nemusí mít potřebný scope. **NEOVĚŘENO** — před slibem „okfish umí generovat vouchery" je nutné ověřit v Shoptet API dokumentaci existenci endpointu a otestovat scope stávajícího tokenu na staging.

### 1.5 Tenanti s API vs. bez API

| | **okfish (má API)** | **hecmania (nemá API)** |
|---|---|---|
| Cenová data | čte přes REST API | scraping / feed |
| Zápis cen | `PATCH /pricelists/{id}` | nelze — jen frontend přepis |
| Kupónová pravidla | `discountCoupon`/`minPriceRatio` na ceníku, serverová pravda | kupón omezený na kategorii, frontend JS |
| Zákazník→tier | `updateCustomerGroup` přes API | ruční / JS lookup |
| Ověřitelnost | post-write read-back | žádná |
| Voucher (budoucí) | **kandidát** na serverové řešení, ale endpoint NEOVĚŘEN | JS injection nouzovka |

**Důsledek pro NEXUS:** connector vrstva musí mít dvě implementace stejného kontraktu — `ShoptetApiConnector` (okfish) a `ShoptetFrontendConnector` (hecmania). Cenové Rules v `domains/pricing/` o tomhle rozdílu **nesmí vědět vůbec** — jinak zopakujeme single-tenant chybu, kvůli které NEXUS vznikl. Pro shadow to znamená, že se porovnává výstup Rules, ne způsob doručení.

**Důsledek pro shadow — zpřísnění bariéry:** protože sync **prokazatelně zapisuje do živého e-shopu** 5 PATCH endpointy, nesmí shadow větev nikdy provést zápisové volání. Řeším to tak, že shadow **nedostane token vůbec** (§4.5), ne tak, že bych se spoléhal na `if`.

### 1.6 Vstupy / výstupy

**Real-time cesta:**
`GET https://shoptet-vip-worker.hlancaric.workers.dev/v1/product-discount/:code/:tier` — veřejný, bez auth.
Response: `{ v: 1, code, tier, price, standardPrice, discountPct }`.
Data: KV `product:${code}` (fallback `product:${activeVersion}:${code}`), pole `code` se dopisuje ručně po načtení.

**Batch cesta:** `calculateProductsPricing(products, pricelists)` → `{ results: [{code, prices: {ZR4: "12.7000", …}, brandSaleActionPrice?}], failures: [{code, tier, reason}] }`. Cena jako string `toFixed(4)`.

**Kde běží:** Cloudflare Worker `shoptet-vip-worker` (+ staging `shoptet-vip-worker-staging`), KV `VIP_KV`, R2 `shoptet-feed-bucket`. Napojení na Shoptet: přes REST API (zápis ceníků) + frontend JS injectovaný do šablony.

---

## 2. Co umí NEXUS

`createNexusPricingCalculator.ts` staví chain **BasePrice → HighestDiscount → DiscountLimit → Rounding**, plus runtime guard na neznámý `customerTier`. Validace je záměrně mimo chain (stejně jako legacy).

Rules v `domains/pricing/`:

| Rule | Stav |
|---|---|
| BasePriceRule | zapojena v chainu |
| HighestDiscountRule | zapojena, logika 1:1 s legacy |
| DiscountLimitRule | zapojena, Product→Brand→Category + sale-wins |
| RoundingRule | zapojena, `toDecimalPlaces(2)` |
| ValidationRule | mimo chain, volá se explicitně |
| CouponPolicyRule | **NEZAPOJENA** — samostatná eligibility vrstva |
| VoucherCouponRule | **NEZAPOJENA** — port z Desktop doplňku |
| QuantityTierRule | **NEZAPOJENA** — okfish ekvivalent nemá |
| BestCandidatePriceRule | **NEZAPOJENA** — N-way výběr kandidátů |
| XPlusXRule | **NEZAPOJENA** — promo, okfish ekvivalent nemá |

`connectors/pricing-engine/legacy/` obsahuje 1:1 port root enginu (core, policies, coupon, voucher, csv, promo) — proti němu se testuje parita.

Golden testy `tests/regression/golden-pricing/`: 7 fixtures × 10 tierů = 70 kombinací, `full-chain-parity.test.ts` porovnává per-SKU (finalPrice, rejected, appliedRules) legacy vs NEXUS chain. Fixtures pokrývají: normal, sale-overrides-loyalty, brand-limit, category-limit, product-limit, rounding, invalid-price.

---

## 3. ROZDÍLOVÁ ANALÝZA

### 3.1 Co okfish umí a NEXUS ne

| Chybí v NEXUSu | Dopad |
|---|---|
| **brandSaleDiscounts (syntéza actionPrice)** | KRITICKÉ. DELPHIN/MIVARDI/MIKADO — NEXUS nedostane actionPrice a spočte plnou loyalty cenu. Rozdíl na tisících produktů. |
| **No-op actionPrice guard** (`actionPrice >= basePrice` → undefined) | KRITICKÉ. NEXUS vezme leftover actionPrice jako platnou a zablokuje loyalty. |
| **PRODUCT_LIMITS skládání ze 3 JSON** + Stage 1 konfliktní check | VYSOKÉ. NEXUS bere `productMaxDiscount` jako hotový vstup, neumí ho složit. |
| **Clearance datová okna** (`validFrom`/`validTo`) | VYSOKÉ. Časově omezené výprodeje NEXUS nevyhodnotí. |
| **Worker mini-engine cesta** (`calculateAllTierPrices`) | VYSOKÉ. NEXUS portoval jen root engine. Real-time badge nemá NEXUS protějšek. |
| **Integer-cents `applyPercent`** | STŘEDNÍ. NEXUS má Decimal.js (přesnější), ale to znamená, že se **liší od workeru** na hraničních haléřích. |
| **Fallback při neplatné basePrice** (worker vrací basePrice pro všechny tiery místo odmítnutí) | STŘEDNÍ. NEXUS/legacy validace odmítne, worker vrátí cenu. |
| **allowLoyaltyDiscount parsing z CSV řetězce** | STŘEDNÍ. NEXUS bere boolean, parsing `"1"/"true"/"yes"/undefined` chybí. |
| **Napojení na data** (KV, Shoptet API, feed) | KRITICKÉ pro shadow — NEXUS nemá žádný connector k okfish datům. |

### 3.2 Co NEXUS umí a okfish ne

- QuantityTierRule (množstevní slevy), XPlusXRule (X+X promo), BestCandidatePriceRule (N-way výběr), VoucherCouponRule (VOUCHER vs COUPON distinkce), PromoGroup/Campaign vrstva.
- Čistší architektura: Rule kontrakt, Decimal.js všude, jeden engine místo dvou.
- **Pro shadow je to irelevantní** — nic z toho se nesmí zapnout, jinak se neporovnává parita, ale nová logika.

### 3.3 Kde se chovají JINAK při stejném vstupu (nejnebezpečnější)

1. **Zaokrouhlení na hraně haléře.** Worker: `Math.round(baseCents × (100−pct) / 100) / 100`. NEXUS: `Decimal.mul().toDecimalPlaces(2)` — default `ROUND_HALF_UP`. **NEOVĚŘENO**, zda se shodují na všech `.x25`/`.x75` případech. Očekávám rozdíly ±0,01 €.
2. **`toFixed(4)` vs `toDecimalPlaces(2)`.** Batch cesta posílá do Shoptetu 4 desetinná místa, worker 2. Porovnávač musí normalizovat, jinak bude 100 % false-positive.
3. **Neplatná basePrice.** Worker → fallback cena, NEXUS → odmítnutí. Rozdíl typu „cena vs žádná cena", ne haléř.
4. **Neznámý tier.** Worker vrátí HTTP 400. NEXUS chain vyhodí runtime guard. Shadow to musí mapovat na „shoda", ne „rozdíl".
5. **Chybějící `manufacturer`.** Bez něj se brand limit vůbec nenapojí (incident 2026-08-06, LOWRANCE). Pokud shadow adapter zapomene manufacturer předat, dostanu falešnou 100% shodu na nekapovaných cenách.

### 3.4 Co NENÍ pokryté golden parity testy

`grep` přes `tests/regression/golden-pricing/*.test.ts` nenašel **žádnou** zmínku o `brandSale`, `BRAND_SALE`, `clearance`, `noop`. Nepokryto:

- brandSaleDiscounts syntéza (0 fixtures)
- no-op actionPrice guard (0 fixtures)
- clearance datová okna (0 fixtures)
- skládání PRODUCT_LIMITS ze 3 souborů (0 fixtures)
- worker mini-engine vs root engine parita (**0 testů — tenhle rozdíl netestuje ani okfish sám**; `tests/pricing-parity.test.ts` v okfish existuje, ale NEXUS proti němu nic nemá)
- categoryLimits reálně (fixture `004-category-limit` existuje, ale produkce má 0 categoryLimits — testuje se mrtvá větev)
- coupon policy interakce s cenou

**70 golden kombinací pokrývá kostru chainu, ne produkční realitu okfishe.**

---

## 4. NÁVRH SHADOW ARCHITEKTURY

### 4.1 Vzor převzatý z `~/shoptet-cart-bypass-poc`

```js
export const CONFIG = { SAFEORDER_SHADOW_MODE: true };
export class ShadowWriteBlockedError extends Error { … }
// ZERO PRODUCTION WRITES BARRIER
console.log("[SHADOW_WRITE_BLOCKED] Attempted to mutate production cart");
```

Princip: jedna konstanta v configu + explicitní bariéra, která pokus o zápis nahradí logem. Přebíráme beze změny, jen s jinými jmény: `NEXUS_PRICING_SHADOW_MODE`, `ShadowWriteBlockedError`, log tag `[NEXUS_SHADOW]`.

### 4.2 Kam se shadow zavěsí

**Doporučení: samostatný shadow Worker, NE zásah do okfish Workeru.**

Důvody:
- okfish je živý produkční systém, kde běží zákaznický badge. Jakýkoli deploy tam je riziko.
- NEXUS Rules jsou ESM/TypeScript s Decimal.js — vtlačit je do okfish bundlu znamená měnit jeho build.
- Rollback samostatného workeru = smazat worker. Rollback in-process změny = redeploy okfishe.

**REVIZE po zjištění §1.3 + §1.4:** původní návrh počítal s tím, že cena se počítá ve Workeru. Není to pravda — batch výpočet běží v GitHub Actions, Worker jen serví badge. Varianty se tím přerovnaly a **doporučení se změnilo na offline replay**.

#### Varianta 0 — OFFLINE REPLAY (nově doporučená jako první krok)

Lucky navrhl zvážit přehrání shadow výpočtu offline. Po ověření dat: **je to nejen možné, ale jednoznačně nejlepší začátek.**

okfish má k dispozici všechna potřebná vstupní data mimo produkci:
- `products.csv` (1,6 MB) a `customers.csv` — feed v repu,
- `MASTER_FEED_URL` — živý CSV feed, veřejně stažitelný, čtení nic neovlivní,
- `.reconciliation_state.json` (237 kB) a `.sync_state.json` — reálný stav posledních běhů,
- `scripts/verify-pricing-bridge-samples.ts` a `cli/backfill-reconciliation-drift.ts` — **už existující vzory**, jak pustit `calculateProductsPricing` offline nad reálnými daty,
- `cli/reconcile-pricelist-drift.ts` — už dnes dělá „přepočítej a porovnej proti tomu, co je v Shoptetu", což je přesně shadow vzor.

Běh: samostatný Node skript **v NEXUS repu** (`~/nexus`, nikoli okfish) → stáhne feed → pustí NEXUS chain i legacy port → porovná → zapíše do D1/SQLite.

**Riziko pro živý shop: nulové.** Žádný deploy, žádný zápis, žádný token, žádná změna v běžícím systému. Jediné síťové volání je GET na veřejný feed.

Cena za to: zpětná vazba jen tak často, jak skript pustím — ale při 5 cronech denně stejně nejde o real-time problém.

**Tohle je doporučený start.** Varianty A/B mají smysl teprve tehdy, až offline replay běží čistě a chci pokrýt data, která offline nemám.

#### Varianta A — samostatný shadow Worker (později, jen pro badge cestu)

```
Shoptet frontend ──► okfish Worker /v1/product-discount/:code/:tier
                          │  (odpověď zákazníkovi, NEZMĚNĚNA)
                          └─► [později, Fáze 2] ctx.waitUntil(fire-and-forget POST)
                                    │
                                    ▼
                          nexus-pricing-shadow Worker
                                    │  POST /shadow/compare
                                    │  body: { code, tier, row, okfishResult }
                                    ├─► NEXUS chain výpočet
                                    ├─► porovnání
                                    └─► zápis rozdílu do D1
```

**Fáze 1 (bez jakéhokoli zásahu do okfishe) — TÍMHLE ZAČÍT:**

Shadow Worker si data tahá sám: přečte KV `product:${code}` read-only (stejný namespace, binding jen pro čtení), zavolá veřejný okfish endpoint `/v1/product-discount/:code/:tier`, spočítá NEXUS cenu, porovná. Spouští se **vlastním cronem** nad seznamem kódů z feedu.

Tohle je jediná varianta, kde je **fyzicky nemožné** ovlivnit zákazníka — shadow Worker není v jeho request path vůbec.

Do request path okfishe (`ctx.waitUntil`) se jde až tehdy, když Fáze 1 běží čistě a chceme pokrýt reálný zákaznický traffic místo cronového vzorku.

**Varianta B (proxy před okfishem)** se zamítá: vkládá nový single point of failure přímo mezi zákazníka a cenu.

### 4.3 Co se porovnává

Shadow musí pokrýt **obě okfish cesty odděleně** — nesmí se míchat:

| Porovnání | okfish strana | NEXUS strana | Priorita |
|---|---|---|---|
| **P1** real-time badge | `/v1/product-discount` (`calculateAllTierPrices`) | NEXUS chain + adapter na worker sémantiku | 1 |
| **P2** batch ceník | `calculateProductsPricing` (root engine) | `createNexusPricingCalculator` | 2 |
| **P3** worker vs root | `calculateAllTierPrices` vs `calculateProductsPricing` | — | **0 (nejdřív!)** |

**P3 se musí udělat jako první** a bez NEXUSu. Pokud se okfish neshoduje sám se sebou, nemá smysl měřit shodu NEXUSu — nevím, s čím ho porovnávám.

### 4.4 Kam se logují rozdíly

**D1** — `nexus-pricing-shadow` databáze, tabulka `shadow_comparison`:

```
run_id, ts, path (P1|P2|P3), product_code, tier,
base_price, action_price, manufacturer, product_limit_source,
okfish_price, nexus_price, delta_cents, verdict, mismatch_class
```

`mismatch_class` je povinný — bez klasifikace je 10 000 řádků nepoužitelných:
`ROUNDING_CENT` (|delta| ≤ 0,01) · `BRAND_SALE_MISSING` · `NOOP_ACTION` · `CLEARANCE_WINDOW` · `LIMIT_SOURCE` · `VALIDATION_DIVERGENCE` · `TIER_UNKNOWN` · `UNCLASSIFIED`

Proč D1 a ne Analytics Engine: potřebuju **dotazovat konkrétní SKU** („ukaž mi všechny DELPHIN rozdíly"), ne jen agregované metriky. AE se hodí jako doplněk pro live graf shody, ne jako primární úložiště.

Agregace `shadow_run` (run_id, ts_start, ts_end, compared, matched, match_pct, breakdown JSON) pro rychlý přehled bez skenování detailů.

**Retence:** 30 dní, pak mazat detaily, agregace zůstávají. Bez toho D1 naroste na miliony řádků.

### 4.5 ZERO PRODUCTION WRITES BARRIER

**Lucky: „opatrně, je to živý shop."** Sync přes 5 PATCH endpointů zapisuje ceny reálným zákazníkům. Bariéra proto stojí na odepření prostředků, ne na `if`.

Vrstvená obrana, ne jedna podmínka:

0. **ŽÁDNÝ SHOPTET TOKEN** — nejsilnější vrstva. Offline replay ani shadow Worker nikdy nedostanou `SHOPTET_PRIVATE_API_TOKEN`. `ShoptetApiClient` bez tokenu **hází výjimku už v konstruktoru** (client.ts:119) — shadow tedy fyzicky nemůže zavolat ani čtecí, natož zápisový endpoint. Data si bere z veřejného feedu.
1. **Architektonická** — offline replay běží mimo produkční infrastrukturu úplně. Varianta A: shadow Worker není v zákaznické request path.
2. **Binding-level** — shadow Worker (až na něj dojde) má **jen** `VIP_KV` (čtení) + `SHADOW_DB` (D1 zápis). Žádný `VIP_KV` write, žádný R2 write, žádný Shoptet token.
2b. **Zákaz importu writer vrstvy** — shadow nesmí importovat `pricelist-writer`, `customer-writer`, `coupon-sales-writer` ani `client.ts`. Vynuceno CI testem (bod 5).
2c. **Nedotýkat se sync stavu** — shadow nesmí zapisovat do `.sync_state.json`, `.reconciliation_state.json` ani do KV klíčů, ze kterých sync čte. Zápis jen do vlastní shadow DB. Jinak bych rozbil diff-based idempotenci a vyrobil zbytečné PATCHe.
3. **Kódová bariéra** — každá funkce, která by v budoucnu zapisovala do okfish/Shoptet, začíná:
   ```
   if (CONFIG.NEXUS_PRICING_SHADOW_MODE) {
       console.log('[NEXUS_SHADOW] [SHADOW_WRITE_BLOCKED] ' + action);
       throw new ShadowWriteBlockedError(action);
   }
   ```
4. **Fáze 2 (`ctx.waitUntil`)** — timeout 200 ms na celý shadow blok, `try/catch` kolem všeho, `void` na promise. Odpověď zákazníkovi se sestaví a vrátí **před** startem shadow bloku. Selhání shadow se nikdy nesmí projevit v HTTP statusu.
5. **CI test** — test, který selže, když shadow modul importuje cokoli z okfish writer vrstvy (`pricelist-writer`, `customer-writer`, `coupon-sales-writer`).

### 4.6 Definice „shadow běh je čistý"

Návrh k odsouhlasení Luckym — čísla jsou návrh, ne fakt:

| Kritérium | Práh |
|---|---|
| Objem | ≥ 3 po sobě jdoucí kompletní běhy nad celým katalogem (~7 250 produktů × 10 tierů ≈ 72 500 porovnání/běh) |
| Doba | ≥ 7 dní (pokryje cron cyklus, změny feedu i clearance okno) |
| Shoda přesná | **100 %** ve třídách `BRAND_SALE_MISSING`, `NOOP_ACTION`, `CLEARANCE_WINDOW`, `LIMIT_SOURCE` — tyhle nejsou tolerovatelné, každý výskyt je chybějící logika |
| Shoda haléřová | ≥ 99,9 % `ROUNDING_CENT`, a **každý** zbylý případ ručně vysvětlen |
| `UNCLASSIFIED` | **0** — neklasifikovaný rozdíl znamená, že nerozumím vlastnímu enginu |
| P3 (okfish vs okfish) | vyřešeno nebo písemně akceptováno **před** startem P1/P2 |
| Feed variabilita | ≥ 1 běh po reálné změně `clearance-sale-products.json` nebo `policy-v1.json` |

Rozdíl v cenách zákazníka není „statistika" — 99 % shody znamená ~725 produktů se špatnou cenou. Proto 100 % u logických tříd.

### 4.7 Rollback

| Úroveň | Akce | Čas |
|---|---|---|
| **Varianta 0 (offline)** | **přestat pouštět skript — není co vypínat, v produkci nic neběží** | **0 s** |
| Fáze 1 | `wrangler triggers` — vypnout cron shadow Workeru | < 1 min |
| Fáze 1 | `wrangler delete nexus-pricing-shadow` | < 2 min |
| Fáze 2 | KV feature flag `shadow_enabled=false`, čte se v okfish Workeru s cache | < 1 min, bez deploye |
| Fáze 2 | revert commitu v okfishi + `wrangler deploy` | < 5 min |
| D1 | drop tabulek, dat se nikdo nedrží | kdykoli |

Feature flag ve Fázi 2 je **podmínka**, ne nice-to-have — bez něj je jediná cesta zpět redeploy produkčního workeru.

### 4.8 Co musí být hotové PŘED prvním shadow během

Blokující:

1. **P3 měření** — okfish worker engine vs okfish root engine na celém katalogu. Bez toho neznám baseline.
2. **Doplnit chybějící logiku do NEXUSu** (§3.1) — brandSaleDiscounts, no-op actionPrice guard, PRODUCT_LIMITS skládání, clearance okna. Buď jako nové Rules, nebo jako adapter vrstva. **Rozhodnutí k odsouhlasení: kam patří?** Můj názor — adapter v `connectors/`, ne Rule v `domains/`, protože jde o okfish-specifickou konfiguraci, ne obecné cenové pravidlo. Zadrátovat DELPHIN do `domains/pricing/` by zopakovalo přesně tu single-tenant chybu, kvůli které NEXUS vznikl.
3. **Golden fixtures pro nepokryté případy** (§3.4) — minimálně brandSale, no-op action, clearance okno, 3-zdrojový PRODUCT_LIMITS.
4. **Rozhodnutí o zaokrouhlení** — je Decimal `ROUND_HALF_UP` totožný s worker integer-cents? Buď dokázat testem, nebo přijmout jako známý rozdíl s tolerancí.
5. **Allowlist CI test** (§4A.2) — zelený, než se pustí první běh.
5b. **Read-only KV binding** — týká se až Varianty A, ne offline replaye. **NEOVĚŘENO** — CF KV bindingy nemají nativní read-only flag; pravděpodobně nutný oddělený token s omezeným scope. Ověřit před nasazením Workeru.
6. **Normalizace formátů** — `toFixed(4)` vs 2 desetinná místa, jinak 100 % false-positive.
7. **D1 databáze + migrace + retenční job.**

Neblokující, ale doporučené: dashboard nad `shadow_run` (`match_pct` v čase), alert při propadu shody pod práh.

---

## 4A. Minimální řez: jen pricing

Lucky (2026-09-07): *„napojili bychom zatím price engine na nexusáckej a ostatní moduly zatím klidně necháme vypnuté"*.

### 4A.1 Je `domains/pricing/` skutečně izolované? — ANO, ověřeno

Sesbírané importy **všech** souborů v `domains/pricing/`:

```
decimal.js · fs
../../core/canonical/{entities/Price.js, rules/Rule.js, rules/Decision.js}
../../connectors/pricing-engine/legacy/{coupon, promo, voucher}
./{BasePriceRule, HighestDiscountRule, DiscountLimitRule, RoundingRule, PricingAdapter}
```

**Z jiné domény (`campaign`, `b2b`, `voucher`, `billing`, …) netáhne pricing ani jeden import.** `core/canonical/rules/Rule.ts` a `Decision.ts` táhnou dál jen `entities/base.js` — čisté typové definice, žádná logika, žádná další doména.

Ještě lepší je, že samotný **produkční chain je užší než celá složka**. `createNexusPricingCalculator.ts` importuje pouze `fs`, `decimal.js`, `PricingAdapter` a čtyři Rules. `CouponPolicyRule`, `VoucherCouponRule`, `XPlusXRule` (jediné, co sahá do `legacy/coupon|voucher|promo`) v chainu **nejsou** — jsou to sousední soubory ve stejné složce, ne závislosti.

Závislosti jdou **jedním směrem**: `domains/voucher`, `domains/campaign`, `domains/availability`, `domains/invoice` importují z `domains/pricing`, nikoli naopak. Pro minimální řez je to ideální — pricing lze vzít samotný, ostatní domény se odříznou tím, že je prostě neimportuji. **Nic není potřeba odřezávat.**

### 4A.2 Vypnuté KONSTRUKČNĚ, ne jen nezavolané

Souhlas s Luckyho rozlišením — „nevolá se" je pozvánka k tichému regresu.

**Návrh: samostatný entry point + CI strážce stromu závislostí.** Kombinace, ne jedno z toho.

Feature flag zamítám: modul je pak pořád v buildu, flag lze přepnout, a import z jiné domény by prošel bez povšimnutí.

1. **Samostatný entry point** — `tools/pricing-shadow/entry.ts` v NEXUSu, který importuje **výhradně** `createNexusPricingCalculator` a legacy port. Nikdy nesahá na `domains/*` mimo pricing. Offline replay se pouští jen odsud.

2. **Build-time strom závislostí jako CI test** (tvrdá vrstva). Test rozparsuje graf importů z entry pointu a **selže**, jakmile se v něm objeví cokoli mimo allowlist:
   ```
   ALLOWLIST = [
     'domains/pricing/**',
     'core/canonical/{entities,rules}/**',
     'connectors/pricing-engine/**',
     'decimal.js', 'fs', 'node:fs'
   ]
   ```
   Jakýkoli `domains/campaign/…`, `domains/voucher/…`, `connectors/d1/…` → červené CI. Tohle je jediná vrstva, která **nedovolí omylem zapnout** — přidání importu build shodí dřív, než se něco spustí.

3. **Runtime tripwire** (diagnostika, ne ochrana) — shadow běh zaloguje na startu seznam skutečně načtených modulů (`require.cache` / `import.meta`), a cokoli mimo allowlist zaloguje jako `[NEXUS_SHADOW] UNEXPECTED_MODULE`. Chytá to, co statická analýza nepokryje (dynamický import).

Zdůvodnění výběru: allowlist na stromu závislostí je jediná varianta, která selže **v CI před nasazením**, ne až za běhu. Entry point sám o sobě je konvence, kterou lze porušit; CI test tu konvenci vynutí.

### 4A.3 Co z pricing řetězu okfish reálně potřebuje

| Rule | V chainu? | Potřebuje okfish? | Verdikt |
|---|---|---|---|
| BasePriceRule | ano | ano | OK |
| HighestDiscountRule | ano | ano | OK |
| DiscountLimitRule | ano | ano | OK |
| RoundingRule | ano | ano | OK |
| ValidationRule | mimo chain, volá se explicitně | ano (`pricing-bridge` volá `validateInput`/`validateResult`) | OK, ale musí se v shadow volat stejně |
| **CouponPolicyRule** | **ne** | **ANO** | **CHYBĚJÍCÍ DÍL, ne úspora** |
| VoucherCouponRule | ne | ne (okfish neumí generovat kupóny, §1.4) | mimo scope |
| QuantityTierRule | ne | ne (okfish nemá množstevní slevy) | mimo scope |
| XPlusXRule | ne | ne | mimo scope |
| BestCandidatePriceRule | ne | ne | mimo scope |

**Odpověď na Luckyho bod 3: `CouponPolicyRule` okfishi VADÍ.** Není to úspora — okfish kupónovou logiku aktivně používá a **zapisuje ji do produkce**: `coupon-config.ts` čte `coupon-policy.json` (`defaultMaxDiscount`, `lockedTiers`, `disabledBrands`, `disabledProducts` s datovými okny), `compute-coupon-writes.ts` z toho počítá a `updatePricelistSalesBatch` to PATCHuje do Shoptetu jako `discountCoupon` + `minPriceRatio`.

Uleví tomu jedna věc: kupónová pole jsou **oddělený výstup od ceny**. Cenový shadow (P1/P2) se dá udělat bez nich. Ale:
- „napojit price engine na NEXUS" **nesmí** znamenat, že se coupon vrstva ztratí — dnes to je živý zápis do e-shopu;
- na kupónové vrstvě jsou **otevřené incidenty INC-011 a INC-012**, takže migrovat ji naslepo je obzvlášť špatný nápad.

**Návrh: coupon vrstva zůstane ve fázi 1 na okfishi beze změny**, NEXUS převezme jen cenu. `CouponPolicyRule` se řeší jako samostatná pozdější etapa, až budou INC-011/012 uzavřené. Do té doby je to vědomě označený dluh, ne přehlédnutí.

### 4A.4 Jaké vstupy chain potřebuje a jestli je okfish má

`LegacyPricingInput` (`PricingAdapter.ts`) vyžaduje: `sku`, `basePrice`, `salePrice?`, `productMaxDiscount?`, `customerTier`, `allowLoyaltyDiscount`, `manufacturer?`, `category?`. Konfigurace: `loyaltyTiers`, `brandLimits`, `categoryLimits` z `policy-v1.json`.

| Vstup | Zdroj v okfishi | Dostupné offline? |
|---|---|---|
| `sku` | `code` z feedu / KV | ano |
| `basePrice` | `price`/`priceVat`/`standardPrice` | ano |
| `salePrice` | `actionPrice`/`salePrice` **po** no-op guardu a brandSale syntéze | ano, ale **vyžaduje doplnění logiky** (§3.1) |
| `productMaxDiscount` | složené `PRODUCT_LIMITS` ze 3 JSON | ano, ale **vyžaduje doplnění** |
| `customerTier` | ZR4–ZR25, název ceníku ze Shoptetu / KV lookup e-mailu | ano (tiery jsou v `policy-v1.json`) |
| `allowLoyaltyDiscount` | `applyLoyaltyDiscount` jako string | ano, vyžaduje parser |
| `manufacturer` | feed | ano |
| `category` | `categoryText` | ano (ale 0 categoryLimits — mrtvá větev) |

**Závěr: všechna data jsou offline dostupná z `MASTER_FEED_URL` / `products.csv`.** Zákaznická skupina (e-mail→tier) je pro cenový shadow zbytečná — počítám všech 10 tierů pro každý produkt, což je i tak úplnější než vzorek reálných zákazníků.

Chybějící kusy nejsou data, ale **transformační logika** (§3.1) — patří do adapteru v `connectors/`, ne do Rules.

### 4A.5 Jak ověřit, že ostatní domény neběží

1. **CI (před během)** — allowlist test z §4A.2. Zelený build = v grafu není nic mimo pricing. Nejsilnější důkaz.
2. **Startovní log** — shadow vypíše `[NEXUS_SHADOW] modules: pricing(4 rules) + legacy-port` a explicitně `campaign=OFF voucher=OFF b2b=OFF billing=OFF …`. Když se objeví cokoli jiného, je to na prvním řádku logu.
3. **Runtime tripwire** — `[NEXUS_SHADOW] UNEXPECTED_MODULE <path>` při načtení modulu mimo allowlist.
4. **`appliedRules` ve výstupu** — každý řádek v D1 nese seznam pravidel, která se uplatnila. Očekávané hodnoty: `BASE_PRICE`, `SALE`, `LOYALTY`, `PRODUCT_LIMIT`, `BRAND_LIMIT`, `CATEGORY_LIMIT`, `ROUNDING`. **Cokoli jiného** (`PROMO_GROUP`, `QUANTITY_TIER`, `X_PLUS_X`) = jiná doména zasáhla do ceny. Dotaz nad D1 to najde okamžitě.
5. **Negativní test** — testovací případ, který ověří, že produkt s definovanou PromoGroup/QuantityTier dostane v shadow běhu **stejnou cenu jako bez ní**. Kdyby campaign vrstva prosákla, cena se liší a test spadne.

Bod 4 je nejpraktičtější provozní kontrola: nevyžaduje nic navíc a je vidět v datech, která stejně sbírám.

---

## 5. Otevřené otázky pro Lucky

1. **Kam patří okfish-specifická konfigurace?** Adapter v `connectors/` (můj návrh) vs Rules v `domains/`.
2. **Která cesta se migruje první** — real-time badge (P1, vidí zákazník okamžitě) nebo batch ceník (P2, píše do Shoptetu)? Návrh: P2 shadow první (bezpečnější), ale P1 přepnout dřív (menší dopad při chybě — badge lze schovat, špatnou cenu v ceníku ne).
3. **Prahy v §4.6** — souhlas s 100 % u logických tříd?
4. **INC-011/INC-012** (kupónová vrstva, otevřené) — mimo scope shadow migrace ceny, nebo se řeší současně?
5. **Jde vůbec do okfishe sáhnout?** Po zjištění §1.3 to nejspíš není potřeba — offline replay pokryje batch cestu bez jediného zásahu. Do Workeru by se sahalo jen kvůli badge cestě (P1).
6. **Coupon vrstva** (§4A.3) — souhlas s tím, že zůstane ve fázi 1 na okfishi a NEXUS převezme jen cenu?
7. **Voucher přes okfish API** (§1.4) — návrh Digital-Voucher.md §6.3 předpokládá generování jednorázových kupónů. Dnes to okfish neumí a existence endpointu není ověřená. Má to někdo ověřit, než se na tom staví?

---

## 6. Závěr

Shadow režim je **proveditelný a nic zásadního ho neblokuje**. Po ověření proti živému klonu je riziko dokonce **výrazně nižší**, než návrh původně předpokládal:

- Cenový výpočet **neběží ve Workeru** na zákaznické cestě, ale v GitHub Actions (webhook jen odpálí `repository_dispatch`). Obavy o CPU limit a latenci odpovědi se batch cesty netýkají.
- Všechna vstupní data jsou dostupná offline z veřejného feedu, takže **první shadow běh nemusí sáhnout na produkci vůbec**.
- `domains/pricing/` je prokazatelně izolované — chain táhne jen `decimal.js`, `fs`, čtyři Rules a typy z `core/canonical`. Minimální řez je čistý a nevyžaduje žádné odřezávání.

Co zůstává skutečným problémem, není architektura, ale **obsah**: NEXUS umí kostru chainu, ne produkční realitu okfishe. Chybí mu čtyři kusy logiky (brandSaleDiscounts, no-op actionPrice guard, skládání PRODUCT_LIMITS, clearance okna), které v okfishi vznikly jako reakce na živé incidenty — a golden testy je nepokrývají ani jedním fixture. Bez jejich doplnění by první běh vygeneroval tisíce rozdílů, které nejsou nálezy, ale známý chybějící kód. Navíc `CouponPolicyRule` není zapojená, přestože okfish kupónová pole aktivně zapisuje do e-shopu.

**Doporučené pořadí:**
1. **P3 offline** — změřit, jestli se okfish shoduje sám se sebou (worker mini-engine vs root engine). Nevyžaduje NEXUS, nesahá na produkci, a odpovídá na otázku, kterou dnes nikdo neumí zodpovědět.
2. Doplnit chybějící logiku do adapteru + golden fixtures.
3. Offline replay P2 (batch cesta) nad celým katalogem.
4. Teprve pak zvažovat Worker (P1 badge) a zásah do běžícího systému.

Lucky řekl „opatrně, je to živý shop". Offline replay je jediná varianta, kde to opatrné je doslova — nulový zápis, nulový token, nulový deploy.
