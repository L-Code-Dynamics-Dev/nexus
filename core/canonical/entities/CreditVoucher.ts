// CreditVoucher / CreditVoucherTransaction -- Fáze A "Voucher Core"
// (docs/design-proposals/Digital-Voucher.md, status NÁVRH UZAVŘEN v3,
// rozhodnutí Lucky 2026-09-06). Čistě NEW BUILD -- žádný zdrojový systém
// (Pricing / SafeOrder / AIE / Omega) nemá kreditní poukaz s zůstatkem.
//
// ROZHODNUTO (Lucky 2026-09-06):
//   - §7 Atomické čerpání: OPTIMISTICKÝ ZÁMEK, databáze je autorita.
//     Entita proto nese `version: number` -- čerpací UPDATE běží s
//     `WHERE version = :expected_version` a `meta.changes === 1` je jediný
//     důkaz úspěchu. ŽÁDNÉ aplikační mutexy, ŽÁDNÝ Durable Object per
//     voucher (zavedl by druhou perzistenční vrstvu vedle D1).
//   - §15 Daňový režim: VÍCEÚČELOVÝ POUKAZ (MPV) dle § 15b ZDPH. Pro tuhle
//     entitu je to KONTRAKT, ne výpočet: NEXUS eviduje kredit a jeho pohyby
//     jako fakta, DPH nepočítá a daňové doklady nevystavuje. Entita proto
//     NEMÁ žádné pole se sazbou DPH ani rozpadem základu daně -- kdyby
//     vzniklo, bylo by to porušení §15 a Josova rozhodnutí v Invoice.ts
//     ("NEXUS nevytváří účetní pravdu").
//   - §12 Vrstva: voucher je PLATEBNÍ / KREDITNÍ vrstva ZA hotovým součtem
//     košíku, NIKOLIV cenová sleva v Pricing Engine. Tenhle soubor proto
//     NESMÍ importovat nic z `domains/` -- zejména ne `domains/pricing/`.
//
// TERMINOLOGIE -- ostrá hranice vůči `domains/pricing/VoucherCouponRule.ts`
// (§12 návrhu). V repu už slovo "voucher" jednou obsazené je, proto se
// entita jmenuje `CreditVoucher`, NE `Voucher`. Kolize je TERMINOLOGICKÁ,
// ne funkční:
//
//   |                | VoucherCouponRule.CodeType.VOUCHER | CreditVoucher (tady)     |
//   |----------------|------------------------------------|--------------------------|
//   | Co to je       | jednorázový slevový kód            | kreditní zůstatek        |
//   | Stav           | bezstavový, per výpočet            | D1, přežívá objednávky   |
//   | Čerpání        | celé naráz                         | postupně, více objednávek|
//   | Vrstva         | uvnitř Pricing Engine              | za košíkem, platební     |
//   | Zůstatek       | nemá                               | initial/current balance  |
//
// `VoucherCouponRule` ZŮSTÁVÁ NEDOTČEN (master rule Non-Interference).
// Nová doména ho nenahrazuje, nevolá ani neimportuje. Ověřeno 2026-09-06:
// `VoucherCouponRule` nemá jedinou produkční call-site a není zapojen
// v `createNexusPricingCalculator` -- riziko záměny je tedy dnes čistě
// v hlavě čtenáře kódu, což tenhle blok řeší.
//
// EXPLICITNĚ MIMO SCOPE Fáze A:
//   - Stav `RESERVED` (držení kreditu po dobu checkoutu) -> Fáze E. §7
//     návrhu to zdůvodňuje: je to UX vlastnost, ne bezpečnostní -- dvojí
//     čerpání pokrývá optimistický zámek + UNIQUE(voucher_id, order_id)
//     + HMAC token.
//   - PDF poukazu, QR, e-mail (Resend) -> Fáze C.
//   - Admin (storno, refundace, vyhledávání) -> Fáze D.
//   - Účetní napojení -> `connectors/erp-generic/` DNES NEEXISTUJE (§15.1
//     ověřeno: adresář je prázdný). Fáze A-D na něm nezávisí. Voucher
//     doména si ho nebude psát sama a NESMÍ sáhnout do `connectors/omega/`.
//   - Vazba na Invoice: JEN PŘES Order (`sourceOrderId` / transakční
//     `orderId`). Žádná nová přímá vazba, `Invoice.omegaDocumentId` se
//     nerozšiřuje ani nepřejmenovává (§15.1 bod 2).
//
// POZOR -- legacy vs. canonical peníze: návrh (§3) i legacy kód pracují
// s `number` a v raných verzích i s `€`. Tato entita používá `Money`
// z base.ts, tedy `Decimal` + explicitní `currency` (default 'CZK' per
// tenant). Do D1 se `Money` ukládá jako INTEGER v HALÉŘÍCH -- to je věc
// PERZISTENČNÍ VRSTVY (migrace + repository mapper), NE entity. Entita
// nikdy nevidí halíře a nikdy nevidí float.

import type { CanonicalEntity, EntityId, ISODateTime, Money } from './base.js';
import type { StateAxisDefinition } from '../../state-machine/StateMachine.js';

/**
 * CreditVoucher lifecycle -- ROZHODNUTO (§7 stavový diagram).
 *
 * ACTIVE:    poukaz je uplatnitelný (viz invariant platnosti níže).
 * DEPLETED:  zůstatek klesl na nulu čerpáním.
 * EXPIRED:   `expiresAt` uplynulo.
 * CANCELLED: storno (Fáze D operace, stav je definován už teď).
 */
export type CreditVoucherLifecycleState = 'ACTIVE' | 'DEPLETED' | 'EXPIRED' | 'CANCELLED';

/**
 * KRITICKÉ: `DEPLETED` NENÍ terminální stav.
 *
 * §7 diagram návrhu explicitně říká `DEPLETED --refundace--> ACTIVE`:
 * vrácení objednávky, ve které byl kredit vyčerpán do nuly, musí kredit
 * vrátit na poukaz a poukaz znovu zaktivnit. Kdyby byl `DEPLETED`
 * terminální, `evaluateTransition()` (fail-closed) by refundaci zamítl
 * a jediná cesta zpět by bylo ruční přepsání stavu v DB -- tedy přesně
 * ten druh obcházení state machine, kvůli kterému framework vznikl.
 *
 * Terminální jsou proto JEN `EXPIRED` a `CANCELLED`:
 *   - EXPIRED: čas neteče zpět; prodloužení platnosti = nový poukaz.
 *   - CANCELLED: storno je konečné rozhodnutí operátora.
 *
 * Poznámka k `ACTIVE -> ACTIVE`: částečné čerpání stav NEMĚNÍ, není to
 * tedy přechod a `transitions.ACTIVE` ho neuvádí. Self-transition by
 * v `evaluateTransition()` znamenal, že "nic se nestalo" je dovolený
 * přechod -- to by zamlžilo audit. Změnu zůstatku bez změny stavu nese
 * `CreditVoucherTransaction`, ne stavová osa.
 */
export const CREDIT_VOUCHER_LIFECYCLE_DEFINITION: StateAxisDefinition<CreditVoucherLifecycleState> =
    {
        axisName: 'creditVoucherLifecycle',
        initialState: 'ACTIVE',
        terminalStates: ['EXPIRED', 'CANCELLED'],
        transitions: {
            ACTIVE: ['DEPLETED', 'EXPIRED', 'CANCELLED'],
            // Refundace vrací vyčerpaný poukaz zpět do hry -- viz blok výše.
            DEPLETED: ['ACTIVE', 'EXPIRED', 'CANCELLED'],
            EXPIRED: [],
            CANCELLED: [],
        },
    };

/**
 * Typ pohybu na kreditu. Hodnoty jsou 1:1 se SQL CHECK constraintem
 * `voucher_transactions.type` (§3 návrhu) -- rozejít se nesmí, jinak
 * projde do DB hodnota, kterou aplikace neumí přečíst, nebo naopak.
 *
 * ISSUED:    emise poukazu (`+ initialBalance`). NENÍ zdanitelné plnění (§15).
 * REDEEMED:  čerpání v objednávce (`- amount`). Jediný typ chráněný
 *            partial UNIQUE indexem `(voucher_id, order_id)`.
 * EXPIRED:   odepsání zůstatku po expiraci.
 * CANCELLED: odepsání zůstatku při stornu.
 * REFUNDED:  vrácení dříve čerpaného kreditu (`+ amount`) -- viz
 *            DEPLETED -> ACTIVE výše.
 */
export type CreditVoucherTransactionType =
    | 'ISSUED'
    | 'REDEEMED'
    | 'EXPIRED'
    | 'CANCELLED'
    | 'REFUNDED';

/**
 * CreditVoucher -- digitální kreditní poukaz s postupně čerpatelným
 * zůstatkem. `id` (Identity) je zároveň KÓD poukazu ve formátu
 * `NEXUS-XXXX-XXXX-RRRR` (§4): D1 má `id TEXT PRIMARY KEY` a kód je
 * Nexus-generated, takže druhá identita by byla zbytečná duplicita.
 * Entropie 8 znaků + rate limit na validačním endpointu + audit
 * neúspěšných pokusů je obrana popsaná v §4 -- kód je platidlo.
 *
 * SOURCE REFERENCES: `CreditVoucher` VĚDOMĚ NEMÁ `externalIdentity`.
 * Na rozdíl od `Order`/`Product`/`Customer` NENÍ zrcadlem entity
 * v externím systému -- Shoptet o poukazu neví vůbec nic (§5 návrhu:
 * "Shoptet řeší objednávku, NEXUS řeší existenci poukazu, platnost,
 * zůstatek, čerpání"). Poukaz vzniká v NEXUSu a NEXUS je jeho jediný
 * zdroj pravdy. Vazbu na Shoptet nese `sourceOrderId` (objednávka, kterou
 * byl poukaz koupen) -- to je RELATIONSHIP na canonical `Order`, ne
 * external mirror. Kdyby sem `externalIdentity` někdo doplnil, znamenalo
 * by to, že poukaz existuje i jinde a NEXUS ho jen zrcadlí -- což je
 * v přímém rozporu s no-API architekturou (§6).
 *
 * SOURCE OF TRUTH per pole: všechna pole zapisuje NEXUS Worker.
 * `initialBalance`, `expiresAt`, `sourceOrderId`, `customerEmail` jsou
 * `readonly` -- píše je JEN issuance tok (§4) a po vystavení se nemění.
 * `currentBalance`, `status`, `version` mění JEN atomický čerpací /
 * refundační UPDATE (§7). Žádný externí systém nesmí zapsat nic.
 *
 * INVARIANTY (§3 SQL CHECK + §8):
 *   1. `0 <= currentBalance <= initialBalance` -- vynuceno DB CHECK
 *      constraintem, ne aplikačním kódem: přečerpání musí být nemožné
 *      i při chybě v kódu.
 *   2. `currentBalance.currency === initialBalance.currency` -- poukaz
 *      má jednu měnu po celý život, konfigurovatelnou per tenant (§11).
 *   3. Uplatnitelnost = `status === 'ACTIVE' && expiresAt > NOW() &&
 *      currentBalance > 0` (§8). Vyhodnocuje se V SQL WHERE KLAUZULI
 *      čerpacího UPDATE, NIKDY v aplikačním kódu před ním -- předsazená
 *      kontrola otevírá TOCTOU okno mezi kontrolou a zápisem.
 *   4. `currentBalance === 0` <=> `status === 'DEPLETED'` (dokud
 *      nedojde k refundaci) -- přechod nastavuje tentýž UPDATE, který
 *      zůstatek snižuje, ne následný druhý příkaz.
 *
 * VERSION: entita JE mutovatelná v čase (zůstatek), takže `version` je
 * povinný -- na rozdíl od read-only zrcadel jako `Order`. Není to jen
 * evidence: je to nosič optimistického zámku (§7).
 *
 * AUDIT CONTRACT: **všechny** změny kreditu jdou do auditu (§13). Dvě
 * nezávislé vrstvy, které se nezastupují:
 *   - `CreditVoucherTransaction` = append-only finanční historie pohybů
 *     (kolik, kdy, ve které objednávce). Z ní se dá zůstatek přepočítat.
 *   - `core/audit/AuditRecord.ts` = kdo/kdy/staré/nové/proč, včetně
 *     operací, které pohyb NEVYVOLALY: zamítnuté čerpání, vyčerpaný
 *     retry (§7), neúspěšný pokus o uhodnutí kódu (§4), HOLD při
 *     nesouladu částky (§6.2).
 *
 * RECONCILIATION CONTRACT: Expected != Actual JE u této entity možné,
 * proto je kontrakt povinný. Zdroj rozdílu je pojmenovaný v §6.2:
 * mezi zobrazením slevy v košíku a příchodem order webhooku Shoptet
 * o voucheru neví, takže objednávka vznikne se sníženou cenou DŘÍV, než
 * NEXUS kredit odečte. **Nedoručený webhook = objednávka uplatnila kredit,
 * ale `currentBalance` se nesnížil** -- Expected (zůstatek dle
 * objednávek) != Actual (zůstatek v D1). Odchytává to reconciliation job
 * (`core/reconciliation`), který hlásí nespárované objednávky; opačný
 * směr (odečteno, objednávka neexistuje / byla stornována) se řeší
 * `REFUNDED` transakcí. Invariant reconciliace:
 * `currentBalance === initialBalance - SUM(REDEEMED|EXPIRED|CANCELLED)
 *  + SUM(REFUNDED)` -- rozejde-li se, je to incident, ne varování.
 */
export interface CreditVoucher extends CanonicalEntity {
    /**
     * Nominální hodnota při vystavení. Neměnná -- "kolik poukaz byl",
     * ne "kolik na něm je". Horní mez invariantu 1.
     */
    readonly initialBalance: Money;
    /**
     * Aktuální zůstatek. Mění JEN atomický UPDATE (§7). Měna musí
     * odpovídat `initialBalance.currency` (invariant 2).
     */
    currentBalance: Money;
    /** `createdAt + 1 rok` (§8), délka konfigurovatelná per tenant (§11). */
    readonly expiresAt: ISODateTime;
    /**
     * Objednávka, KTEROU BYL POUKAZ ZAKOUPEN (§3 `source_order_id`).
     * Typovaný odkaz na canonical `Order`, NE volný string FK.
     * POZOR na záměnu: objednávky, ve kterých se kredit ČERPÁ, jsou
     * v `CreditVoucherTransaction.orderId`, ne tady. Slouží zároveň jako
     * idempotency klíč issuance toku (§4) -- jedna objednávka, jeden poukaz.
     */
    readonly sourceOrderId: EntityId;
    /**
     * Příjemce poukazu. Zdroj pro doručení PDF (Fáze C) a pro dohledání
     * poukazů zákazníka (§3 index `idx_vouchers_email`). Vazba na
     * `Customer` je přes `sourceOrderId -> Order.customerId`, e-mail není
     * náhrada za `customerId` -- poukaz může být dárek pro jiného člověka
     * než kupujícího.
     */
    readonly customerEmail: string;
    status: CreditVoucherLifecycleState;
    /**
     * Optimistický zámek (§7). Inkrementuje ho každý úspěšný UPDATE
     * zůstatku/stavu. Čtenář si ho zapamatuje a zapisuje s
     * `WHERE version = :expected_version`; `changes === 0` znamená
     * konflikt NEBO nesplněnou podmínku platnosti -- volající musí načíst
     * čerstvý stav a rozlišit důvod, ne slepě retryovat donekonečna
     * (max 3 pokusy + exponenciální backoff, pak zamítnutí do auditu).
     */
    version: number;
}

/**
 * CreditVoucherTransaction -- jeden pohyb na kreditu. APPEND-ONLY:
 * záznam se nikdy nemaže ani nepřepisuje (stejný vzor jako
 * `core/audit/AuditRecord.ts` a `BillingEvent`). Oprava se dělá
 * PROTIPOHYBEM (`REFUNDED`), ne editací -- jinak by finanční historie
 * přestala být důkazem. Všechna pole jsou proto `readonly`.
 *
 * IDEMPOTENCE je vynucena SCHÉMATEM, ne kódem (§3): partial unique index
 * `uq_voucher_redemption ON (voucher_id, order_id) WHERE type = 'REDEEMED'
 * AND order_id IS NOT NULL`. Dvojí doručení téhož webhooku tedy odečte
 * kredit právě jednou -- druhý INSERT selže na constraintu. Partial index
 * je nutný proto, že `orderId` je NULL u `ISSUED` a `EXPIRED`, a plný
 * unique index by povolil jen jeden takový záznam na poukaz.
 *
 * LIFECYCLE: transakce žádný nemá -- vznikne a už se nemění. Proto ani
 * nemá `version` (není mutovatelná v čase) ani `externalIdentity`
 * (není zrcadlo, viz `CreditVoucher` výše).
 *
 * INVARIANTY:
 *   1. `amount.amount > 0` -- SMĚR nese `type`, ne znaménko. Záporná
 *      částka by rozbila reconciliační součet výše.
 *   2. `amount.currency === CreditVoucher.currentBalance.currency`.
 *   3. `orderId` je povinné pro `REDEEMED` a `REFUNDED` (bez objednávky
 *      by se pohyb nedal spárovat ani reklamovat) a MUSÍ být `undefined`
 *      pro `ISSUED` a `EXPIRED`. `CANCELLED` viz OPEN QUESTION 2 níže.
 *      Vynucení patří do Rule vrstvy (`domains/voucher/`), tady je to
 *      zapsaný kontrakt, ne kód.
 */
export interface CreditVoucherTransaction extends CanonicalEntity {
    /** Poukaz, kterého se pohyb týká (§3 FK `voucher_id` -> `vouchers.id`). */
    readonly creditVoucherId: EntityId;
    readonly type: CreditVoucherTransactionType;
    /** Vždy kladná absolutní hodnota pohybu -- směr určuje `type` (invariant 1). */
    readonly amount: Money;
    /**
     * Objednávka, ve které byl kredit ČERPÁN / vrácen. `undefined`
     * (v D1 NULL) u `ISSUED` a `EXPIRED` -- ty žádnou spotřebitelskou
     * objednávku nemají. Tvoří druhou půlku partial unique indexu.
     */
    readonly orderId?: EntityId;
}

/**
 * ROZHODNUTO (Lucky 2026-09-06, Digital-Voucher.md v3, Fáze A):
 * optimistický zámek jako jediný mechanismus atomicity (§7), MPV daňový
 * režim jako kontrakt bez výpočtu DPH (§15), voucher jako platební vrstva
 * ZA Pricing Engine (§12), pojmenování `CreditVoucher` kvůli hranici vůči
 * `domains/pricing/VoucherCouponRule.ts`, `DEPLETED` jako NEterminální stav
 * kvůli refundaci. Zbývající OPEN QUESTIONS (business rule detail,
 * EXPLICITNĚ MIMO SCOPE Fáze A):
 *
 * 1. Délka kódu -- §4 navrhuje 8 znaků (`NEXUS-XXXX-XXXX-RRRR`, ~6,6×10¹¹)
 *    místo Josových 4 (~810 tisíc, na platidlo málo). Formát byl v zadání
 *    uveden jako "např.", takže rozšíření není v rozporu -- ale POKUD JOSE
 *    TRVÁ NA 4 ZNACÍCH, je rate limit jediná obrana a musí to být vědomé
 *    rozhodnutí. Entity se to nedotýká (`id` je `EntityId`), generátor kódu
 *    v `domains/voucher/` to potřebuje uzavřít.
 * 2. `CANCELLED` transakce a `orderId`: storno vyvolané reklamací konkrétní
 *    objednávky by `orderId` mít mohlo, storno z rozhodnutí operátora ne.
 *    Nerozhodnuto -- proto je `orderId` optional a invariant 3 tenhle
 *    případ vědomě nezavírá. Patří do Fáze D (admin storno).
 * 3. Kdo a kdy překlápí `ACTIVE -> EXPIRED`: batch job, nebo lazy při
 *    prvním dotknutí po expiraci? §8 vyhodnocuje platnost v SQL WHERE, což
 *    znamená, že expirovaný poukaz je NEUPLATNITELNÝ i se `status =
 *    'ACTIVE'` -- stav a skutečnost se tedy můžou dočasně rozejít. To je
 *    bezpečné (fail-closed), ale pro admin výpis (Fáze D) a reconciliaci
 *    to chce rozhodnutí. Nerozhodnuto.
 * 4. Více poukazů v jedné objednávce -- Fáze E. Dnešní partial unique index
 *    `(voucher_id, order_id)` to nezakazuje (různé poukazy, stejná
 *    objednávka), ale pořadí čerpání a rozpad částky mezi ně rozhodnuté
 *    nejsou.
 * 5. Vazba na účetní systém (§15.1): `connectors/erp-generic/` je prázdný
 *    adresář, Money S3 v repu není vůbec. Voucher doména si generickou ERP
 *    vrstvu NEBUDE psát sama a NESMÍ sáhnout přes `connectors/omega/`.
 *    Fáze A-D na tom nezávisí (pracují s kreditem, ne s doklady).
 *    Návrh `accountingDocumentId` + `accountingSystem` patří do Invoice/ERP
 *    domény, ne sem -- zapsáno jako dluh, ne jako úkol Fáze A.
 * 6. `RESERVED` mezistav -- Fáze E, viz EXPLICITNĚ MIMO SCOPE v hlavičce.
 */
