# Design Proposal: QuantityTier pro Hecmanii

Status: **NÁVRH — žádný kód změněn**. Navazuje na `docs/entity-audit/Price-PriceList-QuantityTier.md`
(definitivní verdikt: QuantityTier = NEW BUILD, žádný legacy vzor) a na produkčně
zapojený Nexus pricing chain (`domains/pricing/createNexusPricingCalculator.ts`,
commit `106eb72`).

Účel dokumentu: rozhodnout DESIGN (scope, chain pozice, ceník vztah, batch/live
oddělení) dřív, než vznikne jediný řádek implementace. Kde návrh naráží na
obchodní rozhodnutí, které nelze odvodit z kódu ani z legacy chování (protože
legacy toto nikdy neřešil), je to explicitně označeno jako **ROZHODNUTÍ
POTŘEBA** — ne domyšleno za vás.

---

## 1. Kam QuantityTier patří v chainu

Potvrzeno research krokem: `currentPrice` v `createNexusPricingCalculator.ts`
prochází těmito stavy:

```
input.basePrice                                    (originál, nediskontovaný)
        │
        ▼ BasePriceRule (:73-75)
currentPrice = basePrice                            (žádná sleva)
        │
        ▼ HighestDiscountRule (:77-87)
currentPrice = SALE nebo LOYALTY cena, pokud aplikováno
        │
        ▼ DiscountLimitRule (:89-102)
currentPrice = ořezáno stropem (VAGNER pravidlo, brand/category/product limit)
        │
        ▼ ────────── TADY: QuantityTierRule (NOVÝ) ──────────
currentPrice = množstevní sleva, POKUD aplikováno
        │
        ▼ RoundingRule (:104-108)
currentPrice = zaokrouhleno na 2 desetinná místa
        │
        ▼
finalPrice (LegacyPricingResult.finalPrice)
```

Toto přesně odpovídá tvému schématu:

```
BASE → SALE/CLEARANCE/CUSTOMER TIER → DiscountLimit → CURRENT PRICE → QuantityTier → Rounding
```

**Zdůvodnění pozice:**
- QuantityTier musí počítat z ceny **po** slevě a **po** stropu, ne z `basePrice`
  — jinak by 8% množstevní sleva z 250 Kč dala jinou (vyšší) absolutní slevu
  než 8% z už zlevněné 225 Kč H-KLUB ceny. Tvůj příklad (`250 → 225 → 207`)
  to přesně ukazuje: `225 * 0.92 = 207`, ne `250 * 0.92 = 230`.
- QuantityTier musí být **před** `RoundingRule`, ne po něm — stejný princip
  jako existující chain: zaokrouhlení je vždy poslední krok, aby se
  nekumulovala chyba zaokrouhlení mezi kroky (to už `RoundingRule` řeší
  správně pro `HighestDiscount`→`DiscountLimit`, stejná logika platí i tady).
- **DiscountLimit zůstává PŘED QuantityTier**, ne po něm. Důvod: `DiscountLimit`
  je strop na *procentuální* slevu vůči `basePrice` (VAGNER pravidlo — chrání
  před přehnanou slevou na úrovni produktu/brandu/kategorie). QuantityTier je
  navazující, nezávislá slevová vrstva aplikovaná na už-schválenou zákaznickou
  cenu. Kdyby QuantityTier běžel před DiscountLimit, mohl by cap-floor
  výpočet v DiscountLimit omylem zredukovat i množstevní slevu zpět —
  to by bylo nekonzistentní s tím, jak DiscountLimit dnes funguje (počítá
  vždy vůči `basePrice`, ne vůči libovolné mezihodnotě).

  > **ROZHODNUTÍ POTŘEBA:** Je tenhle vztah (DiscountLimit strop se **nikdy**
  > netýká množstevní slevy, jen zákaznické/akční slevy) obchodně správný pro
  > Hecmanii? Nebo má existovat kombinovaný strop (např. "max. celková sleva
  > i s quantity tier nesmí přesáhnout X %")? Legacy pravidlo (VAGNER) tohle
  > neřeší, protože quantity tier v legacy nikdy neexistoval — je to čistě
  > nová otázka.

---

## 2. Co znamená QuantityTier v doméně (ne jen "quantity → discount")

Tvůj postřeh je klíčový: QuantityTier není jedna hodnota, je to **tři oddělené
odpovědnosti**, které legacy (Shoptet nativní) řeší dohromady, ale Nexus je
musí umět rozlišit:

1. **Zdrojová cena** (source price) — cena, ze které se množstevní sleva
   počítá. Podle sekce 1: `currentPrice` po `DiscountLimitRule`, ne `basePrice`.
2. **Množstevní skupina** (quantity group) — CO se sčítá, aby se určilo
   celkové množství pro tier lookup. Tohle je přesně místo, kde vstupuje
   Cross-Variant otázka (sekce 4).
3. **Tier lookup** — mapování (skupina, celkové množství) → % sleva nebo
   pevná cena.

Návrh typové struktury (ilustrační, ne finální kód):

```ts
interface QuantityTierRuleInput {
    readonly sourcePrice: Decimal;        // currentPrice po DiscountLimitRule
    readonly quantity: number;             // množství objednávané TOHOTO SKU
    readonly quantityGroupId?: string;     // viz sekce 3-4 -- jak se určuje
    readonly tiers: QuantityTierBreakpoint[]; // config, viz sekce 5
}

interface QuantityTierBreakpoint {
    readonly minQuantity: number;  // inclusive
    readonly maxQuantity?: number; // inclusive, undefined = "a víc"
    readonly discountPercent: number;
}
```

Toto NENÍ návrh k implementaci teď — jen ukazuje, že řešíme tři různá
rozhodnutí (source price už rozhodnuto v sekci 1; group a tier lookup jsou
otevřené níže).

---

## 3. Scope QuantityTier — varianty

Otevřená otázka #3 z `Price-PriceList-QuantityTier.md`. Tři možnosti,
s dopadem na typový model:

### Varianta A: Per-Product
Každý produkt má vlastní tier breakpointy. Množství se počítá jen za tento
jeden SKU.

- **Výhoda:** jednoduché, žádná cross-produktová logika.
- **Nevýhoda:** neodpovídá tvé hypotéze ani obvyklému Hecmania scénáři, kde
  zákazník kombinuje barevné varianty stejného modelu a chce množstevní slevu
  za CELKOVÝ odběr, ne per barva.

### Varianta B: Per-PriceList (per zákaznický tier)
Tier breakpointy jsou vlastností ceníku (H-KLUB, GUEST, ZR20, ...), ne
produktu — každý zákazník na daném ceníku má stejné breakpointy napříč
všemi produkty.

- **Výhoda:** jedna konfigurace pro celý ceník, snadná správa.
- **Nevýhoda:** nedovoluje "tahle skupina produktů má jiné quantity pravidlo
  než tamta" (např. akční řada s agresivnějším quantity tierem).

### Varianta C: Per-Group (tvá hypotéza)
`QuantityTierGroup` — explicitní seskupení produktů, které se sčítají pro
účely quantity tier výpočtu, nezávisle na Shoptet variant mechanismu.
Breakpointy patří skupině, ne produktu ani ceníku.

- **Výhoda:** přesně odpovídá Cross-Variant realitě Hecmanie (sekce 4) —
  barvy nejsou Shoptet varianty, ale Nexus je musí umět sečíst.
- **Nevýhoda:** vyžaduje novou entitu (`QuantityTierGroup`) a její správu
  (kdo group definuje, jak se produkt do group přiřazuje) — to je práce
  navíc oproti A/B.

### Návrh: C, s B jako fallback vrstvou

Tvá hypotéza (`Produktová/promo skupina + zákaznický ceník → cena zákazníka
→ QuantityTier`) dává smysl jako:

```
QuantityTierGroup (co se sčítá)
        │
        ▼
QuantityTier breakpoints (přiřazené GROUP, ne produktu, ne ceníku)
        │
        ▼ aplikováno na
sourcePrice (cena PO customer/sale/limit vrstvě, PER produkt, PER ceník)
```

Tedy: **ceník určuje `sourcePrice` (přes existující chain), group určuje
KOLIK celkem se objednává a JAKÉ breakpointy platí.** To je konzistentní
s tvým "ceník = zdrojová cenová vrstva, ne vlastnost tieru".

> **ROZHODNUTÍ POTŘEBA:** Potvrdit variantu C jako závaznou. Pokud ano,
> navazující otázka: má nějaký produkt/skupina fallback na "žádná group
> = žádný quantity tier" (bezpečné výchozí chování), nebo "žádná group
> = per-produkt tier" (fallback na variantu A)? Doporučuji první (bezpečnější,
> explicitní opt-in), ale je to obchodní rozhodnutí, ne technické.

---

## 4. Cross-Variant skupina — jak se definuje

Toto je jádro Hecmania specifika, které v legacy vůbec neexistovalo (Shoptet
nativní varianty jsou jiný mechanismus a neřeší "tyhle 3 samostatné produkty
se mají sčítat").

### Co víme
- Barvy u Hecmanie **nejsou** Shoptet varianty (`variant.color` na jednom
  produktu) — jsou to **samostatné produkty** se samostatným SKU, samostatnou
  cenou, samostatnou skladovou pozicí.
- `QuantityTierGroup` tedy musí být Nexus-side entita, ne odvozená ze Shoptet
  dat (protože Shoptet o vztahu mezi těmi produkty nic neví).

### Návrh struktury

```ts
interface QuantityTierGroup extends CanonicalEntity {
    readonly name: string;              // "Model XY - všechny barvy"
    readonly memberProductSkus: EntityId[]; // explicitní seznam SKU v group
    readonly breakpoints: QuantityTierBreakpoint[];
}
```

Klíčová otevřená otázka: **jak se group naplňuje** — tři možnosti:

1. **Explicitní ruční přiřazení** — někdo (Jose/Jan, nebo admin UI) řekne
   "SKU A, B, C patří do group G". Nejbezpečnější, nejvíc práce navíc.
2. **Odvozeno z konvence SKU/názvu** — např. společný prefix SKU
   (`HEC-MODEL-XY-*`). Rychlejší na zavedení, ale křehké (kdo zaručí, že
   konvence nikdy neselže nebo se nezmění).
3. **Odvozeno z existujícího Shoptet pole** — pokud Hecmania feed obsahuje
   nějaké "master SKU" nebo "product group" pole už dnes (i když ne jako
   Shoptet variant), dalo by se z něj group odvodit automaticky.

> **ROZHODNUTÍ POTŘEBA (nejdůležitější v celém dokumentu):** Která ze tří
> cest? Tohle nelze odvodit z kódu — je to otázka na to, jak Hecmania feed/
> katalog dnes strukturuje "tohle je jeden model, tamty tři SKU jsou jeho
> barvy". Pokud existuje pole v master feedu (viz `feed-generator.ts` už
> zmíněný v auditu), je varianta 3 nejbezpečnější a nejméně křehká. Potřebuji
> vědět, jestli takové pole existuje, než navrhnu konkrétní parser.

### Dopad na `PricingComputationInput`

Aktuálně (`core/canonical/entities/Price.ts:27-49`) nemá pole `quantity` ani
`quantityTierGroupId`. Návrh rozšíření (ilustrační):

```ts
export interface PricingComputationInput {
    // ... existující pole beze změny ...
    readonly quantity?: number;           // množství TOHOTO SKU v objednávce/košíku
    readonly quantityTierGroupId?: EntityId; // FK na QuantityTierGroup, pokud produkt patří do skupiny
}
```

Oboje optional — neinvazivní rozšíření, stejný vzor jako přidání
`customerTier` v commitu `912193f`.

---

## 5. Jak ceník vstupuje do QuantityTier

Tvoje pracovní hypotéza: **ceník (zákaznický tier) je zdrojová cenová vrstva,
ne vlastnost tieru samotného.** Souhlasím s touto interpretací z technického
hlediska — zapadá čistě do chainu (sekce 1): ceník už determinuje `sourcePrice`
přes `HighestDiscountRule`, `QuantityTierRule` na to jen navazuje.

Nicméně jedna dílčí otázka zůstává otevřená:

> **ROZHODNUTÍ POTŘEBA:** Mají **breakpointy samotné** (kolik % sleva na
> jakém množství) být stejné napříč všemi ceníky, nebo se liší podle
> zákaznického tieru? Např.:
> - Stejné pro všechny: GUEST i H-KLUB zákazník dostane 8% od 8 ks (jen na
>   jinou `sourcePrice`, protože H-KLUB už má nižší startovní cenu).
> - Liší se: H-KLUB zákazník dostane agresivnější quantity tier (např. 10%
>   od 8 ks místo 8%) jako další věrnostní benefit.
>
> Tvá hypotéza (`QuantityTierGroup → QuantityTier rules` bez zmínky ceníku)
> naznačuje první možnost (breakpointy nezávislé na ceníku), ale je to
> potřeba potvrdit explicitně, protože to mění shape configu
> (`QuantityTierGroup.breakpoints` buď jedna sada, nebo `Record<PriceListId,
> Breakpoint[]>`).

---

## 6. Batch vs. Live výpočet — stejná kanonická pravidla

Požadavek: batch Pricing Engine (sync na Shoptet) i frontend/Worker (dynamický
výpočet podle aktuálního obsahu košíku) musí používat **stejnou definici**
pravidel, ne dvě nezávislé implementace.

### Návrh
`QuantityTierRule` (stejně jako `BasePriceRule`, `HighestDiscountRule`, ...)
zůstává **čistá funkce bez I/O** (`core/canonical/rules/Rule.ts` kontrakt —
"Rule MUSÍ být deterministická... žádné skryté side effects uvnitř
evaluate()"). To znamená:

- **Batch** (sync): volá `QuantityTierRule.evaluate()` s `quantity` odvozeným
  z nějakého referenčního/výchozího množství (např. "cena zobrazená v XML
  feedu pro 1 ks" — tady je otevřená otázka, co batch vlastně reprezentuje,
  viz níže).
- **Live** (Worker/frontend): volá **STEJNOU** `QuantityTierRule.evaluate()`
  s aktuálním `quantity` z košíku uživatele.

Obě strany sdílí stejný `connectors/pricing-engine`-style balíček (analogie:
`domains/pricing/QuantityTierRule.ts`), takže není riziko rozjetí definic —
přesně stejný princip jako `createNexusPricingCalculator` dnes sdílí
`BasePriceRule`/`HighestDiscountRule`/atd. mezi (budoucím) batch i (budoucím)
live voláním.

> **ROZHODNUTÍ POTŘEBA:** Co přesně batch Pricing Engine zapisuje do Shoptet
> XML feedu, když finální cena závisí na množství, které batch neznámá
> (protože batch neběží v kontextu konkrétního košíku)? Tři možnosti:
> 1. Batch zapíše cenu za "1 ks" (bez quantity tier) a quantity tier se
>    aplikuje VÝHRADNĚ live (frontend/Worker přepočítá při změně množství
>    v košíku) — to znamená Shoptet XML feed nikdy neobsahuje
>    quantity-tier-diskontovanou cenu, jen nativní Shoptet
>    `quantityDiscount`/`volumeDiscount` boolean flagy (současný stav,
>    beze změny — Shoptet dál dělá quantity tier nativně, Nexus quantity
>    tier je JEN pro custom frontend, pokud vůbec existuje).
> 2. Batch zapíše několik "breakpoint cen" jako samostatné položky (pokud to
>    Shoptet feed formát umožňuje) — komplikovanější, možná nad rámec
>    Shoptet capabilities.
> 3. Nexus QuantityTier úplně nahrazuje Shoptet nativní mechanismus a batch
>    i live obojí počítají centrálně přes Nexus, výsledek se zapisuje jen
>    pro live scénář (Worker/frontend přímý prodej), Shoptet feed zůstává
>    beze změny.
>
> Tohle přímo určuje, jestli `QuantityTierRule` vůbec potřebuje být součástí
> `createNexusPricingCalculator` (batch cesta), nebo jestli je to samostatný
> modul volaný jen z Worker/frontend cesty, mimo batch úplně.

---

## 7. Dopad na existující soubory (přehled, žádná změna provedena)

| Soubor | Navrhovaná změna | Riziko rozbití existujícího |
|---|---|---|
| `core/canonical/entities/Price.ts` | Rozšířit `PricingComputationInput` o `quantity?`, `quantityTierGroupId?` (optional). Nová entita `QuantityTierGroup`. | Nízké — optional pole, stejný vzor jako `customerTier` v `912193f`. |
| `domains/pricing/QuantityTierRule.ts` | Nový soubor, `Rule<QuantityTierRuleInput, QuantityTierRuleResult>` kontrakt. | Žádné — nový soubor. |
| `domains/pricing/createNexusPricingCalculator.ts` | Vložit `QuantityTierRule` mezi `DiscountLimitRule` a `RoundingRule` — **jen pokud rozhodnutí v sekci 6 potvrdí, že batch cestu ovlivňuje**. | Střední — mění `LegacyPricingResult` shape (nové `appliedRules` položky), musí projít celou golden-dataset regresí znovu (golden fixtures nemají quantity pole, takže by měly projít beze změny výsledku, pokud `quantity`/`quantityTierGroupId` zůstanou `undefined` — ale je potřeba to explicitně ověřit novým regression testem, ne předpokládat). |
| `connectors/pricing-engine/legacy/` | **ŽÁDNÁ ZMĚNA.** Legacy engine quantity tier neřešil a nebude — zůstává referenční oracle jen pro to, co už migrovaný je. | Nulové. |
| Worker/frontend (Cross-Variant) | Nová logika pro sečtení množství napříč `QuantityTierGroup.memberProductSkus` v košíku — mimo scope tohoto repa, pokud Worker žije jinde. | Neznámé — záleží, kde Worker kód žije (mimo `~/nexus`?). |

---

## 8. Shrnutí rozhodnutí potřebných od vás (Jan/Jose)

1. **Sekce 1:** Má DiscountLimit strop platit jen na zákaznickou/akční slevu,
   nikdy na quantity tier, nebo má existovat kombinovaný strop?
2. **Sekce 3:** Potvrdit variantu C (`QuantityTierGroup`) jako závaznou.
   Fallback chování bez group?
3. **Sekce 4 (nejdůležitější):** Jak se `QuantityTierGroup` členství
   definuje — ruční přiřazení, SKU konvence, nebo existující pole v master
   feedu? Existuje dnes v Hecmania feedu nějaké "toto je jeden model" pole?
4. **Sekce 5:** Jsou breakpointy stejné napříč ceníky, nebo se liší podle
   zákaznického tieru?
5. **Sekce 6 (druhá nejdůležitější):** Co dělá batch Pricing Engine, když
   neznámá konkrétní množství z košíku — píše cenu za 1 ks a quantity tier
   je čistě live/frontend záležitost, nebo má batch vůbec quantity tier
   řešit?

Až budou tahle rozhodnutí padnuta, další krok je návrh Hecmania testovací
matice (`base + QuantityTier`, `sale + customer tier + QuantityTier`, atd.)
jako **regression fixtures** ve stejném stylu jako
`tests/regression/golden-pricing/` — ale to je následující krok, ne součást
tohoto dokumentu.
