# Shoptet Premium Template — L-Code Dynamics

**Stav:** návrhový podklad, verze 1.0
**Datum:** 2026-09-06
**Autor:** L-Code Dynamics (Lucky + Claudik)
**Účel:** kompletní podklad pro stavbu vlastní prémiové Shoptet šablony jako **opakovaně prodejného produktu**

---

## 0. Co stavíme (a co ne)

**Nestavíme jednu hezkou šablonu.** Stavíme **konfigurovatelný designový systém**, který nasadíme jednou a klient si ho pak sám doladí bez jediného řádku kódu.

Tři pilíře produktu:

1. **Dlaždicová navigace** jako určující UX směr — zákazník se pohybuje e-shopem přes vizuální dlaždice, ne přes rozbalovací menu.
2. **Konfigurační vrstva** — e-shopař si sám nastaví barvy, typografii, hustotu, varianty komponent. Bez kódu, s živým náhledem, bez možnosti si to rozbít.
3. **NEXUS hooky** — čisté rozšiřovací body pro kreditní poukazy, dynamické ceny a věrnostní tiery.

Obchodní logika: nasazení šablony je jednorázová práce, konfigurátor je opakovaný prodej. Jeden klient = jedna instalace + měsíční licence konfigurátoru. Tohle není zakázka, tohle je produkt.

---

# ČÁST I — TECHNICKÁ REALITA SHOPTETU

> Metodická poznámka: každý blok je označen **[OVĚŘENO]** (dohledáno v oficiální dokumentaci Shoptetu nebo v jejich GitHub repozitářích) nebo **[ODHAD]** (naše inference, nutno potvrdit před startem).

## 1.1 Šablonovací systém — zásadní zjištění

**[OVĚŘENO]** **Shoptet nemá veřejně editovatelné server-side šablony.** Není zde Twig, Liquid, Smarty ani nic podobného, do čeho by externí vývojář sahal. Oficiální dokumentace k editaci šablon uvádí jediný způsob úprav: *"You can modify the templates in Shoptet by inserting HTML codes."*

Co z toho plyne — a je to nejdůležitější věta celého dokumentu:

> **Šablona na Shoptetu = CSS + JavaScript nad HTML, které vygeneruje platforma. HTML strukturu nevlastníme.**

To zásadně mění, jak se k projektu postavit. Nejde o "napíšeme si vlastní templaty". Jde o:
- kompletní vlastní CSS vrstvu (přepis nebo náhrada shoptetí),
- JavaScript, který **přeskládá a doplní DOM** (dlaždicová navigace, custom komponenty),
- a bezpodmínečnou závislost na tom, že Shoptet svoje třídy nepřejmenuje.

**[OVĚŘENO]** Zdrojové assety šablon jsou veřejné v repozitáři `github.com/shoptet/templates-assets` — obsahuje adresáře `00`, `07`, `09`, `10`, `11`, `12`, `13`, `14` (verze šablon) a `shared`. Repozitář je aktivní (~419 commitů). README výslovně zakazuje jakoukoli editaci: *"don't ever edit any file in this repository"* — slouží jako referenční zdroj, ze kterého čteme LESS proměnné a strukturu tříd.

**[OVĚŘENO]** Companion repozitář `github.com/shoptet/templates-custom-theme` (custom theme pro šablony 3. generace) je **archivovaný od 3. 12. 2024** a sám dokumentace označuje tento postup za zastaralý: *"Building templates this way is outdated and could lead to errors."* Build stál na **GruntJS** + LESS, výstup `dist/main.css` a `dist/build.min.js` se nahrával přes FTP.

**Závěr:** oficiální "custom theme" cesta je mrtvá větev. Stavíme vlastní moderní pipeline (viz Část IV) a z shoptetích repozitářů bereme jen znalost struktury.

## 1.2 Blank Template Mode — naše hlavní páka

**[OVĚŘENO]** Blank template mode vypíná stahování výchozího CSS a JavaScriptu ze Shoptet serverů a nechá nás nahrát vlastní.

| Vlastnost | Detail |
|---|---|
| Kde se zapíná | administrace, `/admin/html-kody/` |
| Granularita | zvlášť lze vypnout jen JS, jen CSS, nebo obojí |
| Dostupnost | **Premium tarif** pro vlastní design konkrétního e-shopu |
| Alternativa | přes marketplace Shoptet Doplňky lze nasadit i klientovi bez Premium — vyžaduje **dohodu se Shoptetem** (kontakt: `api@shoptet.cz`) |
| Kritické omezení | *"Vychází z Classic šablony"* — modifikujeme podprvky, nestavíme od nuly |
| Kompatibilita | **musí se zachovat struktura tříd**, jinak se rozpadnou doplňky třetích stran |

**Ta poslední řádka je nejtvrdší mantinel celého projektu.** I v blank režimu nedostaneme prázdné plátno — dostaneme HTML Classic šablony bez stylů. Naše CSS se musí navěsit na *jejich* třídy. Když si vytvoříme vlastní class-naming a shoptetí zahodíme, přestanou fungovat doplňky, které klient používá (dopravci, heureka, chatboti).

**[ODHAD]** Marketplace cesta je pro nás obchodně výrazně zajímavější než Premium cesta: Premium stojí klienta **od 12 000 Kč/měs bez DPH** (dle veřejných zdrojů, ne oficiálního ceníku), což vyřadí většinu našich klientů. Nutno ověřit přímo se Shoptetem, za jakých podmínek jde blank režim nasadit přes Doplňky.

## 1.3 Nasazení a limity

**[OVĚŘENO]** Kanály, kterými se náš kód dostane do e-shopu:

**A) HTML kódy v administraci** (`/admin/html-code/`)
- 4 sekce: Header, Footer, Dokončená objednávka, robots.txt
- **Limit 8192 znaků na sekci.** Při překročení se změny neuloží.
- Používá se pro `<link>`/`<script>` tagy a malý inline bootstrap — ne pro samotnou šablonu.

**B) SFTP do `/user/documents/`**
- Sem patří veškerý objemný kód (WinSCP, FileZilla, případně skriptovaný `paramiko` deploy).
- Veřejné URL: `https://cdn.myshoptet.com/usr/[domena]/user/documents/assets/main.css`
- **Všechny soubory musí být UTF-8**, jinak se rozbijí české znaky.

**C) Cache-busting**
- **[OVĚŘENO]** Verzování přes query string: `modification.js?v=4`.
- Placeholder `#DEBUG_TIMESTAMP#` je dokumentací označen za **zastaralý** — nepoužívat.

**[OVĚŘENO]** Další zdokumentovaná úskalí: pozor na duplikaci XHR requestů při navěšování na AJAX eventy (kontrolovat Network tab) — reálné riziko, protože Shoptet překresluje košík AJAXem a naslouchače se snadno navěsí vícekrát.

## 1.4 Co Shoptet nedovolí

**[OVĚŘENO]:**
- editovat server-side šablony,
- editovat cokoli v `templates-assets`,
- překročit 8192 znaků v HTML kódu,
- v blank režimu opustit strukturu tříd Classic šablony bez ztráty kompatibility s doplňky.

**[ODHAD]**, k ověření:
- rozsah úprav checkoutu (nákupní proces je nejcitlivější a nejregulovanější část platformy),
- zda jde měnit pořadí kroků objednávky,
- zda jde přidávat vlastní pole do objednávky bez Premium API.

## 1.5 Šablonový JS runtime — co máme k dispozici

Tohle je nejcennější nález celého průzkumu. Shoptet má **plnohodnotné frontend API**, ne jen jQuery.

**[OVĚŘENO]** Objekt `shoptet.design` — kompletní stav designu na každé stránce:

```js
shoptet.design.template.name            // Classic, Samba, Disco...
shoptet.design.template.colorVariant
shoptet.design.layout.homepage
shoptet.design.layout.subPage
shoptet.design.layout.productDetail
shoptet.design.colorScheme.conversionColor
shoptet.design.colorScheme.color1 / color2 / color3 / color4
shoptet.design.fonts.heading / fonts.text
shoptet.design.header.logo / header.backgroundImage / header.image
shoptet.design.background.enabled / color / image.url
```

Nemusíme parsovat body classes — stav designu čteme přímo. Pro náš konfigurátor je to zásadní: umíme detekovat, co si klient nastavil nativně, a navázat na to.

**[OVĚŘENO]** Košíkové API:

```js
shoptet.cartShared.addToCart({ priceId: 1745 });
shoptet.cartShared.addToCart({ productCode: '183/GSB' });
shoptet.cartShared.addToCart({ productId: 183, parameterValueId: { 78: 210, 10: 204 } });
shoptet.cartShared.removeFromCart(itemId);        // itemId jako objekt
shoptet.cartShared.updateQuantityInCart({ itemId, priceId });
```

**[OVĚŘENO]** Eventy a monitoring:

```js
// DOM eventy
document.addEventListener('ShoptetDOMContentLoaded', fn);      // po AJAX načtení
document.addEventListener('ShoptetDOMCartContentLoaded', fn);  // po reloadu košíku
document.addEventListener('ShoptetDataLayerUpdated', fn);      // po tracking skriptech

// Seznamy dostupných eventů (introspekce za běhu)
shoptet.scripts.availableDOMLoadEvents
shoptet.scripts.availableDOMUpdateEvents
shoptet.scripts.availableCustomEvents
shoptet.scripts.monitoredFunctions

// Monitoring volání interních funkcí
shoptet.dev.enableEventsMonitoring(true, { days: 0, hours: 1 });
document.addEventListener('shoptet.global.showPopupWindow', fn);
shoptet.scripts.setCustomCallback('shoptet.global.showPopupWindow', args => {});

// Hooky do validace formulářů
shoptet.custom.postSuccessfulValidation = form => true;   // false = zastavit odeslání
shoptet.custom.postFailedValidation = form => {};
```

`shoptet.scripts.availableCustomEvents` je pro nás zlatý důl — místo hádání si za běhu vypíšeme přesný seznam eventů dané instalace. **První úkol při startu projektu: vydumpovat tyto tři seznamy na reálném klientském e-shopu.**

**[OVĚŘENO]** dataLayer (`getShoptetDataLayer()`, `getShoptetDataLayer('cart')`):

```
pageType            // homepage | category | productDetail | cart | thankYou
currency, language, projectId
product.id, guid, name, manufacturer, priceWithVat, hasVariants,
        codes[].code, currentCategory, defaultCategory
cart[].code, cart[].quantity
order.orderNo, total, tax, shipping, discountCoupons[].code
order.customer.priceRatio        // ← cenová hladina zákazníka
order.customer.registered
order.content[].sku / price / quantity
```

`order.customer.priceRatio` je přímý ukazatel cenové skupiny zákazníka — přesně ten signál, který NEXUS potřebuje pro věrnostní tiery (viz Část VI).

## 1.6 Nativní konfigurace šablony — kolik toho Shoptet umí sám

Toto je **klíč k pochopení, proč má náš konfigurátor smysl**.

**[OVĚŘENO]** CSS proměnné, které Shoptet plní z administrace a jsou dostupné v našem externím CSS:

```css
--color-primary            /* Barva šablony 1 */
--color-primary-hover      /* Barva šablony 2 */
--color-secondary          /* Konverzní barva */
--color-secondary-hover
--color-tertiary           /* Barva šablony 3 */
--color-tertiary-hover
--template-font            /* Písmo textu */
--template-headings-font   /* Písmo nadpisů */
--header-background-url
```

**[OVĚŘENO]** Placeholdery pro inline CSS/HTML v administraci (fungují jen v `/admin/html-code/`):

```
#HOST#  #PROJECT_ID#  #TEMPLATE#  #LANGUAGE#
#COLOR_PRIMARY#  #COLOR_PRIMARY_HOVER#
#COLOR_SECONDARY#  #COLOR_SECONDARY_HOVER#
#COLOR_TERTIARY#  #COLOR_TERTIARY_HOVER#
#TEMPLATE_FONT#  #TEMPLATE_HEADINGS_FONT#
#HEADER_BACKGROUND_URL#  #DEBUG_TIMESTAMP#
```

**[OVĚŘENO]** V administraci si e-shopař nativně nastaví: výběr ze 7 aktivních šablon (Samba, Disco, Step, Classic, Waltz, Tango, Techno), barevnost, fonty, rozvržení stránky a pozice panelů, prvky (menu, kategorie, značky, hodnocení), bannery, carousel, logo, počet produktů na řádek, poměr obrázků, pozadí.

### Kde je díra — a náš produkt

Shoptet nativně dává **6 barev + 2 fonty**. To je vše.

Nedostane:
- žádný spacing systém (hustota layoutu),
- žádné rádiusy, stíny, rámečky — vizuální osobnost,
- žádné varianty komponent (karta produktu, hlavička, patička, badge),
- žádný dark mode,
- žádnou kontrolu kontrastu — e-shopař si klidně nastaví žlutou na bílé,
- žádnou typografickou škálu, jen výběr fontu,
- žádné dlaždice.

**Náš konfigurátor tuhle díru vyplní.** A protože Shoptet své nativní hodnoty vystavuje jako CSS proměnné, umíme se s nimi elegantně skamarádit místo abychom je přebíjeli — viz sekce 3.4.

---

# ČÁST II — REFERENČNÍ ÚROVEŇ

## 2.1 Nativní šablony Shoptetu

**[OVĚŘENO]** Aktivních 7: **Samba, Disco, Step, Classic, Waltz, Tango, Techno**. Shoptet u Techno a Waltz provedl vizuální úpravy, u Samba/Disco/Step upravuje barevná schémata.

**[ODHAD]** Technické hodnocení (z inspekce assetů a obecné znalosti platformy — nutno ověřit měřením):
- Postavené na **LESS + jQuery**, ne moderní stack.
- Konzervativní, "bezpečný" vzhled — funkční, ale bez vlastní osobnosti; e-shopy jsou na první pohled rozeznatelné jako "shoptetí".
- Vizuální diferenciace mezi šablonami je hlavně v barvách a drobných detailech, ne v UX modelu.
- **Classic** je pro nás nejdůležitější — blank režim z ní vychází.

**[OVĚŘENO]** Shoptet **nepublikuje** oficiální srovnání Core Web Vitals napříč šablonami. Výkon závisí hlavně na počtu doplňků, obrázcích a custom kódu, ne na volbě šablony samotné.

**[ODHAD]** Právě proto je rychlost naše konkurenční výhoda. Typický shoptetí e-shop je pomalý ne kvůli platformě, ale kvůli nabalenému jQuery, neoptimalizovaným obrázkům a pěti doplňkům, které každý tahá vlastní knihovnu. Blank režim nám dovolí to celé odstřihnout.

## 2.2 Co je dnes standard prémiového českého e-shopu

**[ODHAD]** — pozorování trhu, ne měřená data:

Prémiovost dnes stojí na čtyřech věcech, které si zákazník neuvědomuje, ale cítí:
1. **Klid.** Málo prvků, hodně prostoru. Ne pět banerů a odpočet nad sebou.
2. **Fotky jako hlavní obsah.** Konzistentní poměr stran, konzistentní pozadí, dostatečná velikost.
3. **Rychlost.** Prémiový e-shop nemá skeleton loader — má obsah.
4. **Jistota v nákupním procesu.** Doprava a dostupnost viditelné dřív, než se zákazník zeptá.

Naopak co prémiovost okamžitě zabíjí: rotující carousel na homepage, cookie lišta přes půl obrazovky, dvě různá písma v jednom bloku, tlačítka bez viditelného focus stavu, "sleva 70 %" na každém produktu.

---

# ČÁST III — KONFIGURAČNÍ VRSTVA (jádro produktu)

> Požadavek Lucky: *"Chci, aby si e-shopař dokázal díky tomu nastavit tu šablonu přesně jak potřebuje on, aby nemusel nic honit kódem."*

## 3.1 Princip: token in, systém out

E-shopař nenastavuje CSS. Nastavuje **malý počet smysluplných parametrů**, ze kterých systém dopočítá celý designový systém.

Nikdy nedáme 12 nezávislých číselných polí. Dáme jeden parametr a odvodíme z něj škálu.

| Co e-shopař nastaví | Co z toho systém dopočítá |
|---|---|
| 1 primární barva | celá škála 50–900, hover, active, disabled, focus ring, barva textu na ní |
| 1 akcentní (konverzní) barva | totéž + kontrolu, že se netříská s primární |
| 1 volba "vzdušnost" (3 stupně) | celá spacing škála, výška komponent, mezery v mřížce |
| 1 volba "osobnost" (3–4 stupně) | rádiusy, stíny, tloušťka rámečků — konzistentně napříč vším |
| 1 font pár z kurátorovaného seznamu | velikosti, váhy, line-height, letter-spacing pro celou škálu |
| 1 "měřítko textu" (3 stupně) | celá typografická škála přes modular scale |

Tohle je rozdíl mezi konfigurátorem, který dělá hezké e-shopy, a barvičkovacím nástrojem, který dělá ošklivé.

## 3.2 Co přesně jde nastavit — úplný výčet

### A) Barvy
- **Primární** (identita značky) — výběr z palety nebo hex.
- **Akcentní / konverzní** (koupit, do košíku) — oddělená od primární záměrně; nejčastější chyba e-shopů je jedna barva na všechno.
- **Neutrální ladění** — teplá / studená / čistě šedá (ovlivní pozadí, rámečky, texty).
- **Stavové barvy** — skladem / nedostupné / sleva / novinka. Přednastavené, editovatelné.
- **Dark mode** — přepínač: vypnuto / podle systému / vždy. Tmavá paleta se **dopočítá**, e-shopař ji nemíchá ručně.

**Co e-shopař NEnastaví:** barvu textu. Ta se dopočítá z pozadí tak, aby vždy splňovala kontrast (sekce 3.5).

### B) Typografie
- **Font pár** — výběr z **kurátorovaného seznamu 8–10 párů**, ne z celého Google Fonts. Každý pár otestovaný na češtinu (háčky, čárky, kroužek) a na variabilní řez.
- **Měřítko textu** — kompaktní / standardní / velké. Mění základ škály, ne jednotlivé velikosti.
- **Váha nadpisů** — normální / silná / extra silná.
- **Verzálky v nadpisech** — ano / ne.

**Co e-shopař NEnastaví:** line-height, letter-spacing, jednotlivé velikosti. Odvozeno.

### C) Hustota a layout
- **Vzdušnost** — kompaktní (víc zboží na obrazovku) / vyvážená / vzdušná (prémiový pocit). Ovládá jeden multiplikátor spacing škály.
- **Šířka obsahu** — úzká / standardní / široká / na celou šířku.
- **Počet sloupců v kategorii** — zvlášť pro mobil (1–2), tablet (2–3), desktop (3–5).

### D) Osobnost
- **Rádiusy** — ostré / jemné / zaoblené / pilulka.
- **Stíny** — žádné (ploché, rámečkové) / jemné / výrazné.
- **Rámečky** — vypnuto / jemné / výrazné.
- **Styl obrázků** — čtverec / 4:5 / 3:4 / 16:9, s rádiusem nebo bez.

### E) Varianty komponent
- **Karta produktu** — 4 varianty (detail v sekci 5.3): Minimal, Informační, Obchodní, Vizuální.
- **Hlavička** — 3 varianty: klasická / centrované logo / kompaktní lepivá.
- **Patička** — 2–3 varianty podle množství obsahu.
- **Tlačítka** — plné / obrysové / měkké.
- **Badge** — pozice (roh / pod obrázkem), tvar, které se zobrazují (sleva / novinka / skladem / doprava zdarma) a v jakém pořadí.

### F) Obsah karty produktu (přepínače viditelnosti)
Zapnout/vypnout a přeuspořádat: obrázek na hover, značka, krátký popis, hodnocení, dostupnost, cena před slevou, cena za jednotku, tlačítko do košíku, výběr varianty, oblíbené, porovnat.

### G) Detail produktu
Pořadí a viditelnost bloků přetahováním: galerie, název, hodnocení, cena, varianty, množství, CTA, dostupnost, doprava, krátký popis, benefity, dlouhý popis, parametry, ke stažení, související, nedávno viděné.

### H) Dlaždice (viz Část V)
Přiřazení obrázku, pořadí, velikosti a barevného ladění jednotlivým kategoriím.

## 3.3 Kde konfigurace fyzicky žije — doporučení

Zvažované varianty:

**(a) Vlastní NEXUS admin obrazovka, která generuje CSS proměnné** ✅ **DOPORUČENO**
- Konfigurátor běží jako aplikace na Cloudflare (Worker + D1 + Pages) — náš domovský stack.
- E-shopař klikne, vidí živý náhled svého skutečného e-shopu, uloží.
- Worker vygeneruje statický CSS soubor s `:root { --... }` a nasadí ho na CDN.
- Šablona v e-shopu načítá tenhle jeden soubor.
- **Plus:** živý náhled, verzování, rollback, presety, validace kontrastu, žádný limit 8192 znaků, jedna instalace obsluhuje všechny klienty, přirozený bod pro měsíční licenci.
- **Minus:** klient je závislý na naší infrastruktuře (což je z obchodního hlediska spíš plus).

**(b) HTML kódy v Shoptet administraci s vygenerovaným blokem**
- Konfigurátor vygeneruje blok `:root{...}`, e-shopař ho zkopíruje do administrace.
- **Plus:** žádná runtime závislost na nás, funguje i když nám vypadne infrastruktura.
- **Minus:** limit 8192 znaků (dostatečné pro tokeny, ne pro víc), ruční copy-paste = chybovost, žádný živý náhled, žádný rollback.
- **Verdikt:** ne jako hlavní cesta, **ano jako fallback a exit strategie.** Tlačítko "Exportovat jako statický CSS blok" v konfigurátoru. Klient tak nikdy není v rukojmí — což se dobře prodává.

**(c) SFTP nasazení vygenerovaného souboru**
- Worker po uložení pushne CSS přes SFTP do `/user/documents/`.
- **Plus:** soubor je hostovaný na shoptetí CDN, nulová runtime závislost na nás, žádný limit velikosti.
- **Minus:** potřebujeme SFTP přístupy klienta, deploy je asynchronní.
- **Verdikt:** **kombinovat s (a).** Konfigurátor je náš, výstup končí na shoptetí CDN.

### Doporučená architektura

```
NEXUS Theme Studio (Cloudflare Pages)
    ↓ e-shopař klikne, vidí živý náhled
NEXUS Worker  (validace kontrastu, dopočet škál, verzování v D1)
    ↓ vygeneruje theme.css  (~4-8 KB)
SFTP push → /user/documents/assets/theme.css  na shoptetí CDN
    ↓
E-shop načítá:  <link href=".../theme.css?v=42">
    ↑ tenhle jediný řádek je v HTML kódech (vejde se do 8192 znaků s rezervou)
```

**Klíčová vlastnost:** produkční e-shop **nevolá naši infrastrukturu za běhu.** Konfigurátor generuje statický soubor. Když nám spadne Worker, e-shopy jedou dál. To je rozdíl mezi produktem a rizikem.

## 3.4 CSS custom properties jako přenosový formát

**[OVĚŘENO]** Shoptet sám používá CSS custom properties (`--color-primary`, `--template-font`) a dokumentuje jejich použití v externím CSS. Přenos konfigurace přes `:root { --... }` je tedy **platformou podporovaný postup, ne hack.**

**Zásadní návrhové rozhodnutí — nepřebíjíme shoptetí proměnné, stavíme nad nimi:**

```css
:root {
  /* 1. Most k Shoptetu: bereme, co si klient nastavil v administraci,
        s vlastním fallbackem. Nastavení v Shoptet adminu se propíše k nám. */
  --lc-brand:        var(--color-primary,   #1C1917);
  --lc-brand-hover:  var(--color-primary-hover, #292524);
  --lc-cta:          var(--color-secondary, #A16207);
  --lc-font-body:    var(--template-font, 'Inter', system-ui, sans-serif);
  --lc-font-head:    var(--template-headings-font, var(--lc-font-body));

  /* 2. Vygenerované konfigurátorem — to, co Shoptet neumí */
  --lc-density: 1;              /* 0.75 kompakt | 1 standard | 1.35 vzdušné */
  --lc-radius-base: 8px;
  --lc-shadow-1: 0 1px 2px rgb(0 0 0 / .06);
  --lc-type-scale: 1.25;        /* modular scale ratio */

  /* 3. Dopočtené — nikdy je e-shopař nezadává ručně */
  --lc-on-brand: #FFFFFF;       /* validováno na kontrast ≥ 4.5:1 */
  --lc-space-3: calc(12px * var(--lc-density));
  --lc-text-lg: calc(1rem * var(--lc-type-scale));
}
```

Efekt: když klient v Shoptet administraci změní barvu, náš design se přizpůsobí, protože jedeme přes `var()` s fallbackem. Nebojujeme s platformou.

**[ODHAD]** Nutno ověřit, zda Shoptet vkládá své CSS proměnné i v blank režimu (kde se vypíná načítání jejich CSS). Fallbacky to pokrývají, ale chování je třeba změřit.

## 3.5 Nesmí jít rozbít — mantinely

Tohle je ta část, kvůli které je z konfigurátoru produkt a ne minové pole.

### Kontrast se hlídá automaticky
Barva textu se **nikdy nevybírá, vždy dopočítává.** Worker spočte kontrastní poměr a vybere světlou nebo tmavou variantu tak, aby splňoval **WCAG AA (4.5:1 pro text, 3:1 pro velký text a UI prvky)**.

Když si e-shopař zvolí barvu, na které nejde dosáhnout kontrastu (světle žlutá jako pozadí tlačítka), konfigurátor **nabídne nejbližší použitelný odstín** místo chybové hlášky. Nikdy neřekne "ne" — řekne "takhle to bude čitelné".

### Typografie z jednoho parametru
Celá škála je `base × ratio^n`. E-shopař hýbe base a ratio, ne dvanácti čísly. Nemůže vyrobit nadpis menší než odstavec.

### Minimální hodnoty jsou zamčené
- Základní velikost textu **nikdy pod 15px** (16px doporučeno).
- Klikací plocha **nikdy pod 44×44px**.
- Focus ring nejde vypnout — jde jen změnit jeho barva (a ta se validuje na kontrast).
- Line-height v odstavcích nejde pod 1.4.

### Živý náhled a návrat zpět
- Náhled běží nad **skutečným e-shopem klienta** (proxy princip jako Shoptet Bender, viz 4.4), ne nad demo daty. Klient vidí své produkty, své fotky.
- Náhled ve všech třech breakpointech vedle sebe.
- **"Vrátit do výchozího stavu"** na každé sekci zvlášť i globálně.
- **Verzování v D1** — každé uložení je nová verze, rollback jedním kliknutím. (Splňuje naše pravidlo "rollback je součástí změny".)
- **Dry-run:** konfigurace se publikuje až po explicitním "Publikovat". Do té doby žije jen v náhledu.

### Presety jako startovní bod
Nikdy prázdné plátno. **6 hotových vzhledů**, každý s kompletní sadou tokenů:

| Preset | Charakter | Pro koho |
|---|---|---|
| **Sklad** | vysoká hustota, ostré rohy, bez stínů, funkční | velký sortiment, B2B, náhradní díly |
| **Butik** | vzdušný, serifové nadpisy, jemné stíny, velké fotky | móda, šperky, dárky |
| **Technika** | tmavá varianta výchozí, monospace v parametrech, ostré | elektronika, gaming, nářadí |
| **Přírodní** | teplé neutrály, zaoblené rohy, měkké | kosmetika, potraviny, drogerie |
| **Kontrast** | maximálně čitelné, velký text, silné rámečky | starší cílovka, přístupnost |
| **Neutrální** | výchozí, bezpečný, dobře snese jakoukoli barvu | univerzální start |

Preset se **aplikuje a pak dolaďuje.** E-shopař řeší "chci to o něco vzdušnější", ne "jaký mám zvolit letter-spacing".

## 3.6 Co e-shopař nastaví sám vs. co vyžaduje nás

Ostrá hranice — tohle je obchodní model, ne technický detail.

### ✅ Self-service (v ceně licence konfigurátoru)

| Oblast | Rozsah |
|---|---|
| Barvy | primární, akcentní, neutrální ladění, stavové, dark mode |
| Typografie | font pár z kurátorovaného seznamu, měřítko, váha nadpisů |
| Hustota | vzdušnost, šířka obsahu, počet sloupců na všech breakpointech |
| Osobnost | rádiusy, stíny, rámečky, poměry obrázků |
| Komponenty | varianta karty, hlavičky, patičky, tlačítek, badge |
| Obsah karty | co se zobrazuje a v jakém pořadí |
| Detail produktu | pořadí a viditelnost bloků |
| Dlaždice | obrázek, popisek, pořadí, velikost, barevné ladění, viditelnost |
| Presety | aplikace, uložení vlastního presetu, rollback |
| Homepage | pořadí sekcí ze zapouzdřené knihovny |

### 🔧 Vyžaduje nás (placená služba)

| Oblast | Proč | Typ |
|---|---|---|
| Prvotní nasazení | blank režim, SFTP, HTML kódy, propojení konfigurátoru | jednorázově |
| Nový font mimo seznam | licence, testování češtiny, subsetting, ověření výkonu | jednorázově |
| Nová varianta komponenty | vývoj CSS + JS, testování napříč presety | jednorázově |
| Nový typ dlaždice / layout mozaiky | nová logika mřížky | jednorázově |
| Zásah do nákupního procesu | nejcitlivější část, mimo konfigurátor záměrně | jednorázově |
| Integrace NEXUS modulů | poukazy, tiery, dynamické ceny | setup + měsíčně |
| Kompatibilita s doplňkem třetí strany | konflikt CSS/JS, nutná analýza | podle rozsahu |
| Aktualizace šablony Shoptetem | platforma změní třídy, musíme reagovat | v ceně údržby |

**Pravidlo hranice:** *co se dá vyjádřit tokenem nebo přepínačem, je self-service. Co vyžaduje nový kód, je služba.*

Nová varianta komponenty vyvinutá pro jednoho klienta se přidá do systému a je pak dostupná všem — každá zakázka rozšiřuje produkt.

---

# ČÁST IV — DESIGNOVÝ SMĚR (výchozí preset + mantinely)

> Pozn.: následující není "jak bude šablona vypadat". Je to **výchozí preset "Neutrální"** a mantinely, uvnitř kterých se všechny ostatní presety a klientské konfigurace pohybují.

## 4.1 Barevný systém

Výchozí paleta (preset Neutrální) — teplá neutrální s tlumeným zlatým akcentem. Záměrně nízkosytá základna, aby fotky produktů zůstaly hlavním barevným prvkem stránky.

| Role | Light | Poznámka |
|---|---|---|
| Primární | `#1C1917` | téměř černá, teplá |
| Na primární | `#FFFFFF` | dopočteno |
| Akcent / CTA | `#A16207` | konverzní, oddělený od primární |
| Na akcentu | `#FFFFFF` | dopočteno, ověřeno na 4.5:1 |
| Pozadí | `#FAFAF9` | ne čistě bílá — méně únavné |
| Popředí | `#0C0A09` | |
| Karta | `#FFFFFF` | odliší se od pozadí bez rámečku |
| Tlumené | `#E8ECF0` / text `#475569` | |
| Rámeček | `#D6D3D1` | |
| Chyba | `#DC2626` | |

Dark varianta se dopočítá — ne inverzí, ale posunem světlosti při zachování odstínu, s korekcí sytosti (syté barvy na tmavém pozadí vibrují).

**Mantinely:**
- Akcentní barva se nesmí použít na nic jiného než konverzní akce. Když je "koupit" i "více informací" stejnou barvou, zákazník neví kam.
- Sytá barva max. na ~10 % plochy obrazovky.
- Stavové barvy (sleva, skladem) nesmí kolidovat s akcentní.

## 4.2 Typografie

Výchozí pár: **Inter** (text) + **Inter Tight / Cormorant** (nadpisy podle presetu). Kritérium výběru pro celý kurátorovaný seznam:

1. **Kompletní česká diakritika** včetně `ř ž č ě ů ú`, správně kreslené — ne autogenerované.
2. **Variabilní řez** — jeden soubor místo 5 vah, zásadní pro výkon.
3. **Čitelnost v malých velikostech** — ceny a parametry se čtou na 13–14px.
4. **Tabulární číslice** (`font-variant-numeric: tabular-nums`) — ceny ve sloupci musí být zarovnané. Tohle na českých e-shopech skoro nikdo neřeší a je to okamžitě vidět.

Škála (modular scale, výchozí ratio 1.25, base 16px):

```
12  →  popisky, meta
14  →  sekundární text, parametry
16  →  základní text  (nikdy níž)
20  →  podnadpisy, cena na kartě
25  →  nadpis sekce
31  →  nadpis stránky
39  →  hero
```

**Mantinely:** max. 2 rodiny na e-shop, max. 4 velikosti na obrazovku, řádka 60–75 znaků v souvislém textu.

## 4.3 Spacing a grid

Spacing škála je násobkem 4px, škálovaná parametrem hustoty:

```
--lc-space-1: calc(4px  * var(--lc-density));
--lc-space-2: calc(8px  * var(--lc-density));
--lc-space-3: calc(12px * var(--lc-density));
--lc-space-4: calc(16px * var(--lc-density));
--lc-space-6: calc(24px * var(--lc-density));
--lc-space-8: calc(32px * var(--lc-density));
--lc-space-12: calc(48px * var(--lc-density));
--lc-space-16: calc(64px * var(--lc-density));
```

Jeden parametr `--lc-density` (0.75 / 1 / 1.35) změní hustotu celého e-shopu konzistentně. Tohle je přesně to, co Shoptet nativně neumí a co e-shopař nejčastěji chce ("je to moc nahuštěné").

Grid: 12 sloupců na desktopu, 6 na tabletu, 4 na mobilu. Breakpointy 375 / 768 / 1024 / 1440.

## 4.4 Klíčové obrazovky

### Homepage
Ne carousel. **Dlaždicový rozcestník** (Část V) hned pod hlavičkou — Baymard uvádí, že **42 % e-shopů neumožní z homepage pochopit, co vlastně prodávají.** Dlaždice tenhle problém řeší přímo.

Pořadí: hlavička → hledání (viditelné, ne ikonka) → dlaždicová mozaika kategorií → 1 obsahový blok (novinky / bestsellery) → důvěryhodnost (doprava, vrácení, kontakt) → patička.

### Kategorie
Filtry jako **první tříditelný obsah**, ne schované pod tlačítkem na mobilu. Aktivní filtry vždy viditelné jako odstranitelné čipy. Řazení jako select, ne jako 6 tlačítek. Stránkování číslované (ne nekonečný scroll — zabíjí patičku a návrat zpět).

Na vstupu do kategorie s podkategoriemi: **dlaždice podkategorií** nad výpisem produktů.

### Detail produktu
Nad ohybem: galerie, název, cena, varianty, dostupnost, CTA. Doprava a dostupnost **před** dlouhým popisem — Baymard opakovaně ukazuje, že tohle je nejčastější důvod odchodu.

Sticky lišta s cenou a CTA při scrollu na mobilu.

### Košík
Přehledný, bez nabízení věcí navíc nad ohybem. Změna množství bez reloadu (přes `shoptet.cartShared.updateQuantityInCart`). Zde žije **kreditní poukaz NEXUS** (Část VI).

### Checkout
**Minimální zásahy.** Nejcitlivější a nejlépe otestovaná část platformy. Sjednotíme typografii, spacing a barvy tlačítek. Strukturu neměníme. Riziko rozbití konverze převyšuje estetický zisk.

## 4.5 Performance rozpočet

Prémiovost = rychlost. Rozpočet pro první načtení kategorie na 4G:

| Metrika | Cíl | Strop |
|---|---|---|
| LCP | < 1.8 s | 2.5 s |
| CLS | < 0.05 | 0.1 |
| INP | < 150 ms | 200 ms |
| CSS (kritické, inline) | < 14 KB | 20 KB |
| CSS (celkem) | < 45 KB gzip | 60 KB |
| JS (náš) | < 35 KB gzip | 50 KB |
| Fonty | 2 soubory, variabilní | 3 |
| Obrázky nad ohybem | AVIF/WebP, `fetchpriority=high` | — |

Pravidla:
- **Žádný jQuery v našem kódu.** Vanilla JS. (Shoptet si své jQuery přinese, to neovlivníme; v blank režimu ho můžeme odstřihnout.)
- **Žádná CSS knihovna.** Tokeny + vlastní CSS. Tailwind by se v blank režimu dal použít, ale přidává build složitost bez adekvátního zisku pro fixní sadu komponent.
- **Font `display: swap`** + preload primárního řezu, subsetting na latin + latin-ext.
- **Reserve space** pro každý obrázek (`aspect-ratio`) — CLS je na e-shopech ubíjející a přitom triviálně řešitelný.
- `content-visibility: auto` na sekce pod ohybem.
- **prefers-reduced-motion** respektovat u všech animací.

---

# ČÁST V — DLAŽDICOVÁ NAVIGACE (určující směr)

## 5.1 Proč dlaždice — a čím jsou podložené

**[OVĚŘENO — NN/G]** Skrytá navigace (hamburger, dropdown) měřitelně zhoršuje UX: viditelnost obsahu klesá **o více než 20 %** oproti viditelné nebo kombinované navigaci. Viditelná navigace zvyšuje pravděpodobnost dokončení úkolu bez návratu k vyhledávání. NN/G také uvádí, že dropdown se **dvěma úrovněmi je frustrující**.

**[OVĚŘENO — Baymard]** Konkrétní data z e-commerce výzkumu:
- **42 %** e-shopů neumožní z homepage pochopit, jaký sortiment nabízejí,
- **38 %** má chybnou hloubku kategoriální struktury (uživatelé se ztrácejí),
- **34 %** postrádá tematické filtrování ("jarní bunda"),
- **30 %** má auto-rotující karusely, které Baymard označuje za *"major issues"* na dotykových zařízeních.

**Dlaždice řeší přímo tři z těchto čtyř problémů:**

| Problém | Jak to dlaždice řeší |
|---|---|
| Homepage neukáže sortiment (42 %) | dlaždice **jsou** sortiment — vidíš ho, než na cokoli klikneš |
| Chybná hloubka struktury (38 %) | jedna úroveň na obrazovku, jasně vizuálně; postup po krocích místo skrytého stromu |
| Auto-carousel (30 %) | dlaždicová mozaika nahradí carousel — statická, celá viditelná, bez časového tlaku |

**Kde dlaždice vyhrávají nejvíc:**
1. **Na mobilu** — hamburger na mobilu je nejhorší varianta skryté navigace. Dlaždice je prst-friendly (velký cíl, min. 44px), viditelná bez interakce.
2. **U širokého sortimentu** — když zákazník nezná vaši terminologii, obrázek řekne víc než "Komponenty".
3. **U zákazníka, který neví, co hledá** — objevování je vizuální proces. Textový seznam nutí k překladu do slov; dlaždice ho obejde.
4. **U vizuálních kategorií** — móda, dárky, jídlo, kosmetika.

## 5.2 Kde se dlaždice objevují

| Umístění | Role |
|---|---|
| **Homepage — hlavní rozcestník** | mozaika hlavních kategorií, nahrazuje carousel; hlavní obsah nad ohybem |
| **Vstup do kategorie** | dlaždice podkategorií nad výpisem produktů; sekundární velikost |
| **Podkategorie** | menší dlaždice jako pruh nad filtry, pokud existuje další úroveň |
| **Tematické vstupy** | "Dárky do 500 Kč", "Novinky", "Výprodej" — řeší Baymardových 34 % chybějícího tematického filtrování |
| **Vizuální filtry** | barva, značka, materiál jako dlaždice místo checkboxů (kde to dává smysl) |
| **Prázdný stav vyhledávání** | Baymard: **88 %** e-shopů má generickou "no results" stránku. Dlaždice tam patří místo tipů. |
| **Košík — cross-sell** | ⚠️ **jen pod primárním obsahem**, nikdy nad. Košík je konverzní obrazovka, ne objevovací. |
| **404** | dlaždice místo slepé uličky |

## 5.3 Anatomie dlaždice

```
┌─────────────────────────────┐
│                             │  ← obrázek / ikona
│         [vizuál]            │     aspect-ratio zamčený
│                             │     object-fit: cover
│                             │
├─────────────────────────────┤
│  Název kategorie            │  ← popisek, max 2 řádky
│  128 položek                │  ← počet (volitelný)
└─────────────────────────────┘
```

**Prvky:**

| Prvek | Pravidlo |
|---|---|
| **Vizuál** | fotka nebo SVG ikona. **Dlaždice musí fungovat i bez něj** — fallback je barevná plocha s iniciálou/ikonou, ne prázdné místo. |
| **Popisek** | vždy povinný. **Nikdy text jen v obrázku** — nepřečte ho vyhledávač ani screen reader. |
| **Počet položek** | volitelný. Užitečný signál rozsahu, ale škodí, když je nízký ("3 položky" odradí). Konfigurovatelné: vždy / jen nad prahem / nikdy. |
| **Overlay** | když text leží na fotce, **povinný gradient** pro kontrast. Kontrast se validuje. |
| **Hover / focus** | jemné zvětšení obrázku (scale 1.03) uvnitř přetečení, ne zvětšení celé dlaždice (skákal by layout). Focus ring vždy viditelný. |
| **Tap stav** | na dotyku není hover — potřebujeme viditelnou aktivní odezvu do 100 ms. |

**Velikostní varianty:**

| Varianta | Rozměr v mřížce | Použití |
|---|---|---|
| **Hero** | 2×2 | hlavní kategorie, sezónní kampaň |
| **Široká** | 2×1 | druhá úroveň důležitosti |
| **Vysoká** | 1×2 | módní/vizuální kategorie (na výšku sedí produktu) |
| **Standard** | 1×1 | běžná kategorie |
| **Kompakt** | 1×1 bez obrázku | dlouhý ocas kategorií, jen text + ikona |

**Poměry stran:** hero 16:9 nebo 3:2, standard 1:1 nebo 4:5, kompakt bez obrázku. Poměr je **zamčený v tokenu**, e-shopař vybírá z presetu — jinak by nekonzistentní fotky rozbily mřížku.

## 5.4 Mřížkový systém (bento)

CSS Grid, `grid-auto-flow: dense` pro zaplnění mezer.

```css
.lc-tiles {
  display: grid;
  gap: var(--lc-space-4);
  grid-auto-flow: dense;
  grid-template-columns: repeat(2, 1fr);          /* mobil 375px */
}
@media (min-width: 768px)  { .lc-tiles { grid-template-columns: repeat(4, 1fr); } }
@media (min-width: 1024px) { .lc-tiles { grid-template-columns: repeat(6, 1fr); } }

.lc-tile--hero  { grid-column: span 2; grid-row: span 2; }
.lc-tile--wide  { grid-column: span 2; }
.lc-tile--tall  { grid-row: span 2; }
```

**Responzivní chování:**

| Breakpoint | Sloupců | Hero zabírá | Poznámka |
|---|---|---|---|
| 375 (mobil) | 2 | celou šířku (2 sl.) | hero degraduje na širokou, ne 2×2 — jinak zabere celou obrazovku |
| 768 (tablet) | 4 | 2×2 | |
| 1024 (desktop) | 6 | 2×2 | |
| 1440+ | 6 | 2×2 | mřížka se nerozšiřuje, roste gap a max-width kontejneru |

**Mantinel:** hero dlaždice je **max. jedna na obrazovku**. Dvě hero dlaždice vedle sebe znamenají, že žádná není hero — hierarchie se zruší.

**[ODHAD]** Riziko `grid-auto-flow: dense`: mění vizuální pořadí oproti DOM pořadí, což **rozbíjí tab order** (klávesnice půjde jinak, než oko vidí). Řešení: dense používat jen tam, kde pořadí není sémanticky důležité, a DOM pořadí držet co nejblíž vizuálnímu. Nutno otestovat na reálné konfiguraci.

## 5.5 Jak e-shopař spravuje dlaždice bez kódu

V konfigurátoru (Část III) je obrazovka "Dlaždice":

1. **Seznam kategorií se načte** z e-shopu (přes XML feed nebo parsováním navigace — viz "co ověřit").
2. Ke každé kategorii e-shopař nastaví:
   - **obrázek** (upload, automatický ořez na správný poměr, konverze do AVIF/WebP, generování LQIP),
   - **velikost** (hero / široká / vysoká / standard / kompakt),
   - **pořadí** (přetažením),
   - **viditelnost** (na homepage ano/ne — ne všechny kategorie patří do rozcestníku),
   - **barevné ladění** overlaye (z palety, kontrast se validuje automaticky),
   - **volitelný vlastní popisek** (jinak se použije název kategorie).
3. **Živý náhled** vedle, ve třech breakpointech.
4. **Automatická kontrola:** konfigurátor upozorní, když je hero dlaždic víc než jedna, když chybí obrázek, když kontrast textu na fotce nesplňuje AA, nebo když je obrázek moc malý pro hero velikost.

**Bez obrázků to musí fungovat.** Nový klient nemá kategoriální fotky. Fallback: barevná plocha odvozená z palety + ikona z kurátorované sady. Vypadá to záměrně, ne rozbitě. Klient si fotky doplní postupně.

## 5.6 Přístupnost dlaždic

Nesmlouvavá pravidla:

```html
<!-- SPRÁVNĚ: celá dlaždice je odkaz -->
<a class="lc-tile lc-tile--hero" href="/damske-bundy/">
  <img src="..." alt="" width="800" height="450" loading="lazy" decoding="async">
  <span class="lc-tile__label">Dámské bundy</span>
  <span class="lc-tile__count">128 položek</span>
</a>
```

- **`<a>`, nikdy `<div onclick>`.** Klávesnice, prostřední tlačítko, otevření na novou kartu, sdílení odkazu — to vše musí fungovat zdarma.
- **Obrázek je dekorativní** (`alt=""`), protože text je vedle v DOM. Duplicitní alt = screen reader přečte název dvakrát.
- **Viditelný focus ring** — nikdy `outline: none`. Ring musí být vidět i na tmavé fotce (dvojitý obrys: světlý + tmavý).
- **Klikací plocha ≥ 44×44px** i u nejmenší kompaktní dlaždice.
- **Sémantika seznamu**: dlaždicová navigace je `<nav>` obsahující `<ul>/<li>` — screen reader oznámí "seznam, 12 položek".
- **Kontrast textu na fotce ≥ 4.5:1** — vynucený gradient overlay, validovaný v konfigurátoru.
- **Bez obrázků a bez CSS** musí zůstat srozumitelný seznam odkazů.

## 5.7 Performance dlaždic

Dlaždice = hodně obrázků = největší výkonnostní riziko celé šablony. Bez disciplíny to zabije LCP.

| Opatření | Detail |
|---|---|
| **Formáty** | AVIF s WebP fallbackem přes `<picture>`; konverzi dělá konfigurátor při uploadu, ne e-shopař |
| **Responzivní sady** | `srcset` + `sizes` — hero dlaždice potřebuje 1600px, kompaktní 200px. Poslat všem 1600px je nejčastější chyba. |
| **Lazy loading** | `loading="lazy"` na vše **kromě dlaždic nad ohybem** (typicky první 2–4). Ty naopak `fetchpriority="high"`. |
| **Rezervace místa** | `aspect-ratio` v CSS + `width`/`height` na `<img>` — CLS = 0 |
| **LQIP** | rozmazaný base64 placeholder (~300 B) jako `background-image` dlaždice; obrázek na něj dosedne bez probliknutí |
| **Dekódování** | `decoding="async"` |
| **Rozpočet** | dlaždicová mozaika na homepage **max. 250 KB** celkem po optimalizaci |
| **Počet** | max. **12 dlaždic** v hlavním rozcestníku. Víc = paralýza volby i výkonnostní problém. |
| **Hostování** | obrázky na shoptetí CDN (`cdn.myshoptet.com`) přes SFTP, ne na naší infrastruktuře |

## 5.8 Kdy jsou dlaždice HORŠÍ — a jak to ošetřit

Poctivá část. Dlaždicová navigace **není univerzálně lepší** a tvářit se tak by byl trend pro trend.

| Situace | Proč dlaždice selhávají | Ošetření |
|---|---|---|
| **200+ kategorií** | dlaždice se nedají odscrollovat; vizuální skenování má strop kolem 12–15 položek | dlaždice **jen pro top úroveň** (max. 12); pod nimi klasický textový rozcestník pro dlouhý ocas. Dlaždice jsou vstupní brána, ne kompletní mapa. |
| **Opakovaný nákup** | zákazník kupuje potřetí totéž; dlaždice ho nutí procházet cestu znovu | **"Znovu objednat"** a "Poslední objednávky" viditelně v hlavičce pro přihlášené. Obchází navigaci úplně. |
| **Hledání konkrétního SKU** | zákazník zná kód dílu; dlaždice jsou překážka | **Vyhledávání jako plnohodnotný prvek**, ne ikonka lupy. Baymard: search je preferovaná strategie a uživatelé ho vnímají jako rychlejší než navigaci. |
| **Nevizuální sortiment** | šrouby, chemie, náhradní díly — fotka nic neřekne | preset "Sklad": kompaktní dlaždice **bez obrázků**, jen ikona + název + počet. Vizuální hierarchie zůstane, vizuální šum zmizí. |
| **Úzký sortiment (< 6 kategorií)** | dlaždice jsou overkill | konfigurátor nabídne jednodušší variantu; při méně než 4 kategoriích dlaždicový rozcestník nedoporučí |
| **Pomalé připojení** | obrázková navigace = pomalá navigace | LQIP + přísný rozpočet (5.7); při `saveData` nebo pomalém spojení degradovat na kompaktní dlaždice bez fotek |

**Zastřešující princip — dvě rychlosti:**

> **Dlaždice jsou pro objevování. Vyhledávání a historie objednávek jsou pro cíl.** Obojí musí být viditelné současně. Zákazník, který ví co chce, se nikdy nesmí muset prokousat dlaždicemi.

Proto je **vyhledávací pole vždy viditelné v hlavičce** (ne pod ikonkou), s napovídáním, které — dle Baymardu (72 % e-shopů to nemá) — **obsahuje i návrhy kategorií, ne jen produktů.** To je levné rozlišení proti konkurenci.

## 5.9 Technická realita: jak dlaždice na Shoptetu vůbec postavit

**Zde se špičkový nápad potkává s platformou.** Shoptet nám nedá vlastní HTML. Dlaždice tedy musí vzniknout jedním ze tří způsobů:

**(a) CSS transformace existující navigace** — vzít shoptetí `<ul>` kategorií a přestylovat na mřížku.
- Plus: nulový JS, funguje bez JS, sémantika je správná už od Shoptetu, přežije aktualizace lépe.
- Minus: obrázky kategorií musíme dodat zvenčí (Shoptet je v menu nerenderuje) → přes CSS `background-image` navěšený podle URL kategorie z vygenerovaného CSS.
- **[ODHAD]** Elegantní: konfigurátor vygeneruje do `theme.css` pravidla typu `[href$="/damske-bundy/"] { --tile-img: url(...); --tile-span: hero; }`. **Žádný JS, žádné riziko.**

**(b) JS enhancement** — po `ShoptetDOMContentLoaded` přeskládat DOM, doplnit obrázky a velikosti.
- Plus: plná kontrola nad strukturou.
- Minus: riziko FOUC, závislost na struktuře, kterou Shoptet může změnit, horší výkon, nutnost hlídat duplicitní navěšení.

**(c) Statický blok v HTML kódech** — dlaždice napsané ručně.
- Plus: plná kontrola.
- Minus: limit 8192 znaků, nesynchronizuje se s kategoriemi, neškáluje jako produkt. **Nepoužívat.**

**Doporučení: (a) jako primární cesta, (b) jen pro to, co (a) neumí** (např. počty položek, pokud nejsou v DOM). Čistě CSS řešení je odolnější vůči aktualizacím Shoptetu, rychlejší a přístupnější — a hlavně u produktu určeného pro mnoho klientů je nižší riziko cennější než vyšší flexibilita.

---

# ČÁST VI — STRUKTURA PROJEKTU

## 6.1 Adresářová struktura

```
lcode-shoptet-theme/
├── src/
│   ├── tokens/
│   │   ├── _bridge.css          # most na shoptetí --color-* proměnné
│   │   ├── _scale.css           # dopočtené škály (spacing, typo)
│   │   └── presets/             # 6 presetů jako sady tokenů
│   │       ├── sklad.json
│   │       ├── butik.json
│   │       ├── technika.json
│   │       ├── prirodni.json
│   │       ├── kontrast.json
│   │       └── neutralni.json
│   ├── base/
│   │   ├── reset.css
│   │   ├── typography.css
│   │   └── a11y.css             # focus rings, sr-only, reduced-motion
│   ├── components/
│   │   ├── tiles.css            # ⭐ dlaždicový systém
│   │   ├── product-card.css     # 4 varianty
│   │   ├── header.css           # 3 varianty
│   │   ├── footer.css
│   │   ├── buttons.css
│   │   ├── badges.css
│   │   ├── filters.css
│   │   └── forms.css
│   ├── pages/
│   │   ├── homepage.css
│   │   ├── category.css
│   │   ├── product.css
│   │   ├── cart.css
│   │   └── checkout.css         # jen typografie a barvy, minimum
│   ├── js/
│   │   ├── core/
│   │   │   ├── shoptet-bridge.js   # obal nad shoptet.* API
│   │   │   ├── events.js           # bezpečné navěšování (anti-duplikace)
│   │   │   └── dom.js
│   │   ├── modules/
│   │   │   ├── tiles.js            # jen to, co CSS neumí
│   │   │   ├── sticky-cta.js
│   │   │   ├── filters.js
│   │   │   └── gallery.js
│   │   └── nexus/                  # ⭐ integrační vrstva NEXUS
│   │       ├── voucher.js
│   │       ├── loyalty-price.js
│   │       └── dynamic-discount.js
│   └── index.css
├── config/
│   └── clients/                 # konfigurace per klient (git, ne v adminu)
│       ├── okfish.json
│       ├── hecmania.json
│       └── cistytriko.json
├── dist/                        # build výstup — do gitu nepatří
├── tools/
│   ├── build.mjs                # esbuild
│   ├── generate-theme.mjs       # tokeny JSON → theme.css
│   ├── contrast.mjs             # WCAG validátor (sdílený s Workerem)
│   └── deploy-sftp.mjs          # SFTP nasazení + dry-run
├── docs/
│   ├── CLASS-MAP.md             # ⭐ mapa shoptetích tříd, na kterých závisíme
│   ├── PROGRESS_LOG.md
│   └── INCIDENTS.md
├── package.json
└── README.md
```

## 6.2 Build — ano, je možný

**[OVĚŘENO]** Build step je plně možný. Shoptet neřeší, jak soubor vznikl — jen ho načte z `/user/documents/`. Historický `templates-custom-theme` používal Grunt; my použijeme moderní stack.

**Doporučení: esbuild.** Rychlý, jedna závislost, zvládá CSS i JS bundling.

```
npm run dev      # Bender proxy + watch + živý reload nad reálným e-shopem
npm run build    # produkční bundle, minifikace, rozpočtová kontrola
npm run theme    # tokeny JSON → theme.css pro konkrétního klienta
npm run deploy   # SFTP push (--dry-run povinný před ostrým během)
npm run budget   # selže, když se překročí velikostní rozpočet z 4.5
```

**Pravidlo Zero Error Tolerance:** `npm run build` musí selhat při překročení rozpočtu. Ne varovat — selhat.

**Pinované verze.** Žádný `^`. Upgrady vědomě a testovaně.

## 6.3 Verzování

- **Git**, jeden repozitář pro šablonu, konfigurace klientů v `config/clients/`.
- **SemVer** šablony: `MAJOR` = rozbití kompatibility konfigurace, `MINOR` = nová komponenta/varianta, `PATCH` = oprava.
- **Cache-busting** query stringem `?v=<verze>` — [OVĚŘENO] podporovaný postup.
- **Verze konfigurace klienta v D1** — každé uložení nová verze, rollback jedním kliknutím.
- **`docs/CLASS-MAP.md`** je kritický artefakt: seznam všech shoptetích tříd a DOM struktur, na kterých náš kód závisí. Když Shoptet vydá aktualizaci, tenhle soubor je checklist, co projít. Bez něj je údržba u 20 klientů neřiditelná.

## 6.4 Lokální vývoj — Shoptet Bender

**[OVĚŘENO]** `github.com/shoptet/shoptet-bender` — oficiální nástroj pro lokální vývoj.

- **Princip:** proxy mezi produkčním e-shopem a prohlížečem; injektuje lokální JS a CSS.
- **Live reload** přes Browsersync.
- **Struktura:** lokální `/src/` s adresáři `header/`, `footer/`, `orderFinale/`.
- **Spuštění:** `shp-bender --remote https://klient.cz/`
- **Flagy:** `--removeHeaderIncludes`, `--removeFooterIncludes` — **simulace blank režimu bez jeho zapnutí v produkci.**
- **Požadavky:** Node.js ≥ 18, instalace `yarn global add git+https://github.com/shoptet/shoptet-bender.git`

To poslední je zásadní: můžeme vyvíjet a demonstrovat blank šablonu nad reálným e-shopem klienta, **aniž bychom se čehokoli dotkli v produkci.** Splňuje naše pravidlo dry-run first. Bender je zároveň technický základ pro živý náhled v konfigurátoru.

**[OVĚŘENO]** Shoptet nabízí **deferred template updates** — možnost odložit kritické aktualizace šablon pro e-shopy s vlastním designem. Pro produkt nasazený u více klientů zásadní: dostaneme čas otestovat aktualizaci dřív, než dopadne na všechny.

---

# ČÁST VII — NAPOJENÍ NA NEXUS

## 7.1 Princip: rozšiřovací body, ne hacky

Tři pravidla:
1. **Šablona nezná NEXUS.** Vystavuje jen prázdné sloty a eventy. Když NEXUS není nasazený, šablona funguje beze změny.
2. **Veškerá business logika na Workeru.** Frontend nikdy nepočítá cenu, slevu ani zůstatek poukazu. (Organizační pravidlo, bod 3.)
3. **Graceful degradation.** Když Worker neodpoví, e-shop funguje se standardními cenami. Nikdy blokující spinner nad cenou.

## 7.2 Hooky v šabloně

Šablona definuje pojmenované sloty a vlastní eventy:

```js
// src/js/core/nexus-hooks.js  — součást šablony, ne NEXUSu
export const NEXUS_SLOTS = {
  cartVoucher:      '[data-lc-slot="cart-voucher"]',      // košík, nad souhrnem
  productPriceMeta: '[data-lc-slot="price-meta"]',        // detail, pod cenou
  cardPriceMeta:    '[data-lc-slot="card-price-meta"]',   // karta v kategorii
  headerTierBadge:  '[data-lc-slot="tier-badge"]',        // hlavička, u účtu
  cartTierSummary:  '[data-lc-slot="cart-tier"]',         // košík, souhrn úspory
};

// Šablona vysílá; NEXUS naslouchá
document.dispatchEvent(new CustomEvent('lc:cart:updated', { detail: { items } }));
document.dispatchEvent(new CustomEvent('lc:product:viewed', { detail: { productId } }));
```

Sloty vytvoří šablona při inicializaci (prázdné `<div>` na správných místech). NEXUS moduly je najdou a naplní. Když NEXUS chybí, sloty zůstanou prázdné a nezaberou místo (`:empty { display: none }`).

## 7.3 Kreditní poukaz v košíku

**Umístění:** nad souhrnem košíku, ne v checkoutu (checkout neupravujeme).

```js
document.addEventListener('ShoptetDOMCartContentLoaded', () => {
  const slot = document.querySelector(NEXUS_SLOTS.cartVoucher);
  if (!slot) return;
  renderVoucherWidget(slot);   // idempotentní — bezpečné při opakovaném volání
});
```

**[OVĚŘENO]** `ShoptetDOMCartContentLoaded` je dokumentovaný event pro reload obsahu košíku — přesně náš případ.

**⚠️ Kritické riziko:** dokumentace Shoptetu varuje před duplikací XHR requestů. Košík se překresluje AJAXem, takže naslouchač může proběhnout vícekrát a navěsit widget několikrát. **Řešení:** každý render je idempotentní (kontrola `data-lc-mounted`), listener se registruje jednou na `document`, ne na překreslovaný element. Do `INCIDENTS.md` jako známé riziko.

**Tok:**
1. Zákazník zadá kód poukazu → `POST /api/voucher/validate` na NEXUS Worker.
2. Worker ověří platnost a zůstatek (**server-side, vždy**).
3. Aplikace slevy proběhne **přes shoptetí mechanismus slevového kupónu**, ne přepsáním ceny v DOM.
4. Widget zobrazí zůstatek.

**[ODHAD] — nutno ověřit:** jak přesně aplikovat částečné čerpání kreditu na shoptetí objednávku. Kandidáti: dynamicky generovaný jednorázový slevový kupón přes Shoptet API, nebo dárkový poukaz. **Tohle je blokující otázka celého poukazového modulu** (viz `Digital-Voucher.md`).

## 7.4 Věrnostní tier a dynamické ceny

**[OVĚŘENO]** `dataLayer` obsahuje `order.customer.priceRatio` a `order.customer.registered` — přímý signál cenové skupiny zákazníka.

```js
document.addEventListener('ShoptetDataLayerUpdated', () => {
  const dl = getShoptetDataLayer();
  if (!dl?.order?.customer?.registered) return;
  applyTierPresentation(dl.order.customer.priceRatio);
});
```

**Zásadní rozhodnutí: ceny počítá Shoptet, ne my.**

Shoptet nativně umí cenové hladiny zákaznických skupin. Věrnostní tier tedy **řešíme přiřazením zákazníka do skupiny přes API** (server-side, batch), ne přepisováním cen v prohlížeči.

Frontend dělá pouze **prezentaci**:
- badge "Vaše úroveň: Stříbrná" v hlavičce,
- "Vaše cena" vs. "běžná cena" na detailu a kartě,
- "Ušetřili jste 340 Kč" v souhrnu košíku,
- "Do Zlaté úrovně vám zbývá 1 200 Kč" — motivace.

**Proč takhle:** cena zobrazená v DOM se pak vždy shoduje s cenou, za kterou objednávka reálně proběhne. Přepisování cen JavaScriptem je nejjistější cesta ke sporu se zákazníkem a k nesouladu mezi e-shopem a Pohodou. Bezpečnostní pravidlo (org. instrukce, bod 3) i zdravý rozum.

## 7.5 Vazba konfigurátoru na NEXUS

Konfigurátor **je** NEXUS modul, ne samostatná aplikace:

```
NEXUS
├── domains/theme/          ⭐ nová doména
│   ├── tokens.ts           # kanonický model tokenů
│   ├── presets.ts          # 6 presetů
│   ├── contrast.ts         # WCAG validace (sdílená s buildem šablony)
│   ├── generate.ts         # tokeny → CSS
│   └── deploy.ts           # SFTP push + dry-run + verzování
├── domains/voucher/        # existující — Digital Voucher
├── domains/pricing/        # existující — cenové hladiny, tiery
└── ui/theme-studio/        # konfigurátor (Cloudflare Pages)
```

Klient tak má **jeden login** do NEXUSu, kde si spravuje vzhled, poukazy i věrnostní program. To je ta hodnota, kterou samotná šablona nemá — a důvod, proč se licence platí měsíčně.

---

# ČÁST VIII — CO OVĚŘIT PŘED STARTEM

Blokující otázky. Bez odpovědí nelze začít stavět.

## Kritické (blokují rozhodnutí o architektuře)

| # | Otázka | Jak ověřit | Proč blokuje |
|---|---|---|---|
| 1 | **Jde blank režim nasadit klientovi bez Premium přes marketplace Doplňky?** Za jakých podmínek a jakou cenu? | `api@shoptet.cz` | Premium od ~12 tis./měs. vyřadí většinu klientů. Bez tohohle není produkt škálovatelný. |
| 2 | **Jsou shoptetí CSS proměnné (`--color-primary`) dostupné i v blank režimu?** | test na dev e-shopu s Benderem | Rozhoduje o celém mostu v `_bridge.css`. |
| 3 | **Jak aplikovat částečné čerpání kreditního poukazu na objednávku?** | dokumentace API + test | Blokuje celý poukazový modul. |
| 4 | **Jak moc jde upravit HTML struktura navigace pouze přes CSS?** | inspekce DOM Classic šablony | Rozhoduje mezi cestou (a) a (b) v sekci 5.9 — tedy jestli dlaždice budou robustní nebo křehké. |

## Vysoká priorita

| # | Otázka | Jak ověřit |
|---|---|---|
| 5 | Kompletní výpis `shoptet.scripts.availableCustomEvents`, `availableDOMLoadEvents`, `availableDOMUpdateEvents` na reálné instalaci | konzole na okfish.sk / hecmania.cz |
| 6 | Přesný rozsah povolených úprav nákupního procesu | dokumentace + dotaz na Shoptet |
| 7 | Kde vzít obrázky kategorií — má je Shoptet v datech, nebo je hostujeme sami? | XML feed + admin |
| 8 | Chování `deferred template updates` — jak dlouho lze odkládat, jak se aktivuje | dokumentace |
| 9 | Skutečná struktura tříd karty produktu napříč všemi 7 šablonami | inspekce → `CLASS-MAP.md` |
| 10 | Limity SFTP: velikost, počet souborů, rychlost, automatizovatelnost | test s `paramiko` |
| 11 | Jde přiřadit zákazníka do cenové skupiny přes API? | dokumentace API |

## Střední priorita

| # | Otázka |
|---|---|
| 12 | Chování šablony ve vícejazyčném e-shopu (okfish.sk je SK) |
| 13 | Konflikty s běžnými doplňky (Heureka, Zboží.cz, chatboti, dopravci) |
| 14 | Jak se náš CSS chová s Shoptet Designerem (drag-and-drop editor) |
| 15 | Změřit reálné Core Web Vitals výchozích šablon jako baseline |
| 16 | Licenční podmínky fontů pro komerční nasazení u více klientů |

---

# ČÁST IX — ODHAD ROZSAHU PRÁCE

**[ODHAD]** Všechny odhady předpokládají jednoho vývojáře na plný úvazek a **jsou platné až po zodpovězení kritických otázek z Části VIII.** Otázka č. 1 (marketplace vs. Premium) může zásadně změnit fázi 1.

| Fáze | Obsah | Odhad |
|---|---|---|
| **0. Průzkum** | zodpovězení kritických otázek, dump JS API, `CLASS-MAP.md`, baseline měření, dohoda se Shoptetem | **1–2 týdny** |
| **1. Základ** | build pipeline, tokenový systém, most na Shoptet, 6 presetů, reset, typografie, a11y základ | **2 týdny** |
| **2. Dlaždice** | CSS mřížka, varianty, responzivita, a11y, obrázková pipeline, fallbacky, integrace do navigace | **2–3 týdny** |
| **3. Komponenty** | karta produktu (4 varianty), hlavička (3), patička, tlačítka, badge, filtry, formuláře | **3 týdny** |
| **4. Obrazovky** | homepage, kategorie, detail, košík, minimální checkout | **2–3 týdny** |
| **5. Konfigurátor — backend** | doména `theme` v NEXUSu, generátor CSS, WCAG validátor, verzování v D1, SFTP deploy s dry-run | **3 týdny** |
| **6. Konfigurátor — UI** | Theme Studio, živý náhled přes Bender proxy, správa dlaždic, presety, rollback | **3–4 týdny** |
| **7. NEXUS integrace** | sloty, poukaz v košíku, tier prezentace, dynamické ceny | **2 týdny** |
| **8. Pilot** | nasazení na jednoho klienta, ladění, měření CWV, oprava nálezů | **2 týdny** |
| **9. Produktizace** | dokumentace pro e-shopaře, onboarding, druhý a třetí klient | **2 týdny** |

**Celkem: 22–28 týdnů** (~5–6,5 měsíce) do plně prodejného produktu.

**Minimální prodejná verze (MVP):** fáze 0–4 + 7 = **12–15 týdnů.** Šablona s dlaždicemi a NEXUS napojením, konfigurace zatím ručně přes JSON v gitu. Prodatelné jako služba, zatím ne jako self-service produkt. Konfigurátor (fáze 5–6) je to, co z toho udělá škálovatelný produkt — a je to zároveň největší kus práce. Nedoporučuji ho odkládat na neurčito, ale je legitimní ho nasadit až po ověření šablony na dvou klientech.

**Pilotní klient:** doporučuji **hecmania.cz** — Shoptet, vizuální sortiment (dlaždice dávají smysl), a už na něm řešíme cenový engine, takže NEXUS integrace navazuje na rozdělanou práci.

---

## Shrnutí rizik

| Riziko | Dopad | Ošetření |
|---|---|---|
| Shoptet změní strukturu tříd | šablona se rozbije u všech klientů naráz | `CLASS-MAP.md` + deferred template updates + CSS-first přístup u dlaždic |
| Blank režim jen pro Premium | produkt neprodatelný většině klientů | **ověřit jako první**, jednat o marketplace cestě |
| Konflikt s doplňky | klient si nainstaluje doplněk a rozbije si vzhled | zachovat shoptetí třídy, netlačit vlastní naming |
| Dlaždice zpomalí e-shop | ztráta hlavního argumentu prémiovosti | tvrdý rozpočet v buildu — build selže při překročení |
| E-shopař si nastaví nečitelný vzhled | poškození reputace naší šablony | vynucený kontrast, zamčená minima, presety |
| Konfigurátor jako single point of failure | výpadek u nás = problém u klientů | statický výstup na shoptetí CDN, produkce nevolá naši infrastrukturu |

---

## Zdroje

- [Shoptet Developers](https://developers.shoptet.com/)
- [How to edit templates](https://developers.shoptet.com/shoptet-tools/editing-templates/how-to-edit-templates/)
- [Blank template mode](https://developers.shoptet.com/shoptet-tools/editing-templates/blank-template-mode/)
- [Things to be careful about](https://developers.shoptet.com/shoptet-tools/editing-templates/things-to-be-careful-about/)
- [Shoptet Developers Tools (JS API)](https://developers.shoptet.com/shoptet-tools/editing-templates/shoptet-developers-tools/)
- [Tags and CSS variables](https://developers.shoptet.com/shoptet-tools/editing-templates/placeholders-not-only-for-template-colors/)
- [Information on design in the page code](https://developers.shoptet.com/shoptet-tools/editing-templates/information-on-design-in-the-page-code/)
- [Data Layer](https://developers.shoptet.com/shoptet-tools/data-layer/)
- [Shoptet Tools přehled](https://developers.shoptet.com/shoptet-tools/)
- [github.com/shoptet/templates-assets](https://github.com/shoptet/templates-assets)
- [github.com/shoptet/templates-custom-theme](https://github.com/shoptet/templates-custom-theme) (archivováno)
- [github.com/shoptet/shoptet-bender](https://github.com/shoptet/shoptet-bender)
- [Šablona obchodu — Shoptet Podpora](https://podpora.shoptet.cz/sablona-obchodu/)
- [NN/G — Hamburger Menus and Hidden Navigation Hurt UX Metrics](https://www.nngroup.com/articles/hamburger-menus/)
- [NN/G — Menu-Design Checklist](https://www.nngroup.com/articles/menu-design/)
- [NN/G — Mobile Subnavigation](https://www.nngroup.com/articles/mobile-subnavigation/)
- [Baymard — The State of Mobile E-Commerce Search and Category Navigation](https://baymard.com/blog/mobile-ecommerce-search-and-navigation)
