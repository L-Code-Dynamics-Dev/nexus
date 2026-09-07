# Jak se ceny zapisují do Shoptetu (okfish model)

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

## 7. Co z toho plyne pro NEXUS

- Cenový engine musí umět zapisovat **do konkrétní vrstvy**, ne „cenu produktu".
  `ShoptetPriceConnector` proto mapuje tier → pricelist ID.
- Reconciliace musí porovnávat **stejnou vrstvu proti stejné vrstvě**.
- Kupónová logika (`CouponPolicyRule`) je samostatná vrstva nad ceníky,
  ne součást hlavního cenového řetězu — a dnes není zapojená
  v `createNexusPricingCalculator`.
