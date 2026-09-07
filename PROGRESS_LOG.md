# NEXUS — Progress Log

## ⚠️ PRO LUCKYHO — PŘEČTI RÁNO JAKO PRVNÍ (7.9. noc)

### Okfish se sám se sebou neshoduje. Týká se to živého e-shopu DNES.

Nález je **nezávislý na migraci do NEXUSu** — je to stav produkce.

**1,13 % katalogu má jinou cenu podle toho, který engine ji počítá.**
Okfish má dva cenové enginy (worker pro badge, root/bridge pro batch ceníky).
Worker `applyPercent` a bridge `Math.round(base*(1-ratio)*100)/100` se
rozcházejí. Bridge nikdy nedostal float-fix, který worker má okomentovaný.

- Změřeno na **49 899 dvojicích: 564 rozdílů**, každý o 1 cent
- Zákazník tedy může vidět na badge jinou cenu, než jaká je v ceníku

Další rozdíly mezi enginy:
- `actionPrice = 0`: worker propustí, bridge zahodí (falsy hodnota)
- `resolveClearancePct` míchá UTC (`validFrom`) a lokální čas (`validTo`)
- clearance okno je **nedeterministické** — `new Date()` při načtení modulu

**Co s tím:** NEXUS se přiklonil k workeru (doloženo na 2,1 mil. dvojicích,
že Decimal ROUND_HALF_UP == integer-cents). Ale rozhodnutí, **který engine
má pravdu**, je tvoje — a oprava toho druhého změní ceny.

### Dvě věci k potvrzení

1. **Strop 0 % se chová jako ŽÁDNÝ strop** — v obou enginech. Je to záměr,
   nebo bug? Natolik neintuitivní, že to nechci považovat za správné bez
   tvého slova.
2. **Clearance okna a `PRODUCT_LIMITS` nejdou ověřit proti produkci** —
   jediný snapshot vypočtených cen vznikl PŘED zavedením těch tří JSON
   souborů (`112824` má dnes strop 0 %, ve snapshotu −24,9 %). Parita je
   jen proti zdrojáku, ne proti reálnému výstupu.

Detaily: `docs/shadow-reports/MISSING-PRICING-LOGIC.md`

---


## 2026-09-07 — Fáze A HOTOVÁ, CI zelené, atomicita OVĚŘENA

Repo: **https://github.com/hlancaric-ship-it/nexus** (privátní),
větev `chore/vitest-4-upgrade` (nemergováno do main).

| Job | Výsledek |
|---|---|
| Node testy | 754/754 |
| TypeScript (root + workers) | čistý |
| **Workers/D1 v workerd runtime** | **19/19** |

### Nález o `batch()` je PROKÁZANÝ, ne odvozený z docs

`tests/workers/schema.test.ts` běžel proti reálné D1 na CI. Výsledek:

```
odectenoMinor: 0,  zapsanychCerpani: 1
```

Batch s konfliktní verzí: UPDATE vrátí `changes === 0`, **oba statementy
hlásí `success: true`**, zůstatek se nezmění — a transakce o čerpání se
**zapíše**. Kontrastní test potvrdil, že skutečná SQL chyba batch rollbackne.
Je to tedy sémantika D1, ne náhoda.

Kdyby čerpání zůstalo jako `db.batch([UPDATE, INSERT])` (tak to napsal
agent), šel by voucher utratit donekonečna — a horší: zabraný unique index
by způsobil, že retry vyhodnotí situaci jako idempotentní replay a vrátí
`consumed: true`. Opraveno v `ca70a5b`.

Ověřeno dále: CHECK constrainty drží, partial unique index funguje
(dva ISSUED s NULL projdou, druhý REDEEMED na stejnou objednávku ne),
optimistický zámek nedovolí lost update, tenant izolace v indexech sedí.

**Status atomického čerpání: NOT PROVEN → OVĚŘENO.**

### Zbývá k Fázi B

1. **Durable Object** pro nonce + rate limit — dnes jen kontrakt v
   `workers/api/types.ts`. Bez něj má `/validate` otevřené dveře pro hrubou
   sílu; jedinou obranou je entropie kódu (§4 rate limit vyžaduje).
2. **Shoptet injector** — selektory ověřené průzkumem (`.discount-coupon form`,
   `data-testid`, `data-micro-sku`, `ShoptetDOMCartContentLoaded`).
3. **Validace instalace v našem UI** (požadavek Lucky) — ověřit kredit produkt,
   kategorii, kupón a nasazený JS; při změně odmítnout čerpání a hlásit.

---

## ZNÁMÝ BLOKÁTOR — Workers/D1 testy nejdou spustit lokálně

**Mac Mini 2014 jede macOS 12.7.6. Cloudflare workerd vyžaduje macOS 13.5+.**

```
Unsupported macOS version: The Cloudflare Workers runtime cannot run on the
current version of macOS (12.6.0). The minimum requirement is macOS 13.5.0+.
```

Není to chyba configu ani testů — ověřeno, že pipeline projde celá až k bodu,
kde miniflare spouští binárku runtime (config se načte, `readD1Migrations()`
proběhne, plugin se zaregistruje, pool nastartuje). `npx tsc --noEmit -p
tests/workers/tsconfig.json` je čistý, typy včetně `cloudflare:test` a
`D1Database` sedí.

**Důsledek:** `tests/workers/schema.test.ts` (19 testů) je hotový, ale
**NEOVĚŘENÝ BĚHEM**. Týká se to i kritického nálezu o `batch()` — dokud
neproběhne, je to hypotéza podložená dokumentací D1, ne důkaz.

**Řešení:** `.github/workflows/test.yml` — job `workers` běží na
`ubuntu-latest`. Do prvního zeleného běhu platí u atomicity kreditu status
**NOT PROVEN**, stejně jako u replay ochrany v `shoptet-cart-bypass-poc`.

Lokálně funguje `npm test` (node testy) bez omezení.

---


## 2026-09-06 — Digital Voucher: návrh uzavřen, Fáze A rozpracovaná

### Stav: větev `chore/vitest-4-upgrade`, NEMERGOVÁNO do main

Commity dnes (nejnovější první):
```
d6eecc8 feat(voucher): CreditVoucher entita + ValidityRule (Fáze A, ČÁSTEČNÉ)
acd3bb2 chore: vitest 2.1.1 -> 4.1.0, Cloudflare test plugin, pinované verze
78201c5 docs: dva nové design proposals -- ERP generic vrstva a Shoptet prémiová šablona
01cbc48 fix(tests): omega-executor-sanity timeout 20s (flaky na pomalém stroji)
e43030a docs: Digital Voucher v3 -- uzavřen bod (c) daňový režim + oprava ERP vrstvy
f92083c docs: Digital Voucher v2 -- uzavřena rozhodnutí (a) atomicita a (b) cesta do košíku
```

Ověřeno: `npx vitest run` → **644/644**, `npx tsc --noEmit` → čistý.

---

### 1. Digital Voucher — návrh UZAVŘEN (v3)

`docs/design-proposals/Digital-Voucher.md`. Všechna tři blokující rozhodnutí padla:

| Bod | Rozhodnutí | Kdo |
|---|---|---|
| (a) Atomicita | **optimistický zámek**, `version` sloupec, DB je autorita. Ne Durable Object. | Lucky |
| (b) Cesta do košíku | **kredit produkt `1 Kč × N ks` + kupón 100 % omezený na kategorii** | Lucky |
| (c) Daňový režim | **víceúčelový poukaz (MPV)** dle § 15b ZDPH | Lucky |

**Mechanismus (b) — jak to funguje, OVĚŘENO NAOSTRO (Lucky):**
1. Zákazník zadá svůj kód z PDF do pole kupónu v košíku
2. Náš JS request odchytí (`preventDefault` + `stopImmediatePropagation` v **capture** fázi)
3. Worker ověří kód proti D1, spočítá `min(zůstatek, košík)`
4. Vloží skrytý kredit produkt `1 Kč × N ks` přes `/action/Cart/addCartItem/`
5. Aplikuje kupón se 100 % slevou **omezenou na kategorii** kredit produktu
6. Shoptet započítá serverově → zobrazená cena = účtovaná cena

**Proč to drží:**
- Zákazníkův kód se do Shoptetu vůbec nedostane
- Kupón nemá cenu ke krádeži — 100 % jen na kredit položku v té kategorii
- Košík dražší než voucher: kupón zabere jen na kredit položku, zbytek zákazník doplatí
- **D1 je jediný zdroj pravdy o zůstatku** — bez platného voucheru se nic neodečte

**Rozdělení autorit:**

| Vrstva | Kdo hlídá |
|---|---|
| kolik smí čerpat | D1 (zůstatek, platnost, atomický odečet) |
| na co smí kupón zabrat | Shoptet (omezení na kategorii) |
| kolik se reálně odečte | Worker na order webhooku |
| zobrazená = účtovaná cena | Shoptet (počítá serverově) |

**Otevřený požadavek (Lucky):** naše UI musí instalaci **validovat a průběžně kontrolovat** —
kredit produkt existuje a stojí 1 Kč, kategorie sedí, kupón je omezený právě na ni, JS nasazený.
Bez toho nejde systém zapnout; při změně odmítnout čerpání a hlásit. Zatím není v návrhu zapsáno.

---

### 2. Fáze A — ROZPRACOVANÁ, 6 agentů spadlo na session limit

**Hotovo a commitnuto (`d6eecc8`):**
- `core/canonical/entities/CreditVoucher.ts` (313 ř.)
- `domains/voucher/CreditVoucherValidityRule.ts`

**CHYBÍ — přesně tohle dopsat:**

| Soubor | Obsah |
|---|---|
| `migrations/0001_credit_voucher.sql` | §3 návrhu; peníze **INTEGER v haléřích** (`*_minor`), ne REAL; `version`; `UNIQUE(voucher_id, order_id) WHERE type='REDEEMED'`; CHECK `current_balance >= 0` |
| `wrangler.jsonc` | D1 binding `DB`, dev + `env.production` (bindingy se do env **nedědí**), `migrations_dir` |
| `vitest.workers.config.ts` + `tests/workers/setup.ts` | `@cloudflare/vitest-plugin` **1.1.4** (ne starý `vitest-pool-workers`), `readD1Migrations` + `applyD1Migrations` |
| `domains/voucher/CreditVoucherRedemptionRule.ts` | `min(zůstatek, košík)`, `now` jako **vstup** (Rule.ts determinismus), `Decimal` ne float |
| `domains/voucher/CreditVoucherLifecycleRule.ts` | přechody přes `evaluateTransition`; **`DEPLETED` NENÍ terminální** (refundace → ACTIVE) |
| `domains/voucher/CreditVoucherStore.ts` | interface + `InMemoryCreditVoucherStore` — vzor `core/idempotency/IdempotencyStore.ts` |
| `workers/api/{index,hmac}.ts`, `routes/voucher.ts` | port z `~/shoptet-cart-bypass-poc/src/` |
| `tests/unit/CreditVoucher*.test.ts` | Rules + Store, české popisky |
| `tests/workers/voucher-{concurrency,adversarial}.test.ts` | souběh, double-spend, adversariální vstupy |

---

### 3. Nálezy z průzkumu, které MUSÍ do kódu

**D1 `batch()` se rollbackuje jen při SQL chybě.** `UPDATE ... WHERE version = ?`,
který nematchne žádný řádek, **není chyba** — batch projde a ostatní statements se
zacommitují. Naivní batch (UPDATE + INSERT transakce) by tedy zapsal transakci
i bez odečtu kreditu → voucher k utracení donekonečna.
**Fix:** nejdřív UPDATE, ověřit `meta.changes === 1`, teprve pak INSERT. Nebo nechat
CHECK constraint shodit celý batch.

**Shoptet selektory** (ověřeno na živých košících cistytriko.cz/Disco + hecmania.cz/Classic):
- `#discount-coupon-form` a `.js-discount-coupon-submit` **NEEXISTUJÍ**
- správně: `.discount-coupon form`, pole `#discountCouponCode`
- kotvit se **výhradně** na `data-testid` a na selektory z bundle `main-3g.js`, nikdy na obalové divy (ty se mezi šablonami liší)
- `data-micro-sku` = stabilní klíč produktu pro slučování `N × 1 Kč` řádků
- **`#continue-order-button` guard**: nevyprázdněné pole kupónu blokuje checkout
- DOM se přepisuje po každém AJAX → překreslovat na `ShoptetDOMCartContentLoaded`, idempotentně
- CSRF povinný na všech `/action/*`
- token do objednávky přes `#remark` (skryté pole s vlastním `name` Shoptet zahodí)

**`core/tenant/types.ts`** má duplicitní `CanonicalEntity`/`TenantId`/`EntityId`
s komentářem "dočasně, než vznikne base.ts" — ten soubor už existuje.
Importovat z `core/canonical/entities/base.js`.

**`VoucherCouponRule` kolize je jen jmenná, ne funkční** — ověřeno: nemá jedinou
produkční call-site, není v `createNexusPricingCalculator`. Zůstává nedotčen
(Non-Interference). Past: legacy VOUCHER dělá `min(value, cartTotal)`, což vypadá
jako částečné čerpání, ale zbytek zahazuje.

---

### 4. Nové dokumenty (commit `78201c5`)

**`docs/design-proposals/ERP-Generic-Layer.md`** — Omega + Pohoda + Money S3:
- `connectors/erp-generic/` prázdný, `Connector.ts` nikdo neimplementuje
- **Pohoda dedupuje server-side, Omega vůbec** → slepý retry = duplicitní faktura
- Omega nemá strojovou odpověď (úspěch z logu regexem) → `confirmationQuality: SYSTEM_CONFIRMED | LOG_INFERRED`
- `taxRate: number` nerozliší osvobozeno/mimo předmět/PDP — dotýká se MPV ("bez DPH" ≠ "0 %")
- `cancel()` do rozhraní nepatří (storno je účetně nový doklad)
- blokátor: `OmegaExecutor` neověřený proti reálnému Windows agentovi

**`docs/design-proposals/Shoptet-Premium-Template.md`** — konfigurovatelná šablona:
- Shoptet **nemá editovatelné server-side šablony** (žádný Twig), HTML nevlastníme
- blank template mode jen na Premium (~12 tis./měs) — blokuje škálovatelnost
- nativní konfigurace = 6 barev + 2 fonty → díra pro náš konfigurátor
- konfigurátor generuje statický `theme.css` → SFTP na shoptetí CDN, produkce nikdy nevolá naši infrastrukturu
- dlaždice primárně **čistým CSS**, ne JS přeskládáním DOM
- rozsah: MVP 12–15 týdnů, plný self-service 22–28 týdnů

---

### 5. Doporučené pořadí (můj názor, ne rozhodnutí)

1. Dokončit Fázi A (seznam výše) — postaví první D1, migrace a worker entry v celém NEXUSu
2. Fáze B na jednom klientovi — ověřit celý řetěz naostro
3. **Až potom** šablona — s reálnou znalostí, co do ní NEXUS potřebuje

NEXUS je dnes ~35 %: doménový model ~85 %, testy ~80 %, ale **runtime/deployment 0 %,
perzistence 0 %, UI 0 %**. Voucher Fáze A je první produkční D1 v repu.
