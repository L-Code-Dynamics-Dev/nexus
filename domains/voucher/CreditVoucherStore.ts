// CreditVoucherStore -- doména `domains/voucher/`, Fáze A "Voucher Core"
// (docs/design-proposals/Digital-Voucher.md §3/§4/§7, ROZHODNUTO Lucky 2026-09-06).
//
// Perzistenční KONTRAKT voucher domény. Struktura i styl 1:1 podle
// `core/idempotency/IdempotencyStore.ts`: interface (rozhraní, ne konkrétní
// storage) + in-memory referenční implementace pro testy. Produkční D1
// implementace SEM NEPATŘÍ -- žije v `connectors/` (Connector Layer), stejně
// jako `PostgresProcurementRepository` je v AIE "platform" vrstva, ne "core".
//
// ============================================================================
// KRITICKÉ -- D1 `batch()` NENÍ transakce v tom smyslu, v jakém ji potřebujeme
// ============================================================================
// D1 `batch()` se rollbackuje POUZE při SQL chybě. `UPDATE ... WHERE version = ?`,
// který nematchne žádný řádek, NENÍ chyba -- batch projde a ostatní statements
// se zacommitují. Naivní batch (UPDATE zůstatku + INSERT transakce) by tedy
// zapsal transakci i bez odečtu kreditu → poukaz k utracení donekonečna.
// Kontrakt `redeem()` proto vyžaduje: nejdřív UPDATE, ověřit `meta.changes === 1`,
// teprve pak INSERT transakce. D1 implementace to MUSÍ dodržet.
//
// Důsledky pro implementátora D1 vrstvy (nejsou to doporučení, je to kontrakt):
//   1. UPDATE a INSERT jsou DVA oddělené round-tripy, ne jeden `batch()`.
//   2. Pořadí je NEMĚNNÉ: peníze se odečtou první. Kdyby selhal následný
//      INSERT, zůstane odečtený kredit BEZ transakčního záznamu -- to je
//      detekovatelný rozpor (RECONCILIATION CONTRACT v CreditVoucher.ts) a
//      opravitelný protipohybem. Opačné pořadí by vyrobilo nedetekovatelné
//      dvojí čerpání, protože transakce by existovala i bez odečtu.
//   3. Podmínky platnosti (§8) patří DO WHERE klauzule toho UPDATE, ne před něj
//      -- předsazená kontrola otevírá TOCTOU okno (viz CreditVoucherValidityRule).
//   4. `meta.changes === 0` je NEJEDNOZNAČNÉ: může to být version konflikt NEBO
//      nesplněná podmínka platnosti NEBO nedostatečný zůstatek. Implementace
//      MUSÍ po nule dočíst čerstvý řádek a důvod rozlišit -- proto má tenhle
//      kontrakt oddělené `VERSION_CONFLICT` / `INSUFFICIENT_BALANCE` /
//      `NOT_REDEEMABLE` větve a ne jedno tupé `false`.
//   5. Selhání INSERTu na `uq_voucher_redemption` (UNIQUE (voucher_id, order_id)
//      WHERE type = 'REDEEMED') se MUSÍ přeložit na `ALREADY_REDEEMED` a odečet
//      z bodu 2 vrátit zpět -- to je jediná situace, kdy je kompenzace povinná.
//      V praxi se sem nedostaneme, protože UNIQUE se typicky trefí až po
//      úspěšném UPDATE při dvojím webhooku; proto D1 implementace ověřuje
//      existenci REDEEMED transakce pro `(voucherId, orderId)` PŘED UPDATE
//      (rychlá cesta) a index je pojistka pro souběh.
//
// ============================================================================
// PENÍZE
// ============================================================================
// Interface pracuje výhradně s `Money{Decimal}` z `core/canonical/entities/base.ts`
// ("Peníze vždy jako Decimal, nikdy float"). D1 schéma (migrations/0001) ukládá
// peníze jako INTEGER v HALÉŘÍCH (sloupce se sufixem `_minor`) -- převod
// Decimal ↔ minor units je věc D1 MAPPERU v `connectors/`, NE tohohle kontraktu
// a NE entity. Kdyby se haléře objevily v signaturách tady, prosákla by
// perzistenční reprezentace do domény a někdo by se dřív nebo později spletl
// o dva řády.
//
// ============================================================================
// HRANICE
// ============================================================================
// §12: voucher je PLATEBNÍ / KREDITNÍ vrstva ZA hotovým součtem košíku, ne
// cenová sleva. Tenhle soubor proto NESMÍ importovat nic z `domains/pricing/`
// -- ani nepřímo.
//
// Každá mutace prochází `assertTenantOwnership()` z `core/tenant/types.js`
// PŘED zápisem -- reakce na nalezenou díru v AIE (`updateLineQuantity()`
// nefiltrovalo přes tenant_id). Tenant filtr v SQL WHERE je nutný, ale ne
// dostatečný: dá se zapomenout, tahle kontrola ne.

import Decimal from 'decimal.js';
import { assertTenantOwnership, type TenantContext } from '../../core/tenant/types.js';
import type { EntityId, ISODateTime, Money, TenantId } from '../../core/canonical/entities/base.js';
import type {
    CreditVoucher,
    CreditVoucherLifecycleState,
    CreditVoucherTransaction,
    CreditVoucherTransactionType,
} from '../../core/canonical/entities/CreditVoucher.js';

// ---------------------------------------------------------------------------
// issue()
// ---------------------------------------------------------------------------

/**
 * Vstup emise. `id` je zároveň KÓD poukazu (`NEXUS-XXXX-XXXX-RRRR`, §4) --
 * generuje ho volající (generátor kódu), ne store: store není zdrojem
 * entropie a nesmí mít vlastní náhodnost (testovatelnost).
 *
 * `currentBalance`, `status` a `version` tu SCHVÁLNĚ NEJSOU. Při emisi jsou
 * odvozené a store je nastaví sám: `currentBalance = initialBalance`,
 * `status = 'ACTIVE'`, `version = 0` (D1 DEFAULT 0). Kdyby šly předat zvenčí,
 * dal by se vystavit poukaz už rovnou v nekonzistentním stavu.
 */
export interface IssueCreditVoucherInput {
    readonly id: EntityId;
    readonly tenantId: TenantId;
    readonly initialBalance: Money;
    readonly expiresAt: ISODateTime;
    /** Objednávka, KTEROU BYL POUKAZ ZAKOUPEN -- idempotency klíč emise (§4). */
    readonly sourceOrderId: EntityId;
    readonly customerEmail: string;
    /** Emisní čas -- VSTUP, nikdy `Date.now()` uvnitř store (determinismus, testovatelnost). */
    readonly issuedAt: ISODateTime;
    readonly createdBy?: string;
}

/**
 * Výsledek emise. `alreadyExisted: true` znamená, že pro
 * `(tenantId, sourceOrderId)` už poukaz existoval a JE VRÁCEN TEN PŮVODNÍ --
 * nevystavil se druhý (D1: `uq_vouchers_source_order`). Není to chyba: je to
 * očekávaný výsledek dvojího doručení téhož webhooku o koupi poukazu (§4).
 *
 * D1 implementace to řeší `INSERT ... ON CONFLICT DO NOTHING` + `meta.changes`,
 * NE předsazeným SELECTem -- ten by mezi kontrolou a zápisem nechal okno,
 * kterým projdou dvě souběžná doručení webhooku.
 */
export interface IssueCreditVoucherResult {
    readonly voucher: CreditVoucher;
    readonly alreadyExisted: boolean;
    /** ISSUED transakce. `undefined`, pokud `alreadyExisted` (nová se nezakládá). */
    readonly transaction?: CreditVoucherTransaction;
}

// ---------------------------------------------------------------------------
// redeem() / refund()
// ---------------------------------------------------------------------------

export interface RedeemCreditVoucherParams {
    readonly tenantId: TenantId;
    readonly voucherId: EntityId;
    /** Objednávka, ve které se kredit ČERPÁ. Druhá půlka `uq_voucher_redemption`. */
    readonly orderId: EntityId;
    /** Kladná částka k odečtu. Směr nese typ transakce, ne znaménko (invariant 1). */
    readonly amount: Money;
    /**
     * Verze přečtená volajícím. Jde do `WHERE version = ?` -- jediný důkaz,
     * že mezi čtením a zápisem nikdo jiný zůstatek nezměnil (§7).
     */
    readonly expectedVersion: number;
    /** Referenční čas pro vyhodnocení `expires_at > NOW()` (§8). VSTUP, ne systémové hodiny. */
    readonly now: ISODateTime;
}

/** Proč poukaz NELZE uplatnit -- 1:1 s podmínkami §8, pro čitelnou hlášku a audit. */
export type NotRedeemableReason = 'EXPIRED' | 'CANCELLED' | 'DEPLETED' | 'NOT_ACTIVE';

/**
 * Diskriminovaný union, NE `boolean` ani výjimka. Důvod: `meta.changes === 0`
 * je v D1 nejednoznačné (viz KRITICKÉ v hlavičce, bod 4) a volající se podle
 * důvodu chová jinak:
 *   - `VERSION_CONFLICT`     -> načíst čerstvý stav a retry (max 3 pokusy +
 *                               exponenciální backoff, pak zamítnutí do auditu).
 *   - `INSUFFICIENT_BALANCE` -> retry NEMÁ smysl, jde o business zamítnutí.
 *   - `NOT_REDEEMABLE`       -> retry NEMÁ smysl, poukaz je mimo hru.
 *   - `ALREADY_REDEEMED`     -> ÚSPĚCH z pohledu volajícího: dvojí webhook,
 *                               kredit už odečten. NIKDY neodečítat znovu.
 *
 * Kdyby to byl `boolean`, slil by se retryovatelný souběh s neretryovatelným
 * zamítnutím -- a "vyčerpaný retry" z §7 by nešel odlišit od skutečného
 * nedostatku kreditu.
 */
export type RedeemOutcome =
    | {
          readonly outcome: 'REDEEMED';
          readonly newBalance: Money;
          readonly newVersion: number;
          readonly transactionId: EntityId;
      }
    /** `meta.changes === 0` a v DB je jiná verze -- souběh. Retryovatelné. */
    | { readonly outcome: 'VERSION_CONFLICT'; readonly actualVersion: number }
    | { readonly outcome: 'INSUFFICIENT_BALANCE'; readonly currentBalance: Money }
    /** Expirovaný / stornovaný / vyčerpaný poukaz -- `WHERE` podmínky §8 neprošly. */
    | { readonly outcome: 'NOT_REDEEMABLE'; readonly reason: NotRedeemableReason }
    /** UNIQUE (voucher_id, order_id) WHERE type = 'REDEEMED' -- dvojí webhook. */
    | { readonly outcome: 'ALREADY_REDEEMED'; readonly transactionId: EntityId };

export interface RefundCreditVoucherParams {
    readonly tenantId: TenantId;
    readonly voucherId: EntityId;
    /** Objednávka, ve které byl kredit původně čerpán. Povinná (invariant 3). */
    readonly orderId: EntityId;
    readonly amount: Money;
    readonly expectedVersion: number;
    readonly now: ISODateTime;
}

/**
 * Refundace má vlastní union, protože její selhání jsou JINÁ než u čerpání:
 * kredit se PŘIČÍTÁ, takže "nedostatečný zůstatek" tu neexistuje -- zato
 * existuje strop `initialBalance` (invariant 1, v D1 vynucený
 * `ck_vouchers_balance_within_initial`). Vrácení víc, než kolik bylo
 * vyčerpáno, je pokus o vytvoření peněz z ničeho, ne edge case k tolerování.
 *
 * `DEPLETED -> ACTIVE` je legitimní přechod (CreditVoucher.ts) -- refundace
 * vrací vyčerpaný poukaz zpět do hry. `EXPIRED` a `CANCELLED` jsou terminální,
 * refundovat se na ně nesmí (`NOT_REFUNDABLE`).
 */
export type RefundOutcome =
    | {
          readonly outcome: 'REFUNDED';
          readonly newBalance: Money;
          readonly newVersion: number;
          readonly transactionId: EntityId;
          /** `true`, pokud refundace překlopila `DEPLETED -> ACTIVE`. */
          readonly reactivated: boolean;
      }
    | { readonly outcome: 'VERSION_CONFLICT'; readonly actualVersion: number }
    /** Vrácení by přeteklo `initialBalance` -- vytváření kreditu z ničeho. */
    | { readonly outcome: 'EXCEEDS_INITIAL_BALANCE'; readonly currentBalance: Money }
    /** Poukaz je v terminálním stavu (EXPIRED / CANCELLED). */
    | { readonly outcome: 'NOT_REFUNDABLE'; readonly reason: 'EXPIRED' | 'CANCELLED' }
    /** Neexistuje REDEEMED transakce pro `(voucherId, orderId)` -- není co vracet. */
    | { readonly outcome: 'NOTHING_TO_REFUND' };

// ---------------------------------------------------------------------------
// Store kontrakt
// ---------------------------------------------------------------------------

/**
 * Store kontrakt -- rozhraní, ne konkrétní storage. Produkční D1 implementace
 * žije mimo `domains/` (Connector Layer), stejně jako `IdempotencyStore`
 * odkazuje produkční Postgres/D1/KV implementaci do platform vrstvy.
 * Doména zůstává bez I/O detailů.
 *
 * Všechny metody jsou `Promise`-based: na rozdíl od `IdempotencyStore`
 * (synchronní, in-memory vzor z AIE) je jediná reálná implementace tady
 * síťová (D1 přes Worker binding) a synchronní signatura by ji znemožnila.
 */
export interface CreditVoucherStore {
    /**
     * Vystaví poukaz a JEDNÍM krokem k němu založí `ISSUED` transakci.
     * IDEMPOTENTNÍ na `(tenantId, sourceOrderId)` -- D1 `uq_vouchers_source_order`:
     * druhé doručení téhož webhooku vrátí PŮVODNÍ poukaz s
     * `alreadyExisted: true`, nevystaví druhý a NEZALOŽÍ druhou ISSUED transakci.
     */
    issue(context: TenantContext, input: IssueCreditVoucherInput): Promise<IssueCreditVoucherResult>;

    /**
     * Najde poukaz podle kódu (`id` JE kód, §4). `undefined`, pokud neexistuje
     * nebo patří jinému tenantovi -- NIKDY se nesmí prozradit rozdíl mezi
     * "neexistuje" a "je cizí": kód je platidlo a rozdíl v odpovědi by
     * umožnil enumeraci napříč tenanty.
     *
     * Snapshot, ne živý stav. Kladný výsledek NEOPRAVŇUJE k odečtu kreditu
     * (viz CreditVoucherValidityRule) -- odečet smí jen `redeem()`.
     */
    findByCode(tenantId: TenantId, code: EntityId): Promise<CreditVoucher | undefined>;

    /**
     * ATOMICKÉ čerpání kreditu -- jediná legitimní cesta, jak snížit zůstatek.
     *
     * KONTRAKT IMPLEMENTACE (viz KRITICKÉ v hlavičce, závazné pro D1):
     *   1. `UPDATE vouchers SET current_balance_minor = current_balance_minor - ?,
     *      status = ..., version = version + 1 WHERE id = ? AND tenant_id = ?
     *      AND version = ? AND status = 'ACTIVE' AND expires_at > ?
     *      AND current_balance_minor >= ?`
     *   2. Ověřit `meta.changes === 1`. Při 0 dočíst čerstvý řádek a rozlišit
     *      důvod (VERSION_CONFLICT / INSUFFICIENT_BALANCE / NOT_REDEEMABLE) --
     *      NIKDY nepokračovat na krok 3.
     *   3. TEPRVE PAK `INSERT INTO voucher_transactions (type = 'REDEEMED')`.
     *
     * NIKDY neházet výjimku na business zamítnutí -- zamítnutí je normální
     * výsledek a patří do unionu, ne do `catch`. Výjimka je vyhrazená pro
     * `TenantIsolationViolation` a skutečné I/O chyby.
     */
    redeem(context: TenantContext, params: RedeemCreditVoucherParams): Promise<RedeemOutcome>;

    /**
     * PROTIPOHYB k `redeem()`. Historie je append-only -- oprava se NIKDY
     * nedělá editací ani smazáním `REDEEMED` záznamu, ale novou `REFUNDED`
     * transakcí. Stejný atomický kontrakt jako `redeem()` (UPDATE → ověřit
     * `meta.changes === 1` → INSERT), jen opačným směrem, a navíc
     * `DEPLETED -> ACTIVE` překlopení stavu tímtéž UPDATE.
     */
    refund(context: TenantContext, params: RefundCreditVoucherParams): Promise<RefundOutcome>;

    /**
     * Finanční historie poukazu, seřazená vzestupně podle `createdAt`
     * (D1 index `idx_vtx_voucher`). Zdroj pro reconciliační invariant
     * `currentBalance === initialBalance - SUM(REDEEMED|EXPIRED|CANCELLED)
     * + SUM(REFUNDED)` (CreditVoucher.ts RECONCILIATION CONTRACT).
     */
    listTransactions(
        tenantId: TenantId,
        voucherId: EntityId
    ): Promise<readonly CreditVoucherTransaction[]>;
}

// ---------------------------------------------------------------------------
// In-memory referenční implementace
// ---------------------------------------------------------------------------

const ZERO = new Decimal(0);

/** Časové porovnání ISO8601. `undefined` = nerozparsovatelný vstup (fail-closed). */
function isStrictlyAfter(later: ISODateTime, earlier: ISODateTime): boolean | undefined {
    const laterMs = Date.parse(later);
    const earlierMs = Date.parse(earlier);
    if (Number.isNaN(laterMs) || Number.isNaN(earlierMs)) {
        return undefined;
    }
    return laterMs > earlierMs;
}

/**
 * Kontrola shody měny. Invariant 2 (`CreditVoucher`): poukaz má JEDNU měnu po
 * celý život. Míchání měn není zamítnutí k vrácení v unionu, ale programátorská
 * chyba -- proto throw, ne `outcome`.
 */
function assertSameCurrency(expected: Money, actual: Money, operation: string): void {
    if (expected.currency !== actual.currency) {
        throw new Error(
            `Currency mismatch in ${operation}: voucher is "${expected.currency}", got "${actual.currency}"`
        );
    }
}

/** Invariant 1 transakce: částka pohybu je vždy kladná, směr nese `type`. */
function assertPositiveAmount(amount: Money, operation: string): void {
    if (!amount.amount.greaterThan(ZERO)) {
        throw new Error(`Amount must be positive in ${operation}, got ${amount.amount.toString()}`);
    }
}

function money(amount: Decimal, currency: string): Money {
    return { amount, currency };
}

/**
 * In-memory referenční implementace -- pro TESTY a jako vzor pro D1
 * implementaci v `connectors/`. NENÍ určena pro produkční použití napříč
 * více Worker instancemi (žádná perzistence, žádná distribuovaná atomicita).
 *
 * SIMULUJE ZÁMĚRNĚ I SELHÁNÍ, ne jen šťastnou cestu -- jinak by proti ní
 * nešlo testovat to, co v produkci reálně padá:
 *   - VERSION KONFLIKT: `expectedVersion` se porovnává s uloženou `version`
 *     stejně jako `WHERE version = ?`; neshoda vrací `VERSION_CONFLICT`
 *     s aktuální verzí. Test si tedy vyrobí konflikt prostě tím, že zavolá
 *     `redeem()` dvakrát se stejnou `expectedVersion`.
 *   - UNIQUE CONSTRAINT: `redemptionIndex` je in-memory ekvivalent partial
 *     indexu `uq_voucher_redemption (voucher_id, order_id) WHERE type =
 *     'REDEEMED'`. Druhé čerpání téže objednávky z téhož poukazu vrátí
 *     `ALREADY_REDEEMED` a zůstatek NEZMĚNÍ -- přesně jako dvojí webhook.
 *   - UNIQUE na emisi: `sourceOrderIndex` odpovídá `uq_vouchers_source_order`.
 *
 * Pořadí kontrol kopíruje kontrakt z hlavičky: nejdřív "vydání kreditu"
 * (stav voucheru), pak zápis transakce. JediNÝ vědomý rozdíl proti D1 je,
 * že `ALREADY_REDEEMED` se tu zjistí PŘED úpravou zůstatku (single-threaded
 * JS, žádný souběh) -- v D1 je to rychlá cesta plus index jako pojistka.
 * Výsledek je z pohledu volajícího identický, což je to, co testy ověřují.
 */
export class InMemoryCreditVoucherStore implements CreditVoucherStore {
    private readonly vouchers = new Map<EntityId, CreditVoucher>();
    private readonly transactions: CreditVoucherTransaction[] = [];
    /** `uq_vouchers_source_order` -- `${tenantId} ${sourceOrderId}` -> voucherId. */
    private readonly sourceOrderIndex = new Map<string, EntityId>();
    /** `uq_voucher_redemption` -- `${voucherId} ${orderId}` -> transactionId. */
    private readonly redemptionIndex = new Map<string, EntityId>();
    private transactionSeq = 0;

    async issue(
        context: TenantContext,
        input: IssueCreditVoucherInput
    ): Promise<IssueCreditVoucherResult> {
        // Mutace -> tenant kontrola PŘED zápisem. `input` ještě není entita,
        // ale nese `tenantId`, což je přesně to, co se ověřuje.
        assertTenantOwnership(context, { tenantId: input.tenantId }, 'CreditVoucher', input.id);
        assertPositiveAmount(input.initialBalance, 'issue');

        // uq_vouchers_source_order: jedna objednávka = jeden poukaz (§4).
        const sourceKey = this.sourceOrderKey(input.tenantId, input.sourceOrderId);
        const existingId = this.sourceOrderIndex.get(sourceKey);
        if (existingId !== undefined) {
            const existing = this.vouchers.get(existingId);
            if (existing === undefined) {
                // Index ukazuje na neexistující poukaz -- rozbitý invariant
                // store, ne business případ. Tichý fallback by zamaskoval bug.
                throw new Error(
                    `Corrupted store: source order index points to missing voucher "${existingId}"`
                );
            }
            return { voucher: existing, alreadyExisted: true };
        }

        if (this.vouchers.has(input.id)) {
            // Kolize KÓDU poukazu (PRIMARY KEY), ne idempotence. Generátor kódu
            // vyrobil duplicitu -- to je incident (kód je platidlo), ne no-op.
            throw new Error(`CreditVoucher code "${input.id}" already exists`);
        }

        const currency = input.initialBalance.currency;
        const voucher: CreditVoucher = {
            id: input.id,
            tenantId: input.tenantId,
            createdAt: input.issuedAt,
            updatedAt: input.issuedAt,
            initialBalance: money(input.initialBalance.amount, currency),
            // Odvozené, ne vstup: nový poukaz je vždy plný, ACTIVE, version 0.
            currentBalance: money(input.initialBalance.amount, currency),
            expiresAt: input.expiresAt,
            sourceOrderId: input.sourceOrderId,
            customerEmail: input.customerEmail,
            status: 'ACTIVE',
            version: 0,
        };

        this.vouchers.set(voucher.id, voucher);
        this.sourceOrderIndex.set(sourceKey, voucher.id);

        // ISSUED nemá `orderId` (ck_vtx_order_id_presence): `sourceOrderId`
        // je na voucheru, ne na pohybu -- emise není spotřebitelská objednávka.
        const transaction = this.appendTransaction({
            voucher,
            type: 'ISSUED',
            amount: money(input.initialBalance.amount, currency),
            at: input.issuedAt,
        });

        return { voucher, alreadyExisted: false, transaction };
    }

    async findByCode(tenantId: TenantId, code: EntityId): Promise<CreditVoucher | undefined> {
        const voucher = this.vouchers.get(code);
        // Cizí tenant => `undefined`, ne throw a ne jiná hláška: rozdíl
        // v odpovědi by umožnil enumeraci kódů napříč tenanty.
        if (voucher === undefined || voucher.tenantId !== tenantId) {
            return undefined;
        }
        return voucher;
    }

    async redeem(
        context: TenantContext,
        params: RedeemCreditVoucherParams
    ): Promise<RedeemOutcome> {
        const voucher = this.requireOwnedVoucher(context, params.tenantId, params.voucherId);
        assertPositiveAmount(params.amount, 'redeem');
        assertSameCurrency(voucher.currentBalance, params.amount, 'redeem');

        // uq_voucher_redemption. V D1 je tohle rychlá cesta a index pojistka;
        // tady je to jediná vrstva (single-threaded, souběh neexistuje).
        // Kredit se NESMÍ odečíst podruhé -- výsledek je ÚSPĚCH pro volajícího.
        const redemptionKey = this.redemptionKey(params.voucherId, params.orderId);
        const existingTxId = this.redemptionIndex.get(redemptionKey);
        if (existingTxId !== undefined) {
            return { outcome: 'ALREADY_REDEEMED', transactionId: existingTxId };
        }

        // `WHERE version = ?` ekvivalent. Pořadí je záměrné: verze se
        // vyhodnocuje PŘED podmínkami platnosti, protože při konfliktu je
        // přečtený snapshot zastaralý a jakýkoli jiný důvod by byl odvozen
        // z neplatných dat.
        if (voucher.version !== params.expectedVersion) {
            return { outcome: 'VERSION_CONFLICT', actualVersion: voucher.version };
        }

        const notRedeemable = this.evaluateRedeemability(voucher, params.now);
        if (notRedeemable !== undefined) {
            return { outcome: 'NOT_REDEEMABLE', reason: notRedeemable };
        }

        const newAmount = voucher.currentBalance.amount.minus(params.amount.amount);
        if (newAmount.lessThan(ZERO)) {
            // ck_vouchers_balance_non_negative. Business zamítnutí, ne chyba.
            return { outcome: 'INSUFFICIENT_BALANCE', currentBalance: voucher.currentBalance };
        }

        // KROK 1 -- odečet kreditu a stav TÝMŽ zápisem (invariant 4:
        // `currentBalance === 0` <=> `status === 'DEPLETED'`, nikdy druhým
        // příkazem, který by mohl neproběhnout).
        const updated = this.writeBalance({
            voucher,
            newAmount,
            newStatus: newAmount.isZero() ? 'DEPLETED' : voucher.status,
            at: params.now,
        });

        // KROK 2 -- transakce AŽ po prokázaném odečtu (viz KRITICKÉ v hlavičce).
        const transaction = this.appendTransaction({
            voucher: updated,
            type: 'REDEEMED',
            amount: money(params.amount.amount, params.amount.currency),
            orderId: params.orderId,
            at: params.now,
        });
        this.redemptionIndex.set(redemptionKey, transaction.id);

        return {
            outcome: 'REDEEMED',
            newBalance: updated.currentBalance,
            newVersion: updated.version,
            transactionId: transaction.id,
        };
    }

    async refund(
        context: TenantContext,
        params: RefundCreditVoucherParams
    ): Promise<RefundOutcome> {
        const voucher = this.requireOwnedVoucher(context, params.tenantId, params.voucherId);
        assertPositiveAmount(params.amount, 'refund');
        assertSameCurrency(voucher.currentBalance, params.amount, 'refund');

        if (voucher.version !== params.expectedVersion) {
            return { outcome: 'VERSION_CONFLICT', actualVersion: voucher.version };
        }

        // Terminální stavy (CREDIT_VOUCHER_LIFECYCLE_DEFINITION): z EXPIRED
        // ani CANCELLED nevede cesta zpět. Prodloužení = nový poukaz.
        if (voucher.status === 'EXPIRED' || voucher.status === 'CANCELLED') {
            return { outcome: 'NOT_REFUNDABLE', reason: voucher.status };
        }

        // Není co vracet, když se z téhle objednávky nikdy nečerpalo.
        // Bez téhle kontroly by refundace byla generátorem kreditu.
        if (!this.redemptionIndex.has(this.redemptionKey(params.voucherId, params.orderId))) {
            return { outcome: 'NOTHING_TO_REFUND' };
        }

        const newAmount = voucher.currentBalance.amount.plus(params.amount.amount);
        if (newAmount.greaterThan(voucher.initialBalance.amount)) {
            // ck_vouchers_balance_within_initial -- strop je tvrdý invariant.
            return { outcome: 'EXCEEDS_INITIAL_BALANCE', currentBalance: voucher.currentBalance };
        }

        // DEPLETED -> ACTIVE: refundace vrací vyčerpaný poukaz zpět do hry
        // (CreditVoucher.ts: DEPLETED NENÍ terminální).
        const reactivated = voucher.status === 'DEPLETED' && newAmount.greaterThan(ZERO);

        const updated = this.writeBalance({
            voucher,
            newAmount,
            newStatus: reactivated ? 'ACTIVE' : voucher.status,
            at: params.now,
        });

        const transaction = this.appendTransaction({
            voucher: updated,
            type: 'REFUNDED',
            amount: money(params.amount.amount, params.amount.currency),
            orderId: params.orderId,
            at: params.now,
        });

        return {
            outcome: 'REFUNDED',
            newBalance: updated.currentBalance,
            newVersion: updated.version,
            transactionId: transaction.id,
            reactivated,
        };
    }

    async listTransactions(
        tenantId: TenantId,
        voucherId: EntityId
    ): Promise<readonly CreditVoucherTransaction[]> {
        // Filtr přes tenant I voucher -- cizí tenant dostane prázdný seznam,
        // ne cizí historii a ne chybu (stejný důvod jako u `findByCode`).
        return this.transactions.filter(
            (tx) => tx.creditVoucherId === voucherId && tx.tenantId === tenantId
        );
    }

    // -- interní ------------------------------------------------------------

    private sourceOrderKey(tenantId: TenantId, sourceOrderId: EntityId): string {
        // Mezera jako oddělovač -- stejná úvaha jako v IdempotencyStore:
        // v tenant ID ani order ID se nevyskytuje, takže klíče nemohou kolidovat.
        return `${tenantId} ${sourceOrderId}`;
    }

    private redemptionKey(voucherId: EntityId, orderId: EntityId): string {
        return `${voucherId} ${orderId}`;
    }

    /**
     * Načte poukaz a ověří vlastnictví. Neexistující poukaz je throw, ne
     * `outcome`: mutace nad neexistující entitou je programátorská chyba
     * volajícího (nepředcházel `findByCode`), ne business zamítnutí -- stejná
     * úvaha jako `transitionTo()` v `IdempotencyStore`.
     */
    private requireOwnedVoucher(
        context: TenantContext,
        tenantId: TenantId,
        voucherId: EntityId
    ): CreditVoucher {
        const voucher = this.vouchers.get(voucherId);
        if (voucher === undefined) {
            throw new Error(`CreditVoucher "${voucherId}" not found`);
        }
        // Dvojí kontrola je záměrná: params.tenantId proti kontextu (volající
        // si nesmí sám určit tenanta) i entita proti kontextu.
        assertTenantOwnership(context, { tenantId }, 'CreditVoucher', voucherId);
        assertTenantOwnership(context, voucher, 'CreditVoucher', voucherId);
        return voucher;
    }

    /** Zůstatek, stav a `version` se mění VŽDY jedním zápisem (§7, invariant 4). */
    private writeBalance(args: {
        voucher: CreditVoucher;
        newAmount: Decimal;
        newStatus: CreditVoucherLifecycleState;
        at: ISODateTime;
    }): CreditVoucher {
        const updated: CreditVoucher = {
            ...args.voucher,
            currentBalance: money(args.newAmount, args.voucher.currentBalance.currency),
            status: args.newStatus,
            version: args.voucher.version + 1,
            updatedAt: args.at,
        };
        this.vouchers.set(updated.id, updated);
        return updated;
    }

    /** APPEND-ONLY: záznam se nikdy nemaže ani nepřepisuje (protipohyb, ne editace). */
    private appendTransaction(args: {
        voucher: CreditVoucher;
        type: CreditVoucherTransactionType;
        amount: Money;
        orderId?: EntityId;
        at: ISODateTime;
    }): CreditVoucherTransaction {
        this.transactionSeq += 1;
        const transaction: CreditVoucherTransaction = {
            // D1 má `INTEGER PRIMARY KEY AUTOINCREMENT`; `EntityId` je string,
            // takže mapper i tady vyrábí string. Prefix odlišuje ID transakce
            // od kódu poukazu na první pohled v logu.
            id: `vtx-${this.transactionSeq}`,
            tenantId: args.voucher.tenantId,
            createdAt: args.at,
            updatedAt: args.at,
            creditVoucherId: args.voucher.id,
            type: args.type,
            amount: args.amount,
            ...(args.orderId !== undefined ? { orderId: args.orderId } : {}),
        };
        this.transactions.push(transaction);
        return transaction;
    }

    /**
     * Podmínky platnosti §8 v pořadí, které nese nejvíc informace pro
     * zákazníka i podporu. `undefined` = uplatnitelný.
     *
     * Vědomě NEVOLÁ `CreditVoucherValidityRule`: ta je pro validační endpoint
     * a čitelné hlášky, tohle je in-memory náhrada SQL WHERE klauzule.
     * Sdílení by svádělo k tomu použít Rule jako obranu před zápisem, což §8
     * výslovně zakazuje (TOCTOU).
     */
    private evaluateRedeemability(
        voucher: CreditVoucher,
        now: ISODateTime
    ): NotRedeemableReason | undefined {
        if (voucher.status === 'CANCELLED') {
            return 'CANCELLED';
        }
        if (voucher.status === 'EXPIRED') {
            return 'EXPIRED';
        }

        // `expires_at > NOW()` -- ostrá nerovnost, přesně jako v SQL WHERE.
        const notExpired = isStrictlyAfter(voucher.expiresAt, now);
        if (notExpired !== true) {
            // `undefined` (nerozparsovatelný timestamp) i `false` končí stejně:
            // fail-closed. Nečitelný čas se NIKDY nevyhodnotí jako platný.
            return 'EXPIRED';
        }

        // Poukaz může být `DEPLETED` (stav), nebo `ACTIVE` s nulou (rozjeté
        // stavy, OPEN QUESTION 3) -- obojí je z pohledu čerpání totéž.
        if (!voucher.currentBalance.amount.greaterThan(ZERO)) {
            return 'DEPLETED';
        }
        if (voucher.status !== 'ACTIVE') {
            return 'NOT_ACTIVE';
        }
        return undefined;
    }
}
