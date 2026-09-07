# Jak se ceny zapisují do Shoptetu (okfish model)

> ## ⚠️ ČTI NEJDŘÍV ZDROJOVOU DOKUMENTACI
>
> Okfish repo má **3 380 řádků dokumentace**, která tohle všechno popisuje
> přesněji než tenhle souhrn. Než budeš cokoli dovozovat z kódu nebo
> screenshotů, přečti:
>
> | Dokument | Co v něm je |
> |---|---|
> | `docs/ENGINE_BUSINESS_OVERVIEW.md` | proč engine existuje, obchodní logika, poctivé zhodnocení stavu |
> | `docs/CORE_LOGIC_AND_VALIDATION.md` | **přesné pořadí slev** + 5stupňový validační model |
> | `docs/ENGINE_TECHNICAL_TEMPLATE.md` | architektura, dva enginy, sync pipeline |
> | `docs/PROGRESS_LOG.md` | 1 702 řádků historie včetně incidentů |
>
> Plus skill `shoptet-pricing-engine` (Skill tool) — shrnutí a konvence.
>
> **Poučení ze 7.9.:** celou noc jsem dovozoval chování z kódu a screenshotů
> a vyrobil tím dva falešné nálezy. Odpověď byla celou dobu v těch
> dokumentech. Kód ukáže *co* se děje, dokumentace *proč*.


**Zdroj: Lucky, 2026-09-07.** Zjišťování tohohle chování trvalo týden —
proto je to zapsané tady a ne v hlavě. Kdo bude sahat na cenovou logiku
nebo na shadow harness, přečte si to první.

Ověřeno proti produkci (screenshoty z `okfish.sk/admin`, produkty
`93683` Čelovka DELPHIN Compact a `112824` Mletá káva FISHING POINT).

---

## 1. Nativní Shoptet slevy NEPOUŽÍVÁME

**Klíčové a snadno se to přehlédne:** okfish nepoužívá nativní Shoptet
doplněk věrnostních slev. NEXUS/okfish počítá ceny sám a **zapisuje už
hotové výsledky** přímo do ceníků.

Zaškrtávátka u produktu proto vypadají takhle a je to **správně**:

| Pole | Stav | Proč |
|---|---|---|
| Věrnostní sleva | ☐ vypnuto | počítáme my, Shoptet nesmí přidávat navrch |
| Objemová sleva | ☐ vypnuto | totéž |
| Množstevní sleva | ☐ vypnuto | totéž |
| Slevový kupón | ☑/☐ | řídí se per tier, viz §3 |

> **Past, do které jsem spadl:** vypnutá „Věrnostní sleva" NENÍ signál,
> že produkt slevu nedostává. Znamená jen, že ji nepočítá Shoptet.
> Tierové ceny v ceníku jsou náš výstup a jsou platné.

---

## 2. Pole „Maximální povolená sleva" má DVA různé významy

Je to jedno pole, ale jeho smysl závisí na zaškrtnutí:

| Stav | Význam |
|---|---|
| ☑ zaškrtnuto + číslo | max % sleva, kterou smí **KUPÓN** dát na hlavním ceníku **nepřihlášenému** zákazníkovi |
| ☐ nezaškrtnuto + číslo | max % **STROP** na hlavním ceníku pro **nepřihlášeného** |

**Obojí se týká jen hlavního ceníku a nepřihlášeného zákazníka.**
S tierovými cenami (ZR4–ZR25) to nesouvisí — ty drží naše zapsané hodnoty.

Příklad `93683`: ☑ s hodnotou 5 → kupón smí nepřihlášenému ubrat nejvýš 5 %
z hlavního ceníku. Že má ZR25 cenu 11,21 (tj. −25 % z 14,95) tomu
neodporuje: jiná vrstva, jiné pravidlo.

---

## 3. Proč mají ZR20 a ZR25 vypnutý slevový kupón

**okfish jede 20% slevový kupón.** Tiery ZR20 (20 %) a ZR25 (25 %) už
tuhle hranici mají nebo přesahují — kupón by jim tedy nedal nic navíc,
nebo by cenu srazil pod únosnou mez.

Proto se u nich políčko „Slevový kupón" **vypíná**.

V konfiguraci je to `src/config/policies/coupon-policy.json`:

```json
{
  "defaultMaxDiscount": 20,
  "lockedTiers": ["ZR20", "ZR25"],
  "disabledBrands": [],
  "disabledProducts": []
}
```

`lockedTiers` = tiery, které kupón nedostanou. Sedí 1:1 s tím, co je
zaškrtané v administraci.

**Čísla ve sloupci „Max. sleva (%)" u jednotlivých tierů jsou prostor pro
kupón, ne loyalty sleva.** U `112824` to bylo 6 / 4 / 2 u ZR4 / ZR6 / ZR8
a nula od ZR10 výš — právě proto, že tam už kupón nemá kam jít.

---

## 4. Vrstvy, které se NESMÍ porovnávat mezi sebou

Tohle je nejdůležitější sekce pro shadow harness a pro každého, kdo bude
srovnávat „co ukazuje e-shop" proti „co spočítal engine".

| Vrstva | Kde se projeví | Pro koho |
|---|---|---|
| **Hlavní cena** | pole „Cena" | katalog, výchozí |
| **Akční cena** | pole „Akční cena" (☑, volitelně datové okno) | nepřihlášený → **badge** |
| **Tierové ceny** | tabulka „Jiné ceníky" ZR4–ZR25 | přihlášený podle tieru |
| **Kupónový prostor** | sloupec „Max. sleva (%)" + „Slevový kupón" | kupón nad hlavním ceníkem |

Příklad `93683`, kde jsem se spletl:

- badge ukazuje **12,71** = akční cena
- ceník ZR25 má **11,21** = tierová cena
- **není to rozpor** — jsou to dvě různé vrstvy pro dva různé zákazníky

Shadow harness je porovnával, jako by měly být shodné, a vyrobil tím
falešný nález (kategorie `ALLOW_LOYALTY_DIVERGENCE`, 14 rozdílů na
2 produktech). **Ty výsledky neplatí, dokud harness nerozliší vrstvy.**

---

## 5. Business pravidlo: brandSale vs. loyalty tier

Potvrzeno Luckym doslova:

> „DELPHIN má celoroční akci 15 %. Když má tier nižší %, zákazník
> automaticky dostává 15 %. Když je tier vyšší než 15 %, dostane cenu
> toho tieru — ale musí se zohlednit, jestli produkt nemá strop pro
> maximální slevu."

Pořadí:
1. `max(brandSale, loyaltyTier)` — vyhrává **vyšší sleva, NIKDY se nesčítají**
2. **potom** strop (`productMaxDiscount` / `brandLimits`)

Ověřeno na `93683` (base 14,94, DELPHIN brandSale 15 %):

| Tier | Sleva tieru | Vyhrává | Cena |
|---|---|---|---|
| ZR8 | 8 % | akce | 12,70 |
| ZR25 | 25 % | tier | 11,205 |

Zafixováno testem: `tests/regression/golden-pricing/brand-sale-vs-loyalty.test.ts`
(9 testů). `HighestDiscountRule` to implementuje správně.

---

## 6. Strop 0 % = žádná sleva

Potvrzeno Luckym: *„strop je jako že tam nesmí být žádná sleva."*

`minAllowedPrice = base × (1 − 0) = base`, takže každá sleva se zvedne
zpátky na plnou cenu. Je to **nejpřísnější možný strop**, ne „žádný strop".

Proto `DiscountLimitRule` testuje `!== undefined`, ne truthy hodnotu:
při truthy testu by limit `0` propadl jako „nenastaveno" a chráněný
produkt by šel do slevy bez omezení.

---

## 6b. Přesné pořadí, jak ho definuje engine

Zdroj: `docs/CORE_LOGIC_AND_VALIDATION.md` §1. Tohle jsem v noci dovozoval
a měl to jen zčásti — tady je to přesně.

**Vyhledání stropu** (`resolveActiveLimit()`, `pricing.ts:71`):

```
PRODUCT_LIMITS[code] → BRAND_LIMITS[brand] → CATEGORY_LIMITS[category] → žádný
```

`PRODUCT_LIMITS` vzniká object-spread merge, **poslední zápis vyhrává**:

```
{}
  ← zero-discount-products.json          (kód → 0)
  ← clearance-sale-products.json         (kód → pct/100, filtrováno datovým oknem)
  ← product-max-discount-overrides.json  (kód → pct/100)   ← NEJVYŠŠÍ PRIORITA
```

**Výpočet tierových cen** (`calculateAllTierPrices()`, `pricing.ts:107`):

1. načti `basePrice`
2. načti `actionPrice`; není-li **striktně nižší** než base, ber ji jako
   neexistující (ochrana proti zapomenutým promo polím ve feedu)
3. vyhledej strop dle pořadí výše
4. **clearance-vs-cap pravidlo** (`pricing.ts:143-164`): je-li aktivní strop
   **A ZÁROVEŇ** akční cena → **akční cena vyhrává absolutně**. Nikdy se
   nezvedne na strop, nikdy ji nepřebije hlubší loyalty sleva. Strop omezuje
   **jen loyalty-only** cenu.
5. jinak pro každý tier: `min(tier cena, akční cena)`, potom osekni stropem

**Kupónové rozhodnutí** (`CouponPolicy.decide()`), první shoda vyhrává:

1. **locked tiers** — absolutní přednost, kontroluje se první, bez výjimek
2. `productMaxDiscount === 0` → žádný kupón
3. `productMaxDiscount` pod standardním limitem → prostor =
   `productMaxDiscount − max(productDiscount, tierDiscount)`
4. produkt už má slevu ≥ standardní limit → žádný kupón
5. default → prostor = `standardLimit − max(productDiscount, tierDiscount)`

`resolveEffectiveLimit()` v kupónové vrstvě **zrcadlí** pořadí stropů z cenové
vrstvy. Dokumentace to označuje za *„single most important cross-layer
invariant in the system"* — kupón nesmí nikdy povolit víc prostoru, než kolik
by cenový engine sám uplatnil.

## 6c. `brandSaleDiscounts` ≠ `brandLimits`

Zásadní rozlišení, které jsem v noci neměl:

| Značka | `brandSaleDiscounts` | `brandLimits` |
|---|---|---|
| DELPHIN | 0,15 | *žádný* |
| DELPHIN BOMB | 0,15 | *žádný* |
| MIVARDI | 0,10 | 0,10 (nezávisle deklarované) |
| MIKADO | 0,09 | *žádný* |

*„Never derive one from the other — a brand having a sale is not evidence it
should also have a cap, and vice versa."* U MIVARDI se čísla shodují náhodou.

`brandSale` se do enginu dostává jako **syntetizovaná akční cena** (hned po
no-op guardu v `calculateAllTierPrices()`), takže od té chvíle podléhá všem
pravidlům pro akční ceny včetně clearance-vs-cap.

## 6d. INC-010 — proč tři stupně validace nestačí

Model se 2026-08-13 rozšířil z 3 na 5 stupňů kvůli incidentu, který stojí za
zapamatování:

> Bug v `getProductDetail()` tiše no-opnul incremental price pipeline na
> **12 dní**. Každý sync běh hlásil SUCCESS. Stupně 1–3 zůstaly celou dobu
> zelené. **812 produktů (4,9 % katalogu)** mezitím ujelo na špatnou nebo
> chybějící tierovou cenu — nula chyb, nula alertů, nula spadlých testů.

Stupně 1–3 chrání **změnu** („je tahle úprava bezpečná?").
Stupně 4–5 chrání **výsledek** („funguje to, co má fungovat, doopravdy?").

To je přesně důvod, proč má NEXUS `requiresReconciliation()` a rozlišení
`SYSTEM_CONFIRMED` vs `LOG_INFERRED` — úspěšně vypadající běh není důkaz.

## 7. Co z toho plyne pro NEXUS

- Cenový engine musí umět zapisovat **do konkrétní vrstvy**, ne „cenu produktu".
  `ShoptetPriceConnector` proto mapuje tier → pricelist ID.
- Reconciliace musí porovnávat **stejnou vrstvu proti stejné vrstvě**.
- Kupónová logika (`CouponPolicyRule`) je samostatná vrstva nad ceníky,
  ne součást hlavního cenového řetězu — a dnes není zapojená
  v `createNexusPricingCalculator`.
