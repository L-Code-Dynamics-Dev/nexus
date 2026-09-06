// D1CreditVoucherStore -- produkční D1 implementace `CreditVoucherStore`.
// Connector Layer, Fáze A "Voucher Core"
// (docs/design-proposals/Digital-Voucher.md §3/§4/§7/§8, migrations/0001 + 0002).
//
// UMÍSTĚNÍ: `connectors/d1/`, ne `domains/voucher/`. Kontrakt
// `domains/voucher/CreditVoucherStore.ts` to říká výslovně ("Produkční D1
// implementace SEM NEPATŘÍ -- žije v connectors/"): doména zůstává bez I/O
// detailů, stejně jako `IdempotencyStore` odkazuje produkční perzistenci
// do platform vrstvy.
//
// ============================================================================
// KRITICKÉ -- D1 `batch()` NENÍ transakce v tom smyslu, v jakém ji potřebujeme
// ============================================================================
// Není to teorie, je to PROKÁZANÉ CI testem (`tests/workers/schema.test.ts`,
// blok 8): `batch([UPDATE ... WHERE version = <stará>, INSERT REDEEMED])`
// skončí `odectenoMinor: 0, zapsanychCerpani: 1`. D1 batch se rollbackuje
// POUZE při SQL chybě a UPDATE, který nematchne žádný řádek, SQL chyba NENÍ.
//
// A je to horší než jen rozejitý invariant: ten INSERT zabere partial unique
// index `uq_voucher_redemption`, takže NÁSLEDNÝ retry spadne na constraintu,
// vyhodnotí se jako "idempotentní replay" a objednávka projde jako zaplacená
// kreditem, který se nikdy neodečetl.
//
// POŘADÍ JE PROTO NEMĚNNÉ, ve všech mutujících metodách tohoto souboru:
//   1. UPDATE zůstatku SAMOSTATNĚ (nikdy v `batch()` s INSERTem),
//   2. ověřit `meta.changes === 1` -- JEDINÝ důkaz úspěchu (§7),
//   3. TEPRVE PAK INSERT transakčního záznamu,
//   4. při unique violation na INSERTu KOMPENZOVAT odečet z kroku 1.
//
// Mezi krokem 1 a 3 je okno, ve kterém může Worker umřít -- kredit odečten,
// transakce nezapsaná. To je VĚDOMĚ ZVOLENÝ SMĚR CHYBY: chybějící záznam
// odchytí reconciliace (`core/reconciliation`) a opraví se protipohybem,
// zatímco opačné pořadí by vyrobilo záznam bez odečtu, což tiše rozdává zboží
// zdarma a nedetekuje se. NIKDY nepřehazovat "aby to bylo konzistentnější".
//
// Referenční implementace téhož vzoru: `consumeCredit()` ve
// `workers/api/routes/voucher.ts`. Tenhle store ji NENAHRAZUJE ani nevolá
// (master rule Non-Interference -- ta cesta je otestovaná a zůstává nedotčená);
// je to tentýž vzor vyjádřený proti doménovému kontraktu.
//
// ============================================================================
// CO TENHLE STORE VĚDOMĚ NEDĚLÁ
// ============================================================================
//   - NERETRYUJE. Kontrakt vrací `VERSION_CONFLICT` s aktuální verzí a
//     rozhodnutí "retry vs. zamítnutí" (§7: max 3 pokusy + exponenciální
//     backoff, pak audit) patří volajícímu. Store, který si retryuje sám,
//     by volajícímu sebral možnost to počítat a logovat.
//   - NEČTE SYSTÉMOVÉ HODINY. `now` je vstup (`params.now`), stejně jako
//     `issuedAt` u emise -- determinismus a testovatelnost. Proto SQL WHERE
//     porovnává `expires_at > ?`, ne `expires_at > datetime('now')`.
//   - NEPÍŠE DO `voucher_audit`. Ta tabulka je PROVOZNÍ historie událostí bez
//     finančního dopadu (HOLD, zamítnutí, vyčerpaný retry) a její zápis je
//     věcí volajícího, který zná kontext a payload. Store zapisuje jen
//     finanční pohyby do `voucher_transactions`.
//   - NEIMPORTUJE NIC Z `domains/pricing/` (§12: voucher je platební vrstva
//     ZA hotovým součtem košíku, ne cenová sleva).

import Decimal from 'decimal.js';
import { assertTenantOwnership, type TenantContext } from '../../core/tenant/types.js';
import type { EntityId, ISODateTime, Money, TenantId } from '../../core/canonical/entities/base.js';
import type {
    CreditVoucher,
    CreditVoucherLifecycleState,
    CreditVoucherTransaction,
    CreditVoucherTransactionType,
} from '../../core/canonical/entities/CreditVoucher.js';
import type {
    CreditVoucherStore,
    IssueCreditVoucherInput,
    IssueCreditVoucherResult,
    NotRedeemableReason,
    RedeemCreditVoucherParams,
    RedeemOutcome,
    RefundCreditVoucherParams,
    RefundOutcome,
} from '../../domains/voucher/CreditVoucherStore.js';
import { minorToMoney, moneyToMinor } from './moneyMapper.js';

// ---------------------------------------------------------------------------
// Minimální D1 typy
// ---------------------------------------------------------------------------
// PROČ NE `@cloudflare/workers-types`: balík JE v devDependencies, ale root
// `tsconfig.json` (který kompiluje `connectors/`) má `moduleResolution: "node"`
// a žádné `types`, takže Workers typy nevidí; `workers/api/types.ts` je z jeho
// `include` vyloučený, takže se odtud ani nedá importovat. Root config se
// NEMĚNÍ (master rule Non-Interference -- stojí na něm 644 node testů).
//
// Tvary odpovídají veřejnému D1 API (developers.cloudflare.com/d1/worker-api)
// a jsou strukturálně kompatibilní s reálným `D1Database` -- binding z Workeru
// se sem předá bez castu. Duplicita s `workers/api/types.ts` je vědomá cena
// za to, že se root tsconfig nemusí sahat.

export interface D1MetaLike {
    /** §7: `changes === 1` je JEDINÝ důkaz, že se zůstatek skutečně pohnul. */
    readonly changes: number;
    readonly last_row_id: number;
}

export interface D1ResultLike<T = Record<string, unknown>> {
    readonly results: T[];
    readonly success: boolean;
    readonly meta: D1MetaLike;
}

export interface D1PreparedStatementLike {
    bind(...values: unknown[]): D1PreparedStatementLike;
    first<T = Record<string, unknown>>(): Promise<T | null>;
    run<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
    all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
}

export interface D1DatabaseLike {
    prepare(query: string): D1PreparedStatementLike;
}

// ---------------------------------------------------------------------------
// Řádkové tvary
// ---------------------------------------------------------------------------

interface VoucherRow {
    readonly id: string;
    readonly tenant_id: string;
    readonly initial_balance_minor: number;
    readonly current_balance_minor: number;
    readonly currency: string;
    readonly created_at: string;
    readonly updated_at: string | null;
    readonly expires_at: string;
    readonly source_order_id: string;
    readonly customer_email: string;
    readonly status: string;
    readonly version: number;
}

interface TransactionRow {
    readonly id: number;
    readonly voucher_id: string;
    readonly tenant_id: string;
    readonly type: string;
    readonly amount_minor: number;
    readonly currency: string;
    readonly order_id: string | null;
    readonly created_at: string;
}

/**
 * Sloupce voucheru vyjmenované explicitně, nikdy `SELECT *`.
 *
 * `updated_at` v migraci 0001 NENÍ (schéma má jen `created_at`), ale
 * `CanonicalEntity` ho vyžaduje. Řeší to `NULL AS updated_at` + fallback na
 * `created_at` v mapperu: doména dostane platnou hodnotu a schéma se kvůli
 * tomu nemusí měnit (migrace je nasazená, přidání sloupce je samostatné
 * rozhodnutí, ne vedlejší efekt téhle třídy). Až sloupec vznikne, stačí
 * `NULL AS updated_at` nahradit za `updated_at` a mapper zůstane platný.
 */
const VOUCHER_COLUMNS = `id, tenant_id, initial_balance_minor, current_balance_minor,
                         currency, created_at, NULL AS updated_at, expires_at,
                         source_order_id, customer_email, status, version`;

const ZERO = new Decimal(0);

// ---------------------------------------------------------------------------
// Chybové typy
// ---------------------------------------------------------------------------

/**
 * Chyba úložiště. Vlastní typ proto, aby volající (Worker) uměl odlišit
 * dočasný výpadek D1 (-> 503, webhook odesílatel retryuje) od programátorské
 * chyby nebo porušení tenant izolace (-> 500 / 403). Bez toho by se to
 * rozlišovalo podle textu hlášky.
 *
 * `cause` nese původní chybu -- pro strukturovaný log, ne pro odpověď klientovi
 * (může obsahovat fragment SQL).
 */
export class VoucherStorageError extends Error {
    readonly operation: string;
    override readonly cause?: unknown;

    constructor(operation: string, message: string, cause?: unknown) {
        super(message);
        this.name = 'VoucherStorageError';
        this.operation = operation;
        this.cause = cause;
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Rozpozná porušení UNIQUE constraintu podle hlášky SQLite/D1.
 *
 * Text, ne kód: D1 chybu neserializuje s `code`, dostupná je jen zpráva
 * (typicky `D1_ERROR: UNIQUE constraint failed: vouchers.tenant_id, ...`).
 * Shodné s `isUniqueConstraintViolation()` ve `workers/api/routes/voucher.ts` --
 * kdyby se to jednou rozešlo, je to jedno místo k opravě v každém souboru.
 */
function isUniqueConstraintViolation(message: string): boolean {
    const normalized = message.toUpperCase();
    return normalized.includes('UNIQUE CONSTRAINT') || normalized.includes('SQLITE_CONSTRAINT');
}

/** Invariant 1 transakce: částka pohybu je vždy kladná, směr nese `type`. */
function assertPositiveAmount(amount: Money, operation: string): void {
    if (!amount.amount.greaterThan(ZERO)) {
        throw new Error(`Amount must be positive in ${operation}, got ${amount.amount.toString()}`);
    }
}

/**
 * Invariant 2: poukaz má JEDNU měnu po celý život. Míchání měn není business
 * zamítnutí k vrácení v unionu, ale programátorská chyba -- proto throw.
 */
function assertSameCurrency(expected: string, actual: string, operation: string): void {
    if (expected !== actual) {
        throw new Error(
            `Currency mismatch in ${operation}: voucher is "${expected}", got "${actual}"`
        );
    }
}

/**
 * Stav z DB na doménový výčet. Neznámá hodnota je throw, ne fallback:
 * `ck_vouchers_status` ji do tabulky nepustí, takže její výskyt znamená
 * rozejité schéma s kódem -- a tiché překlopení na 'ACTIVE' by v tom případě
 * uvolnilo čerpání poukazu, o kterém aplikace nic neví.
 */
function toLifecycleState(status: string, voucherId: string): CreditVoucherLifecycleState {
    if (
        status === 'ACTIVE' ||
        status === 'DEPLETED' ||
        status === 'EXPIRED' ||
        status === 'CANCELLED'
    ) {
        return status;
    }
    throw new VoucherStorageError(
        'mapVoucher',
        `Unknown voucher status "${status}" on voucher "${voucherId}" -- schema and code disagree`
    );
}

function toTransactionType(type: string, transactionId: number): CreditVoucherTransactionType {
    if (
        type === 'ISSUED' ||
        type === 'REDEEMED' ||
        type === 'EXPIRED' ||
        type === 'CANCELLED' ||
        type === 'REFUNDED'
    ) {
        return type;
    }
    throw new VoucherStorageError(
        'mapTransaction',
        `Unknown transaction type "${type}" on transaction ${transactionId}`
    );
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Produkční D1 implementace `CreditVoucherStore`.
 *
 * BEZPEČNOST:
 *   - Prepared statements VŠUDE, žádná interpolace do SQL. Kód poukazu je
 *     uživatelský vstup a zároveň platidlo.
 *   - `tenant_id` je v každé WHERE klauzuli. Navíc `assertTenantOwnership()`
 *     před každou mutací -- SQL filtr je nutný, ale ne dostatečný: dá se
 *     zapomenout (reakce na nalezenou díru v AIE `updateLineQuantity()`).
 *   - `findByCode` / `listTransactions` vrací u cizího tenanta `undefined` /
 *     prázdný seznam, NIKDY jinou chybu -- rozdíl v odpovědi by umožnil
 *     enumeraci kódů napříč tenanty.
 *
 * LIMIT 100 BOUND PARAMETRŮ NA DOTAZ: žádný dotaz v téhle třídě nebinduje víc
 * než 8 hodnot a všechny pracují s jedním poukazem. Kdyby sem přibyla dávková
 * operace (hromadná expirace, admin výpis podle seznamu kódů), MUSÍ se
 * chunkovat -- limit není doporučení.
 */
export class D1CreditVoucherStore implements CreditVoucherStore {
    private readonly db: D1DatabaseLike;

    constructor(db: D1DatabaseLike) {
        this.db = db;
    }

    // -- issue --------------------------------------------------------------

    /**
     * Emise poukazu + `ISSUED` transakce.
     *
     * IDEMPOTENCE na `(tenantId, sourceOrderId)` řeší `INSERT ... ON CONFLICT
     * DO NOTHING` + `meta.changes`, NE předsazený SELECT: mezi kontrolou
     * a zápisem by zůstalo okno, kterým projdou dvě souběžná doručení téhož
     * webhooku a vystaví dva poukazy.
     *
     * Pořadí je stejné jako u `redeem()`: nejdřív poukaz, pak transakce.
     * `ON CONFLICT DO NOTHING` bez `conflict target` pokrývá OBA unique
     * constrainty najednou -- `uq_vouchers_source_order` (idempotence) i
     * PRIMARY KEY na `id` (kolize kódu). Rozlišit je umí až následné dočtení:
     * vrátí-li se poukaz se SHODNÝM `source_order_id`, je to idempotentní
     * replay; při shodě jen na `id` je to KOLIZE KÓDU, tedy incident (kód je
     * platidlo a generátor vyrobil duplicitu), ne no-op -- proto throw.
     */
    async issue(
        context: TenantContext,
        input: IssueCreditVoucherInput
    ): Promise<IssueCreditVoucherResult> {
        // Mutace -> tenant kontrola PŘED zápisem. `input` ještě není entita,
        // ale nese `tenantId`, což je přesně to, co se ověřuje.
        assertTenantOwnership(context, { tenantId: input.tenantId }, 'CreditVoucher', input.id);
        assertPositiveAmount(input.initialBalance, 'issue');

        const currency = input.initialBalance.currency;
        const initialMinor = moneyToMinor(input.initialBalance);

        let inserted: boolean;
        try {
            const result = await this.db
                .prepare(
                    `INSERT INTO vouchers
                         (id, tenant_id, initial_balance_minor, current_balance_minor,
                          currency, created_at, expires_at, source_order_id,
                          customer_email, status, version, created_by)
                     VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7, ?8, 'ACTIVE', 0, ?9)
                     ON CONFLICT DO NOTHING`
                )
                .bind(
                    input.id,
                    input.tenantId,
                    // `?3` dvakrát: nový poukaz je vždy plný. Odvozená hodnota
                    // se počítá tady, ne u volajícího (kontrakt: `currentBalance`
                    // ve vstupu SCHVÁLNĚ není).
                    initialMinor,
                    currency,
                    input.issuedAt,
                    input.expiresAt,
                    input.sourceOrderId,
                    input.customerEmail,
                    input.createdBy ?? null
                )
                .run();
            inserted = result.meta.changes === 1;
        } catch (error) {
            throw new VoucherStorageError(
                'issue',
                `Failed to insert voucher: ${errorMessage(error)}`,
                error
            );
        }

        if (!inserted) {
            // Konflikt -- dočíst, CO tam leží, a rozlišit replay od kolize kódu.
            const existing = await this.readBySourceOrder(input.tenantId, input.sourceOrderId);
            if (existing === undefined) {
                // Nic na `source_order_id` -> konflikt byl na PRIMARY KEY.
                // Duplicitní KÓD poukazu je incident, ne idempotence.
                throw new VoucherStorageError(
                    'issue',
                    `CreditVoucher code "${input.id}" already exists (code collision, not an idempotent replay)`
                );
            }
            return { voucher: existing, alreadyExisted: true };
        }

        // ISSUED nemá `order_id` (ck_vtx_order_id_presence): `source_order_id`
        // je na voucheru, ne na pohybu -- emise není spotřebitelská objednávka.
        const transaction = await this.insertTransaction({
            voucherId: input.id,
            tenantId: input.tenantId,
            type: 'ISSUED',
            amountMinor: initialMinor,
            currency,
            orderId: null,
            createdAt: input.issuedAt,
            operation: 'issue',
        });

        const voucher: CreditVoucher = {
            id: input.id,
            tenantId: input.tenantId,
            createdAt: input.issuedAt,
            updatedAt: input.issuedAt,
            initialBalance: minorToMoney(initialMinor, currency),
            currentBalance: minorToMoney(initialMinor, currency),
            expiresAt: input.expiresAt,
            sourceOrderId: input.sourceOrderId,
            customerEmail: input.customerEmail,
            status: 'ACTIVE',
            version: 0,
        };

        return { voucher, alreadyExisted: false, transaction };
    }

    // -- findByCode ---------------------------------------------------------

    /**
     * Snapshot poukazu podle kódu. Cizí tenant i neexistující kód vrací
     * `undefined` -- stejná odpověď záměrně, viz bezpečnostní poznámka výše.
     *
     * Kladný výsledek NEOPRAVŇUJE k odečtu kreditu: podmínky platnosti se
     * vyhodnocují až v SQL WHERE čerpacího UPDATE (§8, TOCTOU).
     */
    async findByCode(tenantId: TenantId, code: EntityId): Promise<CreditVoucher | undefined> {
        const row = await this.readVoucherRow(tenantId, code);
        return row === null ? undefined : this.mapVoucher(row);
    }

    // -- redeem -------------------------------------------------------------

    /**
     * ATOMICKÉ čerpání -- jediná legitimní cesta ke snížení zůstatku.
     *
     * Sled kroků je závazný (viz KRITICKÉ v hlavičce). Podmínky platnosti
     * (§8) jsou V WHERE, ne před UPDATE: předsazená kontrola otevírá TOCTOU
     * okno mezi kontrolou a zápisem.
     *
     * `WHERE version = ?` použije primární klíč, takže dotaz je index-only
     * lookup -- D1 je single-threaded a pomalý dotaz v čerpací cestě je
     * propustnost celého tenanta, ne jen jedné objednávky.
     */
    async redeem(context: TenantContext, params: RedeemCreditVoucherParams): Promise<RedeemOutcome> {
        assertTenantOwnership(
            context,
            { tenantId: params.tenantId },
            'CreditVoucher',
            params.voucherId
        );
        assertPositiveAmount(params.amount, 'redeem');

        const amountMinor = moneyToMinor(params.amount);

        // Snapshot POUZE kvůli měně a kvůli tomu, aby mutace nad neexistující
        // entitou byla throw (kontrakt: to je programátorská chyba volajícího,
        // ne business zamítnutí). Podmínky platnosti se z něj NEODVOZUJÍ.
        const snapshot = await this.requireOwnedRow(context, params.tenantId, params.voucherId);
        assertSameCurrency(snapshot.currency, params.amount.currency, 'redeem');

        // RYCHLÁ CESTA idempotence dvojího webhooku. Index `uq_voucher_redemption`
        // je pojistka pro souběh; tenhle SELECT ušetří zbytečný odečet
        // a následnou kompenzaci v naprosté většině opakovaných doručení.
        const alreadyRedeemed = await this.findRedemptionTransactionId(
            params.tenantId,
            params.voucherId,
            params.orderId
        );
        if (alreadyRedeemed !== undefined) {
            return { outcome: 'ALREADY_REDEEMED', transactionId: alreadyRedeemed };
        }

        // KROK 1 -- odečet. SAMOSTATNĚ, nikdy v `batch()` s INSERTem.
        // `status` se překlápí TÝMŽ UPDATE (invariant 4: `currentBalance === 0`
        // <=> `status === 'DEPLETED'`), ne druhým příkazem, který by mohl
        // neproběhnout.
        let changes: number;
        try {
            const result = await this.db
                .prepare(
                    `UPDATE vouchers
                        SET current_balance_minor = current_balance_minor - ?3,
                            version = version + 1,
                            status = CASE WHEN current_balance_minor - ?3 = 0
                                          THEN 'DEPLETED' ELSE status END
                      WHERE tenant_id = ?1
                        AND id = ?2
                        AND version = ?4
                        AND status = 'ACTIVE'
                        AND current_balance_minor >= ?3
                        AND expires_at > ?5`
                )
                .bind(
                    params.tenantId,
                    params.voucherId,
                    amountMinor,
                    params.expectedVersion,
                    // `now` jako VSTUP, ne `datetime('now')`: determinismus
                    // a testovatelnost. ISO 8601 se řadí lexikograficky správně,
                    // takže porovnání funguje bez konverze.
                    params.now
                )
                .run();
            changes = result.meta.changes;
        } catch (error) {
            throw new VoucherStorageError(
                'redeem',
                `Failed to debit voucher balance: ${errorMessage(error)}`,
                error
            );
        }

        // KROK 2 -- `changes === 1` je JEDINÝ důkaz úspěchu (§7).
        if (changes !== 1) {
            // `changes === 0` je NEJEDNOZNAČNÉ (version konflikt / podmínka
            // platnosti / nedostatečný zůstatek). Kontrakt vyžaduje důvod
            // ROZLIŠIT dočtením čerstvého řádku, ne vrátit jedno tupé `false`.
            return await this.classifyRedeemFailure(params, amountMinor);
        }

        // KROK 3 -- transakční záznam AŽ TEĎ, po prokázaném odečtu.
        try {
            const transaction = await this.insertTransaction({
                voucherId: params.voucherId,
                tenantId: params.tenantId,
                type: 'REDEEMED',
                amountMinor,
                currency: params.amount.currency,
                orderId: params.orderId,
                createdAt: params.now,
                operation: 'redeem',
            });

            return {
                outcome: 'REDEEMED',
                newBalance: minorToMoney(snapshot.current_balance_minor - amountMinor, snapshot.currency),
                newVersion: params.expectedVersion + 1,
                transactionId: transaction.id,
            };
        } catch (error) {
            const message = errorMessage(error instanceof VoucherStorageError ? error.cause : error);

            if (isUniqueConstraintViolation(message)) {
                // KROK 4 -- KOMPENZACE. `uq_voucher_redemption` znamená, že
                // týž webhook už jednou proběhl; odečet z KROKU 1 je ale
                // SKUTEČNÝ a bez vrácení by opakované doručení ukrojilo kredit
                // podruhé, přestože transakce je v historii jen jednou.
                // Jediná situace, kdy je kompenzace povinná.
                await this.compensateRedemption(params, amountMinor);

                const existingId = await this.findRedemptionTransactionId(
                    params.tenantId,
                    params.voucherId,
                    params.orderId
                );
                if (existingId === undefined) {
                    // Constraint hlásil duplicitu, ale záznam nikde -- rozpor,
                    // který se NESMÍ vydávat za úspěch (volající by objednávku
                    // pustil jako zaplacenou). Kompenzace proběhla, takže
                    // zůstatek je konzistentní; nahoru jde chyba.
                    throw new VoucherStorageError(
                        'redeem',
                        `UNIQUE violation on redemption of voucher "${params.voucherId}" for order ` +
                            `"${params.orderId}", but no REDEEMED transaction exists -- debit compensated`
                    );
                }
                return { outcome: 'ALREADY_REDEEMED', transactionId: existingId };
            }

            // Jiná chyba INSERTu: kredit JE odečtený, záznam chybí. Vědomě
            // zvolený směr chyby (viz hlavička) -- odchytí reconciliace podle
            // rozpadlého invariantu. NEKOMPENZUJE se: nevíme, jestli INSERT
            // neprošel částečně, a slepé vrácení by při úspěšném zápisu
            // vyrobilo kredit z ničeho.
            throw new VoucherStorageError(
                'redeem',
                `Voucher "${params.voucherId}" was debited by ${amountMinor} minor units but the ` +
                    `REDEEMED transaction failed to write: ${message}. RECONCILIATION REQUIRED.`,
                error
            );
        }
    }

    // -- refund -------------------------------------------------------------

    /**
     * PROTIPOHYB k `redeem()`. Historie je append-only -- oprava se NIKDY
     * nedělá editací ani smazáním `REDEEMED` záznamu.
     *
     * Stejný atomický kontrakt (UPDATE -> `changes === 1` -> INSERT), jen
     * opačným směrem. Rozdíly proti čerpání:
     *   - strop `initial_balance_minor` v WHERE (`ck_vouchers_balance_within_initial`):
     *     vrátit víc, než bylo vyčerpáno, je vytvoření peněz z ničeho,
     *   - `DEPLETED -> ACTIVE` týmž UPDATE (DEPLETED není terminální),
     *   - `EXPIRED` / `CANCELLED` jsou terminální -- refundovat na ně nelze,
     *   - KOMPENZACE SE NEKONÁ: `REFUNDED` nemá unique index (na jednu
     *     objednávku může být víc částečných vrácení), takže situace
     *     "UPDATE prošel, INSERT spadl na duplicitě" tu neexistuje.
     */
    async refund(context: TenantContext, params: RefundCreditVoucherParams): Promise<RefundOutcome> {
        assertTenantOwnership(
            context,
            { tenantId: params.tenantId },
            'CreditVoucher',
            params.voucherId
        );
        assertPositiveAmount(params.amount, 'refund');

        const amountMinor = moneyToMinor(params.amount);
        const snapshot = await this.requireOwnedRow(context, params.tenantId, params.voucherId);
        assertSameCurrency(snapshot.currency, params.amount.currency, 'refund');

        // Není co vracet, když se z téhle objednávky nikdy nečerpalo.
        // Bez téhle kontroly by refundace byla generátorem kreditu.
        //
        // Tohle je JEDINÁ podmínka vyhodnocená před UPDATE a je to bezpečné:
        // historie je append-only, takže existující REDEEMED záznam nemůže
        // mezitím zmizet. TOCTOU riziko by bylo opačné ("mezitím přibyl"),
        // a to znamená jen zbytečné zamítnutí, ne dvojí vrácení kreditu.
        const redeemedId = await this.findRedemptionTransactionId(
            params.tenantId,
            params.voucherId,
            params.orderId
        );
        if (redeemedId === undefined) {
            return { outcome: 'NOTHING_TO_REFUND' };
        }

        let changes: number;
        try {
            const result = await this.db
                .prepare(
                    `UPDATE vouchers
                        SET current_balance_minor = current_balance_minor + ?3,
                            version = version + 1,
                            status = CASE WHEN status = 'DEPLETED' AND current_balance_minor + ?3 > 0
                                          THEN 'ACTIVE' ELSE status END
                      WHERE tenant_id = ?1
                        AND id = ?2
                        AND version = ?4
                        AND status IN ('ACTIVE', 'DEPLETED')
                        AND current_balance_minor + ?3 <= initial_balance_minor`
                )
                .bind(params.tenantId, params.voucherId, amountMinor, params.expectedVersion)
                .run();
            changes = result.meta.changes;
        } catch (error) {
            throw new VoucherStorageError(
                'refund',
                `Failed to credit voucher balance: ${errorMessage(error)}`,
                error
            );
        }

        if (changes !== 1) {
            return await this.classifyRefundFailure(params, amountMinor);
        }

        const newBalanceMinor = snapshot.current_balance_minor + amountMinor;
        const reactivated = snapshot.status === 'DEPLETED' && newBalanceMinor > 0;

        try {
            const transaction = await this.insertTransaction({
                voucherId: params.voucherId,
                tenantId: params.tenantId,
                type: 'REFUNDED',
                amountMinor,
                currency: params.amount.currency,
                orderId: params.orderId,
                createdAt: params.now,
                operation: 'refund',
            });

            return {
                outcome: 'REFUNDED',
                newBalance: minorToMoney(newBalanceMinor, snapshot.currency),
                newVersion: params.expectedVersion + 1,
                transactionId: transaction.id,
                reactivated,
            };
        } catch (error) {
            // Kredit JE připsaný, záznam chybí -- opačný, MÍRNĚJŠÍ směr chyby
            // než u čerpání (zákazník má kredit navíc, ne obchod ztrátu),
            // ale pořád rozpad reconciliačního invariantu. Alert, ne ticho.
            throw new VoucherStorageError(
                'refund',
                `Voucher "${params.voucherId}" was credited by ${amountMinor} minor units but the ` +
                    `REFUNDED transaction failed to write: ${errorMessage(error)}. RECONCILIATION REQUIRED.`,
                error
            );
        }
    }

    // -- listTransactions ---------------------------------------------------

    /**
     * Finanční historie poukazu, vzestupně dle `created_at` (index
     * `idx_vtx_voucher`). Zdroj pro reconciliační invariant.
     *
     * `id` jako sekundární řadicí klíč: `created_at` je TEXT se sekundovým
     * rozlišením (`datetime('now')`), takže dva pohyby v téže sekundě by
     * jinak měly nedeterministické pořadí. AUTOINCREMENT je monotónní, takže
     * dorovnává, co čas nerozliší.
     *
     * Filtr přes tenant I voucher -- cizí tenant dostane prázdný seznam,
     * ne cizí historii a ne chybu.
     */
    async listTransactions(
        tenantId: TenantId,
        voucherId: EntityId
    ): Promise<readonly CreditVoucherTransaction[]> {
        try {
            const result = await this.db
                .prepare(
                    `SELECT id, voucher_id, tenant_id, type, amount_minor, currency,
                            order_id, created_at
                       FROM voucher_transactions
                      WHERE voucher_id = ?1 AND tenant_id = ?2
                      ORDER BY created_at ASC, id ASC`
                )
                .bind(voucherId, tenantId)
                .all<TransactionRow>();

            return result.results.map((row) => this.mapTransaction(row));
        } catch (error) {
            throw new VoucherStorageError(
                'listTransactions',
                `Failed to read voucher transactions: ${errorMessage(error)}`,
                error
            );
        }
    }

    // -- interní: čtení -----------------------------------------------------

    private async readVoucherRow(
        tenantId: TenantId,
        voucherId: EntityId
    ): Promise<VoucherRow | null> {
        try {
            return await this.db
                .prepare(
                    `SELECT ${VOUCHER_COLUMNS}
                       FROM vouchers
                      WHERE tenant_id = ?1 AND id = ?2`
                )
                .bind(tenantId, voucherId)
                .first<VoucherRow>();
        } catch (error) {
            throw new VoucherStorageError(
                'readVoucher',
                `Failed to read voucher: ${errorMessage(error)}`,
                error
            );
        }
    }

    private async readBySourceOrder(
        tenantId: TenantId,
        sourceOrderId: EntityId
    ): Promise<CreditVoucher | undefined> {
        try {
            const row = await this.db
                .prepare(
                    `SELECT ${VOUCHER_COLUMNS}
                       FROM vouchers
                      WHERE tenant_id = ?1 AND source_order_id = ?2`
                )
                .bind(tenantId, sourceOrderId)
                .first<VoucherRow>();
            return row === null ? undefined : this.mapVoucher(row);
        } catch (error) {
            throw new VoucherStorageError(
                'issue',
                `Failed to read voucher by source order: ${errorMessage(error)}`,
                error
            );
        }
    }

    /**
     * Načte řádek a ověří vlastnictví. Neexistující poukaz je throw, ne
     * `outcome`: mutace nad neexistující entitou je programátorská chyba
     * volajícího (nepředcházel `findByCode`), ne business zamítnutí.
     *
     * Dvojí `assertTenantOwnership` je záměrné: `params.tenantId` proti
     * kontextu (volající si nesmí sám určit tenanta) i řádek proti kontextu.
     */
    private async requireOwnedRow(
        context: TenantContext,
        tenantId: TenantId,
        voucherId: EntityId
    ): Promise<VoucherRow> {
        const row = await this.readVoucherRow(tenantId, voucherId);
        if (row === null) {
            throw new Error(`CreditVoucher "${voucherId}" not found`);
        }
        assertTenantOwnership(context, { tenantId: row.tenant_id }, 'CreditVoucher', voucherId);
        return row;
    }

    /** `uq_voucher_redemption` -- ID existující REDEEMED transakce, nebo `undefined`. */
    private async findRedemptionTransactionId(
        tenantId: TenantId,
        voucherId: EntityId,
        orderId: EntityId
    ): Promise<EntityId | undefined> {
        try {
            const row = await this.db
                .prepare(
                    `SELECT id
                       FROM voucher_transactions
                      WHERE tenant_id = ?1
                        AND voucher_id = ?2
                        AND order_id = ?3
                        AND type = 'REDEEMED'
                      LIMIT 1`
                )
                .bind(tenantId, voucherId, orderId)
                .first<{ id: number }>();
            return row === null ? undefined : String(row.id);
        } catch (error) {
            throw new VoucherStorageError(
                'findRedemption',
                `Failed to look up existing redemption: ${errorMessage(error)}`,
                error
            );
        }
    }

    // -- interní: zápis -----------------------------------------------------

    private async insertTransaction(args: {
        voucherId: EntityId;
        tenantId: TenantId;
        type: CreditVoucherTransactionType;
        amountMinor: number;
        currency: string;
        orderId: EntityId | null;
        createdAt: ISODateTime;
        operation: string;
    }): Promise<CreditVoucherTransaction> {
        // `type` NEJDE jako bind parametr do `VALUES`, protože je součástí
        // kontroly `ck_vtx_order_id_presence` a čitelnost SQL je tu důležitá;
        // hodnota pochází z uzavřeného doménového výčtu, ne z uživatelského
        // vstupu, takže injection riziko neexistuje. Všechno ostatní je bind.
        const result = await this.db
            .prepare(
                `INSERT INTO voucher_transactions
                     (voucher_id, tenant_id, type, amount_minor, currency, order_id, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
            )
            .bind(
                args.voucherId,
                args.tenantId,
                args.type,
                args.amountMinor,
                args.currency,
                args.orderId,
                args.createdAt
            )
            .run();

        // `id` je INTEGER PRIMARY KEY AUTOINCREMENT; `EntityId` je string,
        // takže mapper vyrábí string i tady.
        return {
            id: String(result.meta.last_row_id),
            tenantId: args.tenantId,
            createdAt: args.createdAt,
            updatedAt: args.createdAt,
            creditVoucherId: args.voucherId,
            type: args.type,
            amount: minorToMoney(args.amountMinor, args.currency),
            ...(args.orderId !== null ? { orderId: args.orderId } : {}),
        };
    }

    /**
     * KOMPENZACE odečtu z KROKU 1 po unique violation na INSERTu.
     *
     * Bez `WHERE version = ?`: kompenzuje se BEZPODMÍNEČNĚ, protože odečet
     * prokazatelně proběhl a musí se vrátit i tehdy, když mezitím někdo
     * jiný verzí pohnul. `current_balance_minor + ?3 <= initial_balance_minor`
     * je jediná pojistka -- `ck_vouchers_balance_within_initial` by přetečení
     * stejně zamítl, ale jako SQL chybu, a ta by zamaskovala původní příčinu.
     *
     * `changes !== 1` se NEHÁZÍ jako chyba: kompenzace, která neprošla, je
     * finanční rozpor k dořešení reconciliací, ale výjimka odsud by přepsala
     * výsledek `ALREADY_REDEEMED` (idempotentní replay, pro volajícího ÚSPĚCH)
     * na selhání a webhook by se retryoval donekonečna. Rozpor jde nahoru
     * jako `VoucherStorageError` jen tehdy, když nesedí ani transakční záznam.
     */
    private async compensateRedemption(
        params: RedeemCreditVoucherParams,
        amountMinor: number
    ): Promise<void> {
        try {
            await this.db
                .prepare(
                    `UPDATE vouchers
                        SET current_balance_minor = current_balance_minor + ?3,
                            version = version + 1,
                            status = CASE WHEN status = 'DEPLETED' THEN 'ACTIVE' ELSE status END
                      WHERE tenant_id = ?1
                        AND id = ?2
                        AND current_balance_minor + ?3 <= initial_balance_minor`
                )
                .bind(params.tenantId, params.voucherId, amountMinor)
                .run();
        } catch (error) {
            // Kompenzace selhala -> kredit je odečtený dvakrát za jednu
            // objednávku. To je nejzávažnější možný stav a MUSÍ jít nahoru.
            throw new VoucherStorageError(
                'redeem',
                `Failed to compensate debit of ${amountMinor} minor units on voucher ` +
                    `"${params.voucherId}" after duplicate redemption of order "${params.orderId}": ` +
                    `${errorMessage(error)}. RECONCILIATION REQUIRED.`,
                error
            );
        }
    }

    // -- interní: klasifikace `changes === 0` -------------------------------

    /**
     * Rozliší, PROČ čerpací UPDATE nezměnil žádný řádek.
     *
     * Pořadí je záměrné a kopíruje in-memory referenci: verze se vyhodnocuje
     * PŘED podmínkami platnosti, protože při konfliktu je jakýkoli jiný důvod
     * odvozený ze zastaralého snapshotu volajícího.
     */
    private async classifyRedeemFailure(
        params: RedeemCreditVoucherParams,
        amountMinor: number
    ): Promise<RedeemOutcome> {
        const fresh = await this.readVoucherRow(params.tenantId, params.voucherId);
        if (fresh === null) {
            // Poukaz mezi snapshotem a UPDATE zmizel. Tabulka nemá DELETE
            // cestu, takže tohle znamená ruční zásah -- programátorská /
            // provozní chyba, ne business zamítnutí.
            throw new VoucherStorageError(
                'redeem',
                `CreditVoucher "${params.voucherId}" disappeared during redemption`
            );
        }

        if (fresh.version !== params.expectedVersion) {
            return { outcome: 'VERSION_CONFLICT', actualVersion: fresh.version };
        }

        const reason = this.evaluateRedeemability(fresh, params.now);
        if (reason !== undefined) {
            return { outcome: 'NOT_REDEEMABLE', reason };
        }

        if (fresh.current_balance_minor < amountMinor) {
            return {
                outcome: 'INSUFFICIENT_BALANCE',
                currentBalance: minorToMoney(fresh.current_balance_minor, fresh.currency),
            };
        }

        // Verze sedí, platnost sedí, zůstatek stačí -- a přesto UPDATE
        // nematchnul. To je rozpor mezi WHERE klauzulí a touhle klasifikací,
        // tj. bug, který se NESMÍ zamaskovat vrácením libovolného `outcome`:
        // volající by ho vyhodnotil jako business zamítnutí a nikdo by se
        // nedozvěděl, že se čerpání rozbilo.
        throw new VoucherStorageError(
            'redeem',
            `Redemption UPDATE matched no row on voucher "${params.voucherId}" but the fresh row ` +
                `satisfies every WHERE condition -- WHERE clause and classifier disagree`
        );
    }

    private async classifyRefundFailure(
        params: RefundCreditVoucherParams,
        amountMinor: number
    ): Promise<RefundOutcome> {
        const fresh = await this.readVoucherRow(params.tenantId, params.voucherId);
        if (fresh === null) {
            throw new VoucherStorageError(
                'refund',
                `CreditVoucher "${params.voucherId}" disappeared during refund`
            );
        }

        if (fresh.version !== params.expectedVersion) {
            return { outcome: 'VERSION_CONFLICT', actualVersion: fresh.version };
        }

        // Terminální stavy: z EXPIRED ani CANCELLED nevede cesta zpět
        // (CREDIT_VOUCHER_LIFECYCLE_DEFINITION). Prodloužení = nový poukaz.
        if (fresh.status === 'EXPIRED' || fresh.status === 'CANCELLED') {
            return { outcome: 'NOT_REFUNDABLE', reason: fresh.status };
        }

        if (fresh.current_balance_minor + amountMinor > fresh.initial_balance_minor) {
            return {
                outcome: 'EXCEEDS_INITIAL_BALANCE',
                currentBalance: minorToMoney(fresh.current_balance_minor, fresh.currency),
            };
        }

        throw new VoucherStorageError(
            'refund',
            `Refund UPDATE matched no row on voucher "${params.voucherId}" but the fresh row ` +
                `satisfies every WHERE condition -- WHERE clause and classifier disagree`
        );
    }

    /**
     * In-memory ekvivalent podmínek platnosti §8 -- POUZE pro klasifikaci
     * PO neúspěšném UPDATE, NIKDY jako obrana před ním (TOCTOU).
     *
     * Pořadí nese nejvíc informace pro zákazníka i podporu. `undefined`
     * = uplatnitelný.
     */
    private evaluateRedeemability(
        row: VoucherRow,
        now: ISODateTime
    ): NotRedeemableReason | undefined {
        if (row.status === 'CANCELLED') {
            return 'CANCELLED';
        }
        if (row.status === 'EXPIRED') {
            return 'EXPIRED';
        }

        // `expires_at > NOW()` -- ostrá nerovnost, přesně jako v SQL WHERE.
        const expiresMs = Date.parse(row.expires_at);
        const nowMs = Date.parse(now);
        if (Number.isNaN(expiresMs) || Number.isNaN(nowMs) || expiresMs <= nowMs) {
            // Nerozparsovatelný čas končí stejně jako uplynulý: FAIL-CLOSED.
            // Nečitelný timestamp se NIKDY nevyhodnotí jako platný.
            return 'EXPIRED';
        }

        // Poukaz může být DEPLETED (stav), nebo ACTIVE s nulou (rozjeté stavy,
        // OPEN QUESTION 3) -- z pohledu čerpání je to totéž.
        if (row.current_balance_minor <= 0) {
            return 'DEPLETED';
        }
        if (row.status !== 'ACTIVE') {
            return 'NOT_ACTIVE';
        }
        return undefined;
    }

    // -- interní: mapování --------------------------------------------------

    private mapVoucher(row: VoucherRow): CreditVoucher {
        return {
            id: row.id,
            tenantId: row.tenant_id,
            createdAt: row.created_at,
            // Schéma 0001 sloupec `updated_at` nemá -- viz VOUCHER_COLUMNS.
            updatedAt: row.updated_at ?? row.created_at,
            initialBalance: minorToMoney(row.initial_balance_minor, row.currency),
            currentBalance: minorToMoney(row.current_balance_minor, row.currency),
            expiresAt: row.expires_at,
            sourceOrderId: row.source_order_id,
            customerEmail: row.customer_email,
            status: toLifecycleState(row.status, row.id),
            version: row.version,
        };
    }

    private mapTransaction(row: TransactionRow): CreditVoucherTransaction {
        return {
            id: String(row.id),
            tenantId: row.tenant_id,
            createdAt: row.created_at,
            // Transakce je append-only a nikdy se nemění -- `updatedAt` je
            // z definice rovné `createdAt`, sloupec by byl mrtvý.
            updatedAt: row.created_at,
            creditVoucherId: row.voucher_id,
            type: toTransactionType(row.type, row.id),
            amount: minorToMoney(row.amount_minor, row.currency),
            ...(row.order_id !== null ? { orderId: row.order_id } : {}),
        };
    }
}
