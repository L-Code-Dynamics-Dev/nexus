# Design Proposal: Digital Voucher / Kreditní poukaz

Status: **NÁVRH UZAVŘEN — všechna blokující rozhodnutí padla, připraveno
k implementaci Fáze A.**
Zdroj zadání: Jose (produkční architekt), rozhodnutí Lucky 2026-09-06.

Účel dokumentu: zafixovat DESIGN domény "digitální kreditní poukaz" dřív, než
vznikne jediný řádek implementace.

Historie dokumentu:
- 2026-09-06 (v1): zápis Josova zadání, tři body ponechány otevřené.
- 2026-09-06 (v2): Lucky uzavřel **(a) atomicita** a **(b) cesta do košíku**,
  doplnil no-API architekturu (frontend injection + Cloudflare Edge).
- 2026-09-06 (v3): Lucky uzavřel **(c) daňový režim** — víceúčelový poukaz
  (MPV) dle § 15b ZDPH, viz §15. **Žádný bod nezůstává otevřený.**

Umístění v repu: **`domains/voucher/`** (rozhodnutí Lucky) — vlastní doména
vedle `pricing`/`billing`, ne podčást billingu. Entity `Voucher` a
`VoucherTransaction` patří do `core/canonical/entities/` stejným vzorem jako
`Order.ts`, `Invoice.ts`.

---

## 1. Co zákazník kupuje (ROZHODNUTO)

Zákazník kupuje **digitální kreditní poukaz** — nikoli Shoptet slevový kupón.

- Hodnoty: 500 / 1000 / 1500 / 2000 Kč, nebo volná hodnota.
- Poukaz je **kredit**, ne procentuální sleva.
- Lze ho čerpat **postupně ve více objednávkách**.

```
Poukaz 1500 Kč
   → objednávka za 800 Kč   → zbývá 700 Kč
   → objednávka za 500 Kč   → zbývá 200 Kč
```

**Technika dynamické hodnoty (ROZHODNUTO, Lucky):** poukaz je v Shoptetu
produkt se základní cenou **1 Kč** a hodnota se tvoří **množstvím**
(1500 Kč = 1500 ks). Tím odpadá potřeba zakládat produkt pro každou nominální
hodnotu a umožňuje to volnou částku bez API.

> Důsledek pro UI: `N × 1 Kč` v košíku je pro zákazníka nečitelné — proto
> cart masking (sekce 6.1), který N položek sloučí do jednoho řádku
> „Dárkový poukaz (N Kč)“.

---

## 2. Architektura toku (ROZHODNUTO)

Voucher **není izolovaný skript**, je to plnohodnotná NEXUS doména se dvěma
toky — Issuance a Redemption:

```
Shoptet Order
      │
      ▼
NEXUS Worker
      │
      ├── Voucher Issuance
      │      ├── ověření objednávky
      │      ├── vytvoření voucheru
      │      ├── PDF
      │      └── e-mail (Resend)
      │
      └── Voucher Redemption
             │
             ├── validate
             ├── reserve / calculate
             └── atomic consume
                    │
                    ▼
                   D1
              vouchers
              voucher_transactions
```

---

## 3. D1 datový model (ROZHODNUTO — v2, rozšířeno oproti v1)

### Tabulka `vouchers`

```sql
CREATE TABLE IF NOT EXISTS vouchers (
    id              TEXT PRIMARY KEY,        -- kód, např. 'NEXUS-A8F9-2026'
    tenant_id       TEXT NOT NULL,           -- viz pozn. tenancy níže
    initial_balance REAL NOT NULL,
    current_balance REAL NOT NULL,
    currency        TEXT NOT NULL DEFAULT 'CZK',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at      TEXT NOT NULL,           -- NOW() + 1 ROK
    source_order_id TEXT NOT NULL,           -- objednávka, kterou byl zakoupen
    customer_email  TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'ACTIVE',
    version         INTEGER NOT NULL DEFAULT 0,  -- optimistický zámek, viz §7
    created_by      TEXT,
    metadata_json   TEXT,
    CHECK (current_balance >= 0),
    CHECK (current_balance <= initial_balance),
    CHECK (status IN ('ACTIVE','DEPLETED','EXPIRED','CANCELLED'))
);

CREATE INDEX IF NOT EXISTS idx_vouchers_email  ON vouchers(customer_email);
CREATE INDEX IF NOT EXISTS idx_vouchers_tenant ON vouchers(tenant_id, status);
```

### Tabulka `voucher_transactions`

```sql
CREATE TABLE IF NOT EXISTS voucher_transactions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    voucher_id TEXT NOT NULL,
    type       TEXT NOT NULL,     -- ISSUED|REDEEMED|EXPIRED|CANCELLED|REFUNDED
    amount     REAL NOT NULL,
    order_id   TEXT,              -- Shoptet objednávka, kde bylo čerpáno
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (voucher_id) REFERENCES vouchers(id),
    CHECK (type IN ('ISSUED','REDEEMED','EXPIRED','CANCELLED','REFUNDED'))
);

-- KRITICKÉ: idempotence dvojího webhooku vynucená schématem, ne kódem.
-- Stejná objednávka nesmí z téhož voucheru odečíst dvakrát. Partial index,
-- protože order_id je NULL u ISSUED/EXPIRED.
CREATE UNIQUE INDEX IF NOT EXISTS uq_voucher_redemption
    ON voucher_transactions(voucher_id, order_id)
    WHERE type = 'REDEEMED' AND order_id IS NOT NULL;
```

**Změny proti v1 a proč:**

| Změna | Důvod |
|---|---|
| `version INTEGER` | optimistický zámek — rozhodnutí (a), viz §7 |
| `UNIQUE(voucher_id, order_id) WHERE REDEEMED` | Lucky: „stejný webhook nesmí odečíst dvakrát“ — vynuceno DB, ne aplikací |
| `CHECK (current_balance >= 0)` | přečerpání nemožné na úrovni DB i při chybě v kódu |
| `tenant_id` | v1 ho postrádal, přestože §11 vyžaduje konfiguraci per tenant |
| `status` výčet | v1 měl jen default `ACTIVE`, hodnoty nebyly určeny |
| `TEXT` datum (ISO8601) | v1 typ neurčoval; TEXT `datetime('now')` je D1/SQLite idiom |

**Poznámka k tenancy:** `tenant_id` je ve schématu, protože §11 vyžaduje
konfiguraci per tenant a repo má `core/tenant/types.ts`. Alternativa
(samostatná D1 per tenant) by sloupec nepotřebovala, ale komplikuje admin
napříč tenanty. Sloupec je levnější a reverzibilní.

---

## 4. Vytvoření poukazu — Issuance (ROZHODNUTO)

```
Shoptet Order (obsahuje voucher produkt N × 1 Kč)
   → NEXUS webhook
   → ověření objednávky (zaplaceno?)
   → idempotency check (core/idempotency, klíč = source_order_id)
   → vygenerování kódu
   → D1 INSERT vouchers + voucher_transactions(ISSUED)
   → PDF
   → email (Resend)
```

**Formát kódu (ROZHODNUTO — v1 to nechával otevřené):** `NEXUS-XXXX-RRRR`,
kde `XXXX` je 4 znaky z abecedy **bez zaměnitelných znaků** (`0/O`, `1/I/L`)
a `RRRR` je rok expirace.

> **Entropie:** 4 znaky z 30znakové abecedy = ~810 tisíc kombinací. To je na
> platidlo **málo** — uhodnutelné hrubou silou. Proto:
> - kód je **8 znaků** ve dvou skupinách: `NEXUS-XXXX-XXXX-RRRR` (~6,6×10¹¹),
> - validační endpoint má **rate limit** per IP i globálně,
> - neúspěšné pokusy jdou do auditu.
>
> Formát z Josova zadání (`NEXUS-A8F9-2026`) byl uveden jako „např.“, takže
> rozšíření není v rozporu se zadáním. **Pokud Jose trvá na 4 znacích, je
> rate limit jediná obrana a musí to být vědomé rozhodnutí.**

---

## 5. Žádné hackování Shoptetu (ROZHODNUTO)

| Shoptet řeší | NEXUS řeší |
|---|---|
| objednávku | existenci poukazu |
| produkty | platnost |
| cenu položek | zůstatek |
| košík | čerpání |
| | historii |
| | bezpečnost |
| | generování dokumentu |

Shoptet se **needituje ani neobchází** — přistupuje se k němu jen tím, co
nabízí veřejně: šablona (JS injection) a order webhook.

---

## 6. Čerpání — Redemption bez Shoptet API (ROZHODNUTO — v2, Lucky)

**Východisko:** Shoptet REST API pro generování kupónů vyžaduje schválení
v marketu. **okfish ho má, hecmania ne.** Cesta proto musí fungovat i bez něj —
jinak by polovina tenantů zůstala nepokrytá.

### 6.1 Frontend vrstva (Shoptet šablona, JS injection)

**Cart masking**
Voucher produkt je `N × 1 Kč`. Frontend sloučí těchto N řádků do jednoho
vizuálního: `Dárkový poukaz (N Kč)`. Čistě zobrazovací operace — s košíkem
nemanipuluje.

**Intercept zadání kódu**
- Poslouchá `submit` na `#discount-coupon-form` / `.js-discount-coupon-submit`.
- `preventDefault()` — obejde nativní Shoptet validaci, která tenhle kód nezná.
- Volá `GET /api/vouchers/validate?code=...`.

**Odpověď Workeru**

```json
{
  "valid": true,
  "balance": 1500,
  "currency": "CZK",
  "expiresAt": "2027-09-06T00:00:00Z",
  "applicable": 800,
  "token": "<HMAC podepsaný token, viz 6.2>"
}
```

**Výpočet čerpané částky** (Worker, ne frontend):

| Hodnota košíku | Zůstatek | Čerpáno | Nový zůstatek |
|---|---|---|---|
| 800 Kč | 1500 Kč | 800 Kč | 700 Kč |
| 3000 Kč | 1500 Kč | 1500 Kč | 0 Kč |

Tedy `min(zůstatek, hodnota košíku)`.

**Zobrazení**
Frontend vloží řádek slevy do souhrnu a přepočítá zobrazenou cenu. Token
uloží do `sessionStorage` a připojí ho do objednávky (skryté pole checkoutu /
poznámka objednávky).

### 6.2 KRITICKÉ — oddělení zobrazení od finančního odečtu

> Lucky: *„U Shoptetu bych oddělil zobrazení kreditu v košíku od skutečného
> finančního odečtu. To je důležité, aby zákazník nemohl manipulací s JS
> vytvořit vyšší slevu, než na jakou má voucher nárok.“*

**Hrozba:** cokoli, co spočítá frontend, se dá v konzoli přepsat. Shoptet
uloží do objednávky tu cenu, kterou dostane. Kdyby Worker při webhooku
převzal částku z objednávky, zákazník si nastaví slevu na plnou hodnotu
košíku a rozdíl zaplatí e-shop.

**Obrana — tři vrstvy:**

1. **Podepsaný token, ne holá částka.** Worker vrací HMAC nad
   `(voucher_id, applicable_amount, cart_fingerprint, expires_at)`. Token je
   krátkodobý (řádově minuty). Přepsat částku v DOM lze, ale token pak
   nesedí — a bez platného tokenu Worker neodečte nic.
2. **Worker si částku přepočítá sám.** Při order webhooku se **nepřebírá**
   hodnota z objednávky. Worker načte položky objednávky, sečte nevoucher
   položky a spočítá `min(current_balance, součet)` znovu, z vlastních dat.
3. **Nesoulad → HOLD.** Když se přepočítaná částka a stav objednávky
   rozejdou nad toleranci zaokrouhlení, objednávka se označí **HOLD**,
   **kredit se neodečte**, zapíše se audit záznam a odejde alert. Rozhoduje
   člověk.

**Failure mode (dle master rules — threat model u bypassů):**

| Scénář | Odchytí | Následek |
|---|---|---|
| Přepsání částky v JS | HMAC token nesedí | odečet zamítnut, HOLD |
| Přehrání starého tokenu | `expires_at` v tokenu + `cart_fingerprint` | zamítnuto |
| Dvojí odeslání objednávky | `UNIQUE(voucher_id, order_id)` | druhý zápis selže, kredit odečten 1× |
| Paralelní košíky, stejný kód | optimistický zámek (§7) | druhý retry vidí nižší zůstatek |
| Uhodnutí kódu | entropie 8 znaků + rate limit + audit | zamítnuto, alert |
| Webhook nedorazí | reconciliation job (`core/reconciliation`) | nespárovaná objednávka na reportu |

> **Vědomě přijaté riziko:** mezi zobrazením slevy v košíku a order webhookem
> Shoptet o voucheru neví. Objednávka tedy vznikne se sníženou cenou dřív,
> než NEXUS kredit odečte. Okno je krátké a chráněné tokenem, ale
> **nenulové** — proto HOLD místo tichého průchodu. Toto je přímý důsledek
> no-API cesty a zmizí, až bude Shoptet REST API schválené.

### 6.3 Až bude API k dispozici

Pro tenanty se schváleným REST API (okfish) lze místo JS injection generovat
**jednorázový Shoptet kupón na přesnou částku**. Tím zmizí okno z 6.2, protože
slevu drží Shoptet sám. **Volba cesty patří do tenant konfigurace** (§11),
ne do kódu — obě větve sdílejí stejné D1 jádro i stejný Redemption tok.

---

## 7. Atomické čerpání — ROZHODNUTO (a), Lucky

**Rozhodnutí: optimistický zámek. Databáze je autorita. Žádné aplikační
mutexy, žádný Durable Object per voucher.**

Důvod: přesně tenhle vzor už repo používá v `core/idempotency/IdempotencyStore.ts`
(migrace AIE `INSERT ... ON CONFLICT DO NOTHING`, úspěch = `rowCount === 1`).
Souběh řeší DB constraint, ne aplikační kód. Durable Object by zavedl druhou
perzistenční vrstvu vedle D1, kterou repo dnes nikde nemá.

```sql
UPDATE vouchers
   SET current_balance = current_balance - :amount,
       version         = version + 1,
       status          = CASE WHEN current_balance - :amount = 0
                              THEN 'DEPLETED' ELSE status END
 WHERE id              = :id
   AND version         = :expected_version
   AND status          = 'ACTIVE'
   AND current_balance >= :amount
   AND expires_at      > datetime('now');
```

- `meta.changes === 1` → čerpáno, zapiš `voucher_transactions(REDEEMED)`
- `meta.changes === 0` → konflikt **nebo** nesplněná podmínka → načti čerstvý
  stav, rozliš důvod (jiná verze / nízký zůstatek / expirace / neaktivní) a
  buď retry s novou verzí, nebo vrať konkrétní chybu

Retry má **konečný počet pokusů** (návrh: 3) a exponenciální backoff; po
vyčerpání se operace zamítne a jde do auditu — ne tichý neúspěch.

### Stavový model

```
ACTIVE ──čerpání (částečné)──▶ ACTIVE
   │
   ├──čerpání (do nuly)──▶ DEPLETED ──refundace──▶ ACTIVE
   ├──expirace──────────▶ EXPIRED
   └──storno───────────▶ CANCELLED
```

Implementuje se přes `core/state-machine/StateMachine.ts` (fail-closed:
nedeklarovaný přechod je zakázaný), stejně jako `IdempotencyStore`.

> **Rezervační mezistav (`RESERVED`) není ve Fázi A.** Původní návrh ho v §7
> označoval za kritický, ale zároveň ho řadil do Fáze E — vnitřní rozpor
> zadání. **Řeší se takto:** ochranu proti dvojímu čerpání ve Fázi A zajišťuje
> kombinace optimistického zámku + `UNIQUE(voucher_id, order_id)` + HMAC token,
> což pokrývá všechny scénáře z tabulky v 6.2. `RESERVED` by přidal jen držení
> kreditu po dobu checkoutu (kredit „zamluvený“ v opuštěném košíku) —
> to je UX vlastnost, ne bezpečnostní. Proto zůstává ve Fázi E.

---

## 8. Podmínky platnosti (ROZHODNUTO, Lucky)

Voucher je uplatnitelný **právě když** platí všechny podmínky současně:

```
status = 'ACTIVE'  AND  expires_at > NOW()  AND  current_balance > 0
```

Vyhodnocuje se **v SQL WHERE klauzuli čerpacího UPDATE** (§7), ne v aplikačním
kódu před ním — jinak vzniká TOCTOU okno mezi kontrolou a zápisem.

Expirace: `created_at + 1 rok` (ROZHODNUTO), konfigurovatelné per tenant (§11).

---

## 9. PDF poukaz (ROZHODNUTO — obsah)

Obsahuje: název, hodnotu, kód, datum vystavení, expiraci, jméno zákazníka,
instrukce k použití, obchodní podmínky, QR kód.

Generování: HTML → PDF na Workeru. Odeslání: **Resend** (rozhodnutí Lucky).

> **QR kód — bezpečnostní upřesnění:** URL `/shop/voucher/NEXUS-...` nese kód
> v cestě, takže kdokoli ji zachytí (log, referrer, sdílený screenshot) drží
> platidlo. **Rozhodnutí: stránka je pouze informativní** — zobrazí zůstatek a
> platnost, **neumožňuje čerpání**. Čerpání vyžaduje zadání kódu v košíku.
> Zůstatek sám o sobě není citlivější než papírový poukaz v peněžence.

---

## 10. Admin (ROZHODNUTO — Jose: důležitější než PDF)

- tabulka voucherů: kód / hodnota / zůstatek / stav / platnost
- detail s historií transakcí
- Fáze D doplní storno, refundaci, vyhledávání

> **OTEVŘENÁ OTÁZKA (nebrání Fázi A):** kde admin UI žije — repo má `ui/`,
> ale samostatná aplikace není vyloučena.

---

## 11. Konfigurace per tenant (ROZHODNUTO — NEDÁVAT natvrdo do kódu)

Povolené hodnoty, měna, platnost, vzhled PDF, text emailu, obchodní podmínky,
kombinovatelnost s akcemi, použití na dopravu, více voucherů v objednávce,
minimální hodnota objednávky, omezení na produkty/kategorie —
**a nově: cesta aplikace kreditu** (JS injection vs. Shoptet kupón přes API,
viz 6.3).

Patří do tenant konfigurace (vzor `core/tenant/types.ts`).

---

## 12. KRITICKÉ — kompatibilita s cenovou logikou (ROZHODNUTO)

Voucher je **platební / kreditní vrstva**, **NIKOLIV** cenová sleva
v Pricing Engine.

```
BASE PRICE → SALE / CUSTOMER / H-KLUB → DISCOUNT LIMITS → PROMOGROUP
   → QUANTITY → BEST CANDIDATE → FINAL PRODUCT PRICE → CART
   ────────────────── TADY, a nikde výš ──────────────────
   → VOUCHER CREDIT → AMOUNT TO PAY
```

Voucher se aplikuje **až na hotový součet košíku**, nikdy na cenu položky.
Tím se nerozbijí množstevní ceny, H-KLUB, B2B, PromoGroup ani X+X.

Dotčená pravidla: `domains/pricing/` — `BasePriceRule.ts`,
`HighestDiscountRule.ts`, `DiscountLimitRule.ts`, `QuantityTierRule.ts`,
`BestCandidatePriceRule.ts`, `XPlusXRule.ts`, `RoundingRule.ts`, řetězené
v `createNexusPricingCalculator.ts`.

### Vztah k `domains/pricing/VoucherCouponRule.ts` — ROZHODNUTO

V repu existuje `VoucherCouponRule.ts` (migrace legacy `VoucherCouponPolicy`
z Desktop doplňku): rozlišuje `VOUCHER` (platidlo na košík) vs. `COUPON`
(slevový kód s `allowOnSaleItems`). Nemá zůstatek, postupné čerpání ani D1.

**Rozhodnutí: (c) paralelní systémy pro odlišné use-case, s ostrou hranicí
v pojmenování.**

| | `VoucherCouponRule` (pricing) | `domains/voucher/` (nová doména) |
|---|---|---|
| Co to je | jednorázový slevový kód | kreditní zůstatek |
| Stav | bezstavový, per výpočet | D1, přežívá objednávky |
| Čerpání | celé naráz | postupně, více objednávek |
| Vrstva | uvnitř Pricing Engine | za košíkem, platební |

`VoucherCouponRule` **zůstává nedotčen** (master rule: Non-Interference —
je otestovaný a stabilní). Nová doména ho nenahrazuje ani nevolá.

> **Terminologický dluh:** slovo „voucher“ pak v repu znamená dvě věci. Návrh
> pojmenování v nové doméně: **`CreditVoucher`** pro entitu a
> `domains/voucher/` pro doménu, aby se v kódu nepletlo s
> `VoucherCouponRule.CodeType.VOUCHER`. Ke schválení při Fázi A.

---

## 13. Napojení na NEXUS domény (ROZHODNUTO)

| Doména | Vztah |
|---|---|
| Customer | Customer → CreditVoucher |
| Order | Order → issuance + redemption |
| Invoice | vazba přes Order — účetní systém per tenant (Omega / Pohoda / Money S3), viz §15.1 |
| Tenant | konfigurace voucheru |
| Audit | **všechny** změny kreditu |

Soubory: `core/canonical/entities/{Customer,Order,Invoice}.ts`,
`core/tenant/types.ts`, `core/audit/AuditRecord.ts`.

---

## 14. MVP fáze

### Fáze A — Voucher Core ← **ODBLOKOVÁNO, připraveno**
D1 schéma + migrace, `CreditVoucher` a `VoucherTransaction` entity, generování
kódu, validace platnosti, atomické čerpání (§7), idempotence, issuance
webhook, audit, testy souběhu.

### Fáze B — Customer Experience ← **ODBLOKOVÁNO rozhodnutím 6.1/6.2**
Validační endpoint, HMAC token, JS injection do Shoptet šablony, cart masking,
zobrazení zůstatku, mobilní UX, redemption webhook s přepočtem a HOLD.

### Fáze C — Dokumenty ← **ODBLOKOVÁNO rozhodnutím (c)**
PDF, QR, email (Resend), šablony. PDF je **doklad o kreditu, ne daňový
doklad** — bez rozpadu DPH, s formulací dle VOP (viz §15).

### Fáze D — Admin
Seznam, detail, historie, storno, refundace, vyhledávání.

### Fáze E — Advanced
Více voucherů v objednávce, `RESERVED` rezervace, převod kreditu, firemní
poukazy, hromadné vystavení, veřejné API.

---

## Stav rozhodnutí

| Bod | Stav | Kdo | Blokuje |
|---|---|---|---|
| (a) Atomické čerpání v D1 | **UZAVŘENO** — optimistický zámek | Lucky, 2026-09-06 | — |
| (b) Cesta kreditu do košíku | **UZAVŘENO** — JS injection + HMAC + HOLD; API větev per tenant | Lucky, 2026-09-06 | — |
| (c) Účetní / daňový režim | **UZAVŘENO** — víceúčelový poukaz (MPV), § 15b ZDPH | Lucky, 2026-09-06 | — |

**Všechny tři body uzavřeny. Návrh je kompletní.**

---

## 15. Daňový režim — ROZHODNUTO (c): víceúčelový poukaz (MPV)

**Rozhodnutí: kreditní poukaz je víceúčelový poukaz podle § 15b zákona
o DPH.** Kredit je čerpatelný napříč sortimentem s různými sazbami (12 % /
21 %), takže v okamžiku prodeje **není známo**, jaké plnění bude poskytnuto —
což je přesně definiční znak MPV.

### Co z toho plyne pro doklady

| Okamžik | Co se děje | DPH |
|---|---|---|
| **Prodej poukazu** | doklad o přijaté platbě / finančním kreditu | **bez DPH** — nulová sazba / osvobozeno / neplnění; není zdanitelné plnění |
| **Čerpání kreditu** | řádný daňový doklad za objednávku | **běžné sazby podle skutečně nakoupeného zboží** |

Poukaz se v košíku chová jako **forma úhrady / zápočet**, ne jako sleva —
což je konzistentní s §12 (voucher je platební vrstva za Pricing Engine,
nikdy sleva v něm). Základ daně se počítá ze skutečného zboží, poukaz se
odečítá až v rozpadu plateb.

### Kde to lze ověřit (Lucky, 2026-09-06)

1. **Detail produktu poukazu** — Administrace → Produkty → detail → Ceník →
   *Sazba DPH* = **0 %** (příp. neplátce / osvobozeno).
2. **Vystavená faktura z čerpání** — Administrace → Objednávky → objednávka
   s uplatněným poukazem → Vystavená faktura. Zboží má standardní sazbu,
   poukaz je odečten na vlastním řádku / v rozpadu plateb. **Toto je
   rozhodující důkaz:** běžná DPH ze zboží ⇒ víceúčelový poukaz.
3. **Obchodní podmínky** — sekce Platební podmínky / Dárkové poukazy;
   formulace typu „poukaz slouží jako záloha na nákup zboží, při jeho nákupu
   se nevystavuje daňový doklad s DPH“.

### KRITICKÉ — co z toho NEXUS smí a nesmí dělat

`core/canonical/entities/Invoice.ts` obsahuje závazné rozhodnutí Jose
(2026-09-05, Fáze 6.1):

> *„NEXUS nevytváří účetní pravdu — Omega zůstává účetním zdrojem pravdy.
> Invoice je obchodní reprezentace / vazba na účetní doklad přes
> `omegaDocumentId` (odkaz, NE kopie jeho dat).“*
> *„Automatické vytváření/vystavování Invoice je EXPLICITNĚ MIMO SCOPE.“*

Proto **MPV režim je pro Voucher doménu kontrakt, ne výpočet:**

- NEXUS **nepočítá DPH** z voucheru a **nevystavuje** daňové doklady.
- NEXUS **eviduje kredit a jeho pohyby** a předává je jako fakta —
  účetní systém z nich dělá účetní pravdu.
- Vazba `Voucher → Invoice` je **přes Order**, ne přímá: `Invoice.orderId`
  je 1:1 na Order, a `voucher_transactions.order_id` říká, ve které
  objednávce byl kredit čerpán. **Nová vazba se nezavádí.**
- Emise poukazu (`ISSUED`) **není zdanitelné plnění**, takže z ní
  nevzniká daňový doklad — jen doklad o přijaté platbě.

**Dopad na Fázi C:** PDF poukazu je **doklad o kreditu, ne daňový doklad**.
Nesmí obsahovat rozpad DPH ani se tvářit jako faktura. Musí nést větu
odpovídající VOP (poukaz jako záloha na budoucí nákup).

### 15.1 Účetní systém není jen Omega (ROZHODNUTO — Lucky, 2026-09-06)

> Lucky: *„nedeláme jen omegu ale taky pohodu a Money S3“*

Předchozí verze tohoto návrhu psala „Omega“ tam, kde patří **„účetní
systém“**. To je věcná chyba — L-Code nasazuje minimálně **Omega, Pohoda
(mServer / `.bat` agent) a Money S3**.

**Stav v repu (ověřeno 2026-09-06):**

| Systém | Stav | Kde |
|---|---|---|
| Omega | migrovaná legacy vrstva | `connectors/omega/legacy/`, `domains/omega/` |
| Pohoda | **už reálně figuruje** | `OmegaExecutor.ts` spouští `.bat`; threat model řeší *„zamčený Pohoda soubor“* a *„Pohoda dialog čeká na input“* |
| Money S3 | **není v repu vůbec** | — |
| generická ERP vrstva | **adresář existuje, je prázdný** | `connectors/erp-generic/` |

`docs/entity-audit/Invoice.md` už dvojici „Omega/Pohoda“ zmiňuje na dvou
místech — návrh voucheru to jen nepřevzal.

**To není dodatečná oprava — je to původní záměr architektury.** Repo má
`connectors/Connector.ts` jako obecné rozhraní a `connectors/erp-generic/`
jako **připravené místo pro ERP vrstvu**; adresář existuje prázdný, protože
se k němu zatím nedošlo, ne protože by se s víc systémy nepočítalo. Omega je
dnes jediný naplněný konektor, ne jediný plánovaný.

**Rozhodnutí pro Voucher doménu:**

1. Voucher doména **nesmí znát konkrétní účetní systém**. Mluví s ním přes
   rozhraní (`connectors/Connector.ts` / `erp-generic`), ne přes
   `connectors/omega/`. Přidání čtvrtého ERP nesmí znamenat zásah do
   `domains/voucher/`.
2. Pole `Invoice.omegaDocumentId` je **špatně pojmenované pro tři systémy**.
   Voucher doména ho **nerozšiřuje ani nepřejmenovává** (Non-Interference —
   `Invoice.ts` je Josovo Fáze 6.1 rozhodnutí). Návrh k projednání:
   `accountingDocumentId` + `accountingSystem: 'OMEGA'|'POHODA'|'MONEY_S3'`.
   **Patří to do Invoice/ERP domény, ne do voucheru** — zapsáno jako dluh.
3. Volba účetního systému je **per tenant** (§11), stejně jako volba cesty
   kreditu do košíku (§6.3). Tenant běží na jednom z nich, ne na všech.
4. **MPV režim je nezávislý na systému** — § 15b ZDPH platí bez ohledu na to,
   jestli doklad vystaví Omega, Pohoda nebo Money S3. Rozhodnutí (c) tedy
   touto opravou nepadá, jen se rozšiřuje jeho dosah.

> **Důsledek pro plán:** naplnění `connectors/erp-generic/` je **předpoklad**
> pro účetní napojení voucheru napříč tenanty, a dnes neexistuje. Voucher
> doména si ho **nebude psát sama** — Fáze A–D na účetním napojení nezávisí
> (pracují s kreditem, ne s doklady). Napojení je samostatný úkol mimo tento
> návrh.

> **Zbývá potvrdit s účetní při napojení (nebrání Fázím A–D):** jakým
> konkrétním typem dokladu se prodej poukazu zapisuje v každém ze tří
> systémů. To je otázka **mapování**, ne daňového režimu — ten je rozhodnut
> jako MPV.

---

## Poznámky ke stavu repa

1. `connectors/omega/` obsahuje jen `legacy/` a `connectors/erp-generic/` je
   **prázdná** — napojení voucher dokladů na účetnictví (§15.1) nemá dnes kam
   sáhnout. Pohoda je zatím jen implicitně přes `OmegaExecutor.ts` (`.bat`
   agent), Money S3 v repu není vůbec. **Nebrání Fázím A–D.**
2. `domains/billing/` je téměř prázdná (Fáze 6 nedokončená). Voucher je jí
   tematicky blízko, ale **rozhodnuto: samostatná `domains/voucher/`** —
   vlastní životní cyklus, vlastní D1 tabulky, vlastní webhooky.
3. Repo dnes nemá **žádný** produkční D1 ani Durable Object kód — Fáze A bude
   první. Vzor perzistence: `core/idempotency/IdempotencyStore.ts`.

---

Status: **NÁVRH UZAVŘEN.** Všechna tři blokující rozhodnutí (a)(b)(c) padla,
Fáze A–D jsou odblokované. Zbývající dluhy (`connectors/erp-generic/`,
přejmenování `omegaDocumentId`, umístění admin UI) jsou **mimo tento návrh**
a žádnou fázi neblokují.
Zapsáno 2026-09-06 (v3).

---

## 16. Shoptet webhook -- TVRDÁ ČASOVÁ OMEZENÍ (7.9.2026)

Zjištěno z oficiální dokumentace
(https://developers.shoptet.com/api/documentation/webhooks/):

| Omezení | Hodnota |
|---|---|
| Odpověď webhooku | **HTTP 200 do 4 sekund** |
| Odpověď instalačního callbacku | **HTTP 200 do 5 sekund** |
| Opakování při selhání | **3 pokusy po 15 minutách** |
| URL na event | jen jedna |
| Podpis | HMAC-SHA1 |
| Zdrojová IP | **185.184.254.0/24** |

### Co to znamená pro issuance (§4)

**Fáze C (PDF + e-mail) SE NESMÍ dělat synchronně uvnitř webhooku.**
Generování PDF a odeslání přes Resend se do 4 sekund nevejde spolehlivě --
a když se nevejde, Shoptet webhook zopakuje. Idempotence přes
`uq_vouchers_source_order` sice zabrání druhému poukazu, ale zákazník
dostane e-mail dvakrát a v logu bude vypadat všechno jako chyba.

Správný tvar:
1. webhook **jen** ověří podpis, zapíše poukaz do D1 a vrátí 200
2. PDF a e-mail se odloží přes `ctx.waitUntil()` nebo Queue

Dnešní stav je v pořádku: `routes/issuance.ts` končí zápisem do D1,
PDF ani e-mail nedělá. **Při implementaci Fáze C se to nesmí přidat
do synchronní cesty.**

### Co to znamená pro redemption (§6.2)

Přepočet částky a atomický odečet jsou rychlé (dva D1 dotazy), ale
`HOLD` větev zapisuje navíc do `voucher_audit`. I to je pod limitem --
pozor ale na to, aby se do webhooku nikdy nedostalo volání Shoptet API
nebo cokoli s vlastním síťovým round-tripem.

### Ověření zdroje

Shoptet volá jen z `185.184.254.0/24`. Worker to může použít jako
allowlist -- levnější první filtr než ověřování HMAC podpisu, a odřízne
to náhodné boty dřív, než se dostanou k D1.

**Pozor:** IP allowlist NENAHRAZUJE ověření podpisu. Je to první síto,
ne autentizace -- HMAC-SHA1 kontrola musí zůstat.

---

## 17. Stav okfish API a webhooků -- OVĚŘENO NAŽIVO (7.9.2026)

Ověřeno produkčním tokenem proti `api.myshoptet.com`, **výhradně GET dotazy**
(zápis blokuje `connectors/shoptet/ReadOnlyGuard.ts`).

### 17.1 Token má plný rozsah -- nic se rozšiřovat nemusí

E-shop **okfish.sk**, `eshopId: 767740`. Autentizace hlavičkou
`Shoptet-Private-API-Token` (NE `Shoptet-Access-Token`, ta vrací 401).

| Endpoint | Stav |
|---|---|
| `/api/eshop` | 200 |
| `/api/orders` | 200 |
| `/api/products` | 200 |
| `/api/customers` | 200 |
| **`/api/webhooks`** | **200** |
| `/api/pricelists` | 200 |
| `/api/stocks` | 200 |

Pozn.: parametr `?limit=` vrací 400 -- není podporovaný, stránkuje se jinak.

### 17.2 ⚠️ WEBHOOKY UŽ EXISTUJÍ A MÍŘÍ NA OKFISH WORKER

```
order:create      -> shoptet-vip-worker.hlancaric.workers.dev
order:update      -> shoptet-vip-worker.hlancaric.workers.dev
customer:create   -> shoptet-vip-worker.hlancaric.workers.dev
product:create    -> shoptet-vip-worker.hlancaric.workers.dev
product:update    -> shoptet-vip-worker.hlancaric.workers.dev
```

**Shoptet dovolí JEN JEDNU URL NA EVENT.**

Registrovat NEXUS na `order:create` by tedy stávající webhook **PŘEPSALO**
a okfish by přestal dostávat objednávky -- tichý výpadek produkčního systému,
který by se poznal až podle nesynchronizovaných cen.

**Tři cesty, jak to řešit (rozhodnutí Lucky):**

1. **Řetězení v okfish Workeru** -- okfish po svém zpracování přepošle
   payload NEXUSu. Nejmenší zásah do Shoptet konfigurace, ale znamená
   změnu v živém okfish Workeru a vytváří závislost NEXUS → okfish.
2. **Společný rozcestník** -- nová URL, která přijme webhook a rozešle ho
   oběma systémům. Čisté, ale je to nový bod selhání před oběma.
3. **Počkat na vlastní e-shop / sandbox** -- voucher se rozjede jinde
   a okfish se nechá být, dokud nebude celý přechod na NEXUS.

**Do rozhodnutí: NEXUS webhook NEREGISTROVAT.** Zápis do `/api/webhooks`
je `POST`, takže ho `ReadOnlyGuard` zablokuje -- ale je potřeba to vědět,
ne na to spoléhat.

### 17.3 Co z toho plyne pro Fázi B

Čtecí část jde postavit hned: validace kódu, přepočet částky, čtení
objednávky přes `/api/orders`. Chybí jen spouštěč -- a ten je závislý
na rozhodnutí výše.

---

## 18. ZMĚNA MECHANIKY: fixní kupón místo kredit produktu (Lucky, 7.9.)

### 18.1 Co se mění

Návrh §6 stál na tom, že se do košíku vloží kredit produkt `N × 1 Kč`
a vynuluje ho 100% kupón. **To bylo zbytečně složité.**

Lucky: *"Shoptet nativně umí vytvořit slevový kód na libovolnou korunovou
hodnotu. Nemusíme do košíku podstrkávat žádné virtuální 1Kč produkty ani
manipulovat s kategoriemi -- kód funguje jako virtuální bankovka s přesnou
hodnotou na celý košík."*

Model `N × 1 Kč` je workaround pro platformy, které fixní kupón neumí.
Shoptet ho umí, takže se nepoužije.

**Co tím padá:** kredit produkt, cart masking, kategorie pro kupón,
omezení kupónu na produkt. Celá sekce §6.1 a §6.2 se tím zjednodušuje.

**Co zůstává beze změny:** D1 jako zdroj pravdy o zůstatku, atomické
čerpání optimistickým zámkem (§7), idempotence webhooku, MPV režim (§15).

### 18.2 Dva režimy řízené tenant konfigurací

Rozhodnutí Lucky: NEXUS musí zvládnout obojí, volba je konfigurace tenanta,
ne větev v kódu.

```ts
export interface TenantVoucherConfig {
    tenantId: string;
    mode: 'ONE_TIME' | 'MULTI_USE';
    thresholdGold: number;     // hranice pro GOLD/SILVER šablonu PDF
    allowPartialBurn: boolean;
}
```

**`ONE_TIME`** -- Worker vygeneruje v Shoptetu fixní kupón na celou částku.
Uplatněním se spálí; je-li košík menší, **zbytek propadá bez náhrady**.
D1 drží auditní záznam o vystavení.

**`MULTI_USE`** -- D1 drží reálný zůstatek. Po každém čerpání se přes
Shoptet API smaže starý kupón a vytvoří nový se **stejným kódem** na
nový zůstatek.

### 18.3 Dvě věci, které z toho plynou a musí se ošetřit

**(a) `MULTI_USE`: mezi smazáním a vytvořením je okno.**

Jsou to dvě API volání. Když druhé selže (rate limit, výpadek, timeout),
zákazník má kredit v D1, ale **žádný funkční kupón v Shoptetu** -- kód mu
přestane fungovat, přestože nárok má.

Řešení už v repu existuje: `core/canonical/outcomes/` -- `ExecutionIntent`
se stavem `UNKNOWN` a reconciliační smyčka. Přegenerování kupónu MUSÍ jít
přes tuhle vrstvu, ne dvěma přímými `fetch` voláními. Jinak se ta chyba
nikdy nedozvíme.

Pořadí je navíc závazné: **nejdřív vytvořit nový, potom smazat starý.**
Opačně by okno znamenalo, že zákazník nemá kupón vůbec; takhle má
v nejhorším případě dva, což je detekovatelné a opravitelné.

**(b) `ONE_TIME`: nevíme, kolik propadlo.**

Když D1 drží jen auditní záznam o vystavení, NEXUS se nikdy nedozví,
jestli zákazník vyčerpal celou částku, nebo jen část. Shoptet to nehlásí.

Pro §15 (víceúčelový poukaz) to může vadit: **nevyčerpaný poukaz je
závazek**, a ten se v účetnictví sleduje. Doporučuji i v `ONE_TIME` režimu
zpracovat order webhook a zapsat skutečně čerpanou částku -- je to jeden
zápis navíc a dá to podklad pro účetní.

**Není to blokující.** Je to věc, o které je lepší rozhodnout teď než
až se na ni zeptá účetní.

### 18.4 Dopad na už napsaný kód

Beze změny zůstává: `CreditVoucher` entita, `CreditVoucherStore` + D1
implementace, atomické čerpání, `SecurityCoordinator`, webhook příjem,
`ReadOnlyGuard`.

Přibude: `TenantVoucherConfig`, generování Shoptet kupónu, a v `MULTI_USE`
jeho přegenerování přes `ExecutionIntent`.

Odpadá: kredit produkt, cart masking, kategorie -- tedy podstatná část
frontend vrstvy, která se ještě nepsala.
