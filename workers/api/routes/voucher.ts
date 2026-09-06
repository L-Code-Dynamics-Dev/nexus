// Voucher endpointy -- Worker vrstva, Fáze B
// (docs/design-proposals/Digital-Voucher.md §6, §6.1, §6.2, ROZHODNUTO Lucky 2026-09-06).
//
//   GET  /api/vouchers/validate?code=...   -- §6.1, vrací zůstatek + HMAC token
//   POST /api/vouchers/redeem              -- §6.2, order webhook s PŘEPOČTEM
//
// ============================================================================
// CO TENHLE SOUBOR NEDĚLÁ -- HRANICE VRSTEV (§12)
// ============================================================================
// Worker NEOBSAHUJE business logiku výpočtu. `min(zůstatek, hodnota košíku)`
// z §6.1 se tady NEPOČÍTÁ -- počítá ho `CreditVoucherRedemptionRule`
// v `domains/voucher/`. Worker je I/O a bezpečnostní obálka:
//
//   HTTP  ->  validace vstupu  ->  čtení D1  ->  RULE (čistá funkce)
//         ->  HMAC / nonce / TTL  ->  atomický zápis D1  ->  HTTP
//
// Rule je podle `core/canonical/rules/Rule.ts` DETERMINISTICKÁ a bez I/O:
// dostane snapshot z D1 a `now` jako VSTUP, vrátí rozhodnutí. Kdyby výpočet
// skončil tady, nešel by otestovat bez Workeru a §12 hranice by se rozmazala.
//
// ŽÁDNÝ import z `domains/pricing/` -- ani nepřímo (§12: voucher je platební
// vrstva ZA hotovým součtem košíku, nikdy sleva v Pricing Engine).
//
// ============================================================================
// PENÍZE NA HRANICI VRSTEV
// ============================================================================
// D1 drží haléře jako INTEGER (migrations/0001_credit_voucher.sql, ODCHYLKA:
// REAL je IEEE-754 float a na penězích se rozejde s reconciliačním
// invariantem). Rule pracuje s `Money{Decimal}` dle
// core/canonical/entities/base.ts. Převod je JEN v `minorToMoney` /
// `moneyToMinor` níže -- nikde jinde v tomhle souboru se peníze nepřevádějí
// a nikde se nepočítá s `number` jinak než v celých haléřích.

import Decimal from 'decimal.js';

import {
    computeCartFingerprint,
    generateNonce,
    isTimestampFresh,
    signVoucherToken,
    verifyVoucherToken,
    type VoucherTokenPayload,
} from '../hmac.js';
import { ApiError, jsonResponse, log, redactToken, redactVoucherCode } from '../http.js';
import type { D1Database, Env, NonceStore } from '../types.js';

// Kontrakt z `domains/voucher/CreditVoucherRedemptionRule.ts` (§6).
import {
    CreditVoucherRedemptionRule,
    type CreditVoucherRedemptionRuleInput,
    type CreditVoucherRedemptionRuleResult,
} from '../../../domains/voucher/CreditVoucherRedemptionRule.js';
import type { Money } from '../../../core/canonical/entities/base.js';

// ---------------------------------------------------------------------------
// Konfigurace
// ---------------------------------------------------------------------------

/**
 * TTL tokenu. §6.2: "Token je krátkodobý (řádově minuty)". 5 minut pokrývá
 * cestu košík -> checkout; delší okno zvětšuje prostor pro přehrání.
 */
const TOKEN_MAX_AGE_SECONDS = 300;

/** Nonce se drží déle než token -- jinak by po expiraci šel replay znovu. */
const NONCE_TTL_SECONDS = TOKEN_MAX_AGE_SECONDS * 4;

/**
 * Tolerance přepočtu (§6.2 bod 3: "nad toleranci zaokrouhlení -> HOLD").
 * 1 haléř. Není to benevolence k rozdílu, je to prostor pro poslední
 * zaokrouhlení v Shoptetu -- větší nesoulad je manipulace nebo chyba.
 */
const AMOUNT_TOLERANCE_MINOR = 1;

/** §7: retry má KONEČNÝ počet pokusů, pak zamítnutí do auditu. */
const MAX_REDEMPTION_ATTEMPTS = 3;

/** Formát kódu `NEXUS-XXXX-XXXX-RRRR` (§4, 8 znaků bez zaměnitelných 0/O/1/I/L). */
const VOUCHER_CODE_PATTERN = /^NEXUS-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-\d{4}$/;

// ---------------------------------------------------------------------------
// D1 řádky
// ---------------------------------------------------------------------------

/** Řádek `vouchers` dle migrations/0001_credit_voucher.sql. Peníze v haléřích. */
interface VoucherRow {
    readonly id: string;
    readonly tenant_id: string;
    readonly initial_balance_minor: number;
    readonly current_balance_minor: number;
    readonly currency: string;
    readonly created_at: string;
    readonly expires_at: string;
    readonly status: string;
    readonly version: number;
}

// ---------------------------------------------------------------------------
// GET /api/vouchers/validate  (§6.1)
// ---------------------------------------------------------------------------

/**
 * Odpověď dle §6.1 -- tvar je KONTRAKT s frontend injection vrstvou,
 * měnit ho znamená měnit Shoptet šablonu.
 *
 * BEZPEČNOST: endpoint prozrazuje zůstatek platidla komukoli, kdo uhodne
 * kód. §4 proto předepisuje rate limit per IP i globálně + audit
 * neúspěšných pokusů. Rate limit je v PoC v Durable Object
 * (`SecurityCoordinator` / `/rate-limit`) a patří sem STEJNOU cestou jako
 * nonce store -- viz `NonceStore` kontrakt v types.ts. Do doplnění DO
 * bindingu je jedinou obranou entropie 8 znaků (~6,6x10^11).
 */
interface ValidateResponse {
    readonly valid: boolean;
    readonly balance: number;
    readonly currency: string;
    readonly expiresAt: string;
    readonly applicable: number;
    readonly token?: string;
    readonly reason?: string;
    readonly reasonCode?: string;
}

export async function handleValidate(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const tenantId = requireTenantId(url.searchParams.get('tenant'));
    const cartTotalMinor = parseMinorAmount(url.searchParams.get('cartTotal'), 'cartTotal');
    const cartFingerprint = requireCartFingerprint(url.searchParams.get('cartFingerprint'));

    if (!isWellFormedVoucherCode(code)) {
        // Nevalidní FORMÁT se nedostane do DB vůbec -- šetří to D1 dotazy
        // při hrubé síle a odpověď je nerozlišitelná od "neexistuje",
        // takže se z ní nedá odvodit, které kódy jsou "skoro správné".
        log('warn', 'voucher.validate.malformed_code', {
            tenantId,
            code: redactVoucherCode(code),
        });
        return jsonResponse(invalidResponse('MALFORMED_CODE', 'Kód poukazu má neplatný formát.'), 200);
    }

    const row = await readVoucherRow(env.DB, tenantId, code);

    if (row === null) {
        log('warn', 'voucher.validate.not_found', { tenantId, code: redactVoucherCode(code) });
        // Stejná odpověď jako u neplatného formátu -- žádný oracle na existenci.
        return jsonResponse(invalidResponse('NOT_FOUND', 'Poukaz neexistuje nebo není platný.'), 200);
    }

    const nowIso = new Date().toISOString();

    // BUSINESS LOGIKA JE V RULE, NE TADY (§12). Worker jen předá snapshot.
    const decision = evaluateRedemption(
        {
            tenantId,
            voucherId: row.id,
            status: row.status,
            expiresAt: row.expires_at,
            currentBalanceMinor: row.current_balance_minor,
            currency: row.currency,
            cartTotalMinor,
            now: nowIso,
        },
        tenantId,
    );

    if (!decision.applicable || decision.applicableAmountMinor <= 0) {
        log('info', 'voucher.validate.not_applicable', {
            tenantId,
            code: redactVoucherCode(code),
            reasonCode: decision.reasonCode,
        });
        return jsonResponse(
            {
                valid: false,
                balance: row.current_balance_minor,
                currency: row.currency,
                expiresAt: row.expires_at,
                applicable: 0,
                reason: decision.reason,
                reasonCode: decision.reasonCode,
            } satisfies ValidateResponse,
            200,
        );
    }

    // §6.2 vrstva 1: podepsaný TOKEN, ne holá částka. Přepsat částku v DOM
    // lze, ale token pak nesedí -- a bez platného tokenu Worker neodečte nic.
    const payload: VoucherTokenPayload = {
        voucherId: row.id,
        amountMinor: decision.applicableAmountMinor,
        cartFingerprint,
        timestamp: Math.floor(Date.now() / 1000),
        nonce: generateNonce(),
    };

    const token = await signToken(payload, env.HMAC_SECRET);

    log('info', 'voucher.validate.ok', {
        tenantId,
        code: redactVoucherCode(code),
        applicableMinor: decision.applicableAmountMinor,
        balanceMinor: row.current_balance_minor,
    });

    return jsonResponse(
        {
            valid: true,
            balance: row.current_balance_minor,
            currency: row.currency,
            expiresAt: row.expires_at,
            applicable: decision.applicableAmountMinor,
            // Token nese payload i podpis -- frontend s ním nemanipuluje,
            // jen ho uloží do sessionStorage a připojí k objednávce (§6.1).
            token,
        } satisfies ValidateResponse,
        200,
    );
}

function invalidResponse(reasonCode: string, reason: string): ValidateResponse {
    return {
        valid: false,
        balance: 0,
        currency: 'CZK',
        expiresAt: '',
        applicable: 0,
        reason,
        reasonCode,
    };
}

// ---------------------------------------------------------------------------
// POST /api/vouchers/redeem  (§6.2)  -- ORDER WEBHOOK
// ---------------------------------------------------------------------------

/**
 * Položka objednávky, jak dorazí z webhooku. Worker si z NICH počítá
 * součet sám -- viz `RedeemRequest.claimedDiscountMinor`.
 */
interface OrderLineInput {
    readonly sku: string;
    readonly quantity: number;
    readonly unitPriceMinor: number;
    /** Řádek samotného voucher produktu (N x 1 Kč, §1) se do součtu NEPOČÍTÁ. */
    readonly isVoucherProduct?: boolean;
}

interface RedeemRequest {
    readonly tenantId: string;
    readonly orderId: string;
    readonly token: string;
    readonly lines: readonly OrderLineInput[];
    /**
     * Sleva, KTEROU TVRDÍ OBJEDNÁVKA. §6.2 bod 2: tahle hodnota se
     * NEPOUŽIJE k odečtu -- slouží VÝHRADNĚ k porovnání s přepočtem
     * a k detekci nesouladu (-> HOLD). Kdyby se z ní odečítalo, zákazník
     * si nastaví slevu na plnou hodnotu košíku a rozdíl platí e-shop.
     */
    readonly claimedDiscountMinor: number;
}

export async function handleRedeem(request: Request, env: Env): Promise<Response> {
    const body = await parseJsonBody(request);
    const input = validateRedeemRequest(body);

    // Token nese payload i podpis -- rozebere se AŽ TADY, ve Workeru.
    const { payload, signature } = decodeToken(input.token);

    // -----------------------------------------------------------------
    // 1. HMAC podpis (§6.2 vrstva 1). Bez platného podpisu se NEODEČÍTÁ.
    // -----------------------------------------------------------------
    const signatureValid = await verifyVoucherToken(payload, signature, env.HMAC_SECRET);
    if (!signatureValid) {
        log('error', 'voucher.redeem.reject_signature', {
            tenantId: input.tenantId,
            orderId: input.orderId,
            token: redactToken(input.token),
        });
        throw new ApiError('REJECT_SIGNATURE', 403, 'Podpis tokenu neodpovídá.');
    }

    // -----------------------------------------------------------------
    // 2. TTL s ochranou proti hodinám v budoucnosti. VZOR Z PoC:
    //    `if (age < -60 || age > MAX_AGE) -> REJECT_EXPIRED`.
    //    Bez záporné meze by token s posunutým timestampem platil věčně.
    // -----------------------------------------------------------------
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (!isTimestampFresh(payload.timestamp, nowSeconds, TOKEN_MAX_AGE_SECONDS)) {
        log('warn', 'voucher.redeem.reject_expired', {
            tenantId: input.tenantId,
            orderId: input.orderId,
            ageSeconds: nowSeconds - payload.timestamp,
        });
        throw new ApiError('REJECT_EXPIRED', 403, 'Token vypršel nebo má neplatný čas.');
    }

    // -----------------------------------------------------------------
    // 3. Cart fingerprint -- token je svázaný s KONKRÉTNÍM košíkem
    //    (§6.2: "Přehrání starého tokenu -> cart_fingerprint").
    //    Voucher produkt se do otisku nepočítá, stejně jako do součtu.
    // -----------------------------------------------------------------
    const payableLines = input.lines.filter((line) => line.isVoucherProduct !== true);
    const actualFingerprint = await computeCartFingerprint(payableLines);

    if (actualFingerprint !== payload.cartFingerprint) {
        log('error', 'voucher.redeem.fingerprint_mismatch', {
            tenantId: input.tenantId,
            orderId: input.orderId,
            voucherId: redactVoucherCode(payload.voucherId),
        });
        throw new ApiError('REJECT_REPLAY', 403, 'Token nepatří k obsahu této objednávky.');
    }

    // -----------------------------------------------------------------
    // 4. Nonce replay protection (§6.2). ATOMICKÁ rezervace, viz kontrakt
    //    `NonceStore` v types.ts.
    //
    //    ŽÁDNÝ FALLBACK. PoC má pro chybějící binding `CONFIG.MOCK_KV_STORE`
    //    (in-memory Map) -- pro platidlo se NEKOPÍRUJE: Map žije per-isolate,
    //    takže by na druhém isolate replay protection mlčky neexistovala.
    //    Chybí-li binding, request SELŽE. Tiché pokračování u peněz ne.
    // -----------------------------------------------------------------
    const nonceStore = resolveNonceStore(env);
    const reserved = await nonceStore.reserve(payload.nonce, NONCE_TTL_SECONDS);
    if (!reserved) {
        log('error', 'voucher.redeem.reject_replay', {
            tenantId: input.tenantId,
            orderId: input.orderId,
            voucherId: redactVoucherCode(payload.voucherId),
        });
        throw new ApiError('REJECT_REPLAY', 403, 'Token už byl použit.');
    }

    // -----------------------------------------------------------------
    // 5. §6.2 vrstva 2 -- WORKER SI ČÁSTKU PŘEPOČÍTÁ SÁM.
    //    Nepřebírá se `claimedDiscountMinor` z requestu. Načte se čerstvý
    //    stav z D1, sečtou se NEVOUCHER položky a Rule spočítá
    //    min(current_balance, součet) ZNOVU, z vlastních dat.
    // -----------------------------------------------------------------
    const row = await readVoucherRow(env.DB, input.tenantId, payload.voucherId);
    if (row === null) {
        log('error', 'voucher.redeem.voucher_not_found', {
            tenantId: input.tenantId,
            orderId: input.orderId,
            voucherId: redactVoucherCode(payload.voucherId),
        });
        throw new ApiError('VOUCHER_NOT_FOUND', 404, 'Poukaz neexistuje.');
    }

    const recomputedCartTotalMinor = sumLines(payableLines);
    const decision = evaluateRedemption(
        {
            tenantId: input.tenantId,
            voucherId: row.id,
            status: row.status,
            expiresAt: row.expires_at,
            currentBalanceMinor: row.current_balance_minor,
            currency: row.currency,
            cartTotalMinor: recomputedCartTotalMinor,
            now: new Date().toISOString(),
        },
        input.tenantId,
    );

    if (!decision.applicable || decision.applicableAmountMinor <= 0) {
        log('warn', 'voucher.redeem.not_applicable', {
            tenantId: input.tenantId,
            orderId: input.orderId,
            voucherId: redactVoucherCode(row.id),
            reasonCode: decision.reasonCode,
        });
        throw new ApiError(
            'VOUCHER_NOT_APPLICABLE',
            409,
            decision.reason ?? 'Poukaz nelze na tuto objednávku uplatnit.',
        );
    }

    // -----------------------------------------------------------------
    // 6. §6.2 vrstva 3 -- NESOULAD -> HOLD.
    //    Porovnává se PŘEPOČTENÁ částka proti tomu, co tvrdí objednávka
    //    A proti tomu, co nese podepsaný token. Rozejde-li se to nad
    //    toleranci zaokrouhlení: objednávka HOLD, KREDIT SE NEODEČTE,
    //    audit + alert. Rozhoduje člověk.
    // -----------------------------------------------------------------
    const recomputedMinor = decision.applicableAmountMinor;
    const claimedDelta = Math.abs(recomputedMinor - input.claimedDiscountMinor);
    const tokenDelta = Math.abs(recomputedMinor - payload.amountMinor);

    if (claimedDelta > AMOUNT_TOLERANCE_MINOR || tokenDelta > AMOUNT_TOLERANCE_MINOR) {
        // ALERT: `level: error` + `alert: true` je signál pro Workers Logs
        // filtr. Structured, aby se na tom dal postavit alarm bez dolování.
        log('error', 'voucher.redeem.hold_amount_mismatch', {
            alert: true,
            tenantId: input.tenantId,
            orderId: input.orderId,
            voucherId: redactVoucherCode(row.id),
            recomputedMinor,
            claimedMinor: input.claimedDiscountMinor,
            tokenAmountMinor: payload.amountMinor,
            toleranceMinor: AMOUNT_TOLERANCE_MINOR,
        });

        await writeHoldAudit(env.DB, {
            tenantId: input.tenantId,
            orderId: input.orderId,
            voucherId: row.id,
            recomputedMinor,
            claimedMinor: input.claimedDiscountMinor,
            tokenAmountMinor: payload.amountMinor,
        });

        // 409, ne 200: webhook odesílatel se MUSÍ dozvědět, že odečet neproběhl.
        throw new ApiError('HOLD', 409, 'Nesoulad částky -- objednávka je pozastavena k ručnímu posouzení.', {
            recomputedMinor,
            claimedMinor: input.claimedDiscountMinor,
        });
    }

    // -----------------------------------------------------------------
    // 7. Atomický odečet (§7). Optimistický zámek, DB je autorita.
    // -----------------------------------------------------------------
    const result = await consumeCredit(env.DB, {
        tenantId: input.tenantId,
        voucherId: row.id,
        orderId: input.orderId,
        amountMinor: recomputedMinor,
        currency: row.currency,
        expectedVersion: row.version,
    });

    if (!result.consumed) {
        log('error', 'voucher.redeem.conflict', {
            alert: true,
            tenantId: input.tenantId,
            orderId: input.orderId,
            voucherId: redactVoucherCode(row.id),
            attempts: result.attempts,
            reason: result.reason,
        });
        throw new ApiError('REDEMPTION_CONFLICT', 409, result.reason ?? 'Čerpání se nepodařilo dokončit.');
    }

    log('info', 'voucher.redeem.ok', {
        tenantId: input.tenantId,
        orderId: input.orderId,
        voucherId: redactVoucherCode(row.id),
        redeemedMinor: recomputedMinor,
        newBalanceMinor: result.newBalanceMinor,
        attempts: result.attempts,
    });

    return jsonResponse({
        ok: true,
        voucherId: row.id,
        redeemed: recomputedMinor,
        balance: result.newBalanceMinor,
        currency: row.currency,
    });
}

// ---------------------------------------------------------------------------
// Rule adaptér (§12 hranice)
// ---------------------------------------------------------------------------

interface RedemptionSnapshot {
    readonly tenantId: string;
    readonly voucherId: string;
    readonly status: string;
    readonly expiresAt: string;
    readonly currentBalanceMinor: number;
    readonly currency: string;
    readonly cartTotalMinor: number;
    readonly now: string;
}

/**
 * Jediné místo, kde Worker volá doménovou Rule. Rule je čistá funkce
 * (Rule.ts: "žádné skryté side effects uvnitř evaluate()"), takže sem
 * jde SNAPSHOT z D1 a `now` jako vstup -- ne D1 handle.
 *
 * Peníze: Rule pracuje s `Money{Decimal}` dle base.ts, D1 s haléři dle
 * migrace 0001. Převod dělá tenhle adaptér -- entita halíře nikdy nevidí,
 * Worker nikdy nevidí float.
 */
function evaluateRedemption(
    snapshot: RedemptionSnapshot,
    tenantId: string,
): { applicable: boolean; applicableAmountMinor: number; reason?: string; reasonCode?: string } {
    const rule = new CreditVoucherRedemptionRule({
        tenantId,
        ruleId: 'credit-voucher-redemption',
        ruleVersion: '1.0.0',
    });

    const input: CreditVoucherRedemptionRuleInput = {
        status: snapshot.status as CreditVoucherRedemptionRuleInput['status'],
        expiresAt: snapshot.expiresAt,
        currentBalance: minorToMoney(snapshot.currentBalanceMinor, snapshot.currency),
        cartTotal: minorToMoney(snapshot.cartTotalMinor, snapshot.currency),
        now: snapshot.now,
    };

    const result: CreditVoucherRedemptionRuleResult = rule.evaluate(input);

    return {
        applicable: result.allowed,
        applicableAmountMinor: moneyToMinor(result.redeemableAmount),
        reason: result.reason,
        reasonCode: result.reasonCode,
    };
}

/**
 * Haléře -> Money. `decimal.js` je runtime dependency (package.json,
 * ne devDependency), wrangler ho zabundluje do Workeru.
 */
function minorToMoney(minor: number, currency: string): Money {
    return { amount: new Decimal(minor).dividedBy(100), currency };
}

/**
 * Money -> haléře. `.times(100).toFixed(0)` a NE `Math.round(Number(...))`:
 * převod přes float by u velkých částek ztratil přesnost, kvůli které se
 * Decimal vůbec používá.
 *
 * `toFixed(0)` zaokrouhluje dle `Decimal.rounding` (default ROUND_HALF_UP).
 * Rule vrací `min(zůstatek, košík)` z hodnot, které vznikly dělením stem,
 * takže se sem prakticky vrací celé haléře -- zaokrouhlení je pojistka,
 * ne výpočet.
 */
function moneyToMinor(money: Money | undefined): number {
    if (money === undefined) {
        return 0;
    }
    return Number(money.amount.times(100).toFixed(0));
}

// ---------------------------------------------------------------------------
// D1 přístup -- try/catch na KAŽDÉM I/O (master rule: defenzivní programování)
// ---------------------------------------------------------------------------

async function readVoucherRow(
    db: D1Database,
    tenantId: string,
    voucherId: string,
): Promise<VoucherRow | null> {
    try {
        return await db
            .prepare(
                `SELECT id, tenant_id, initial_balance_minor, current_balance_minor,
                        currency, created_at, expires_at, status, version
                   FROM vouchers
                  WHERE tenant_id = ?1 AND id = ?2`,
            )
            .bind(tenantId, voucherId)
            .first<VoucherRow>();
    } catch (error) {
        log('error', 'voucher.d1.read_failed', {
            tenantId,
            voucherId: redactVoucherCode(voucherId),
            message: errorMessage(error),
        });
        // 503, ne 500: D1 výpadek je dočasný a webhook odesílatel má retryovat.
        throw new ApiError('STORAGE_UNAVAILABLE', 503, 'Databáze poukazů je dočasně nedostupná.');
    }
}

interface ConsumeInput {
    readonly tenantId: string;
    readonly voucherId: string;
    readonly orderId: string;
    readonly amountMinor: number;
    readonly currency: string;
    readonly expectedVersion: number;
}

interface ConsumeResult {
    readonly consumed: boolean;
    readonly newBalanceMinor: number;
    readonly attempts: number;
    readonly reason?: string;
}

/**
 * Atomické čerpání dle §7 -- optimistický zámek.
 *
 * §8: podmínky platnosti jsou V SQL WHERE KLAUZULI, ne v aplikačním kódu
 * před ní. Předsazená kontrola otevírá TOCTOU okno mezi kontrolou a zápisem.
 * `CreditVoucherRedemptionRule` výše slouží k ČITELNÉ HLÁŠCE, autorita je tady.
 *
 * KRITICKÉ -- UPDATE a INSERT NESMÍ JÍT JEDNÍM `batch()`:
 *   D1 `batch()` se rollbackuje POUZE při SQL chybě. `UPDATE ... WHERE
 *   version = ?`, který nematchne žádný řádek, SQL chyba NENÍ -- vrátí
 *   `meta.changes === 0` a batch normálně projde. V jednom batchi by tedy
 *   při konfliktu verze prošel INSERT transakce BEZ odečtu kreditu.
 *
 *   A je to horší než "jen" rozejitý invariant: ten INSERT zabere partial
 *   unique index (voucher_id, order_id), takže NÁSLEDNÝ RETRY spadne na
 *   constraintu a `isUniqueConstraintViolation` ho vyhodnotí jako
 *   "idempotentní replay" -> vrátí `consumed: true`. Objednávka projde
 *   jako zaplacená kreditem, který se nikdy neodečetl.
 *
 *   Pořadí je proto NEMĚNNÉ: UPDATE -> ověřit `meta.changes === 1` ->
 *   teprve INSERT. Zapsáno i v kontraktu `CreditVoucherStore`.
 *
 * DŮSLEDEK: mezi UPDATE a INSERT je okno, ve kterém může Worker umřít --
 * kredit odečten, transakce nezapsaná. To je vědomě zvolený SMĚR CHYBY:
 * chybějící záznam odchytí reconciliace (`core/reconciliation`) a řeší se
 * dohledáním, zatímco opačná varianta (záznam bez odečtu) tiše rozdává
 * zboží zdarma. Nikdy nepřehazovat pořadí "aby to bylo konzistentnější".
 *
 * IDEMPOTENCE: partial unique index `uq_voucher_redemption(voucher_id,
 * order_id) WHERE type='REDEEMED'` -- druhé doručení téhož webhooku shodí
 * INSERT na constraintu. Protože UPDATE už proběhl, musí se ten odečet
 * KOMPENZOVAT (viz obsluha violation níže), ne vrátit jako úspěch.
 */
async function consumeCredit(db: D1Database, input: ConsumeInput): Promise<ConsumeResult> {
    let expectedVersion = input.expectedVersion;

    for (let attempt = 1; attempt <= MAX_REDEMPTION_ATTEMPTS; attempt += 1) {
        try {
            // KROK 1 -- odečet. Samostatně, NIKDY v batchi s INSERTem
            // (viz hlavičkový komentář: nematchnutý UPDATE není SQL chyba,
            // takže by se batch nerollbackl a INSERT by prošel bez odečtu).
            const updateResult = await db
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
                        AND expires_at > datetime('now')`,
                )
                .bind(input.tenantId, input.voucherId, input.amountMinor, expectedVersion)
                .run();

            // §7: `meta.changes === 1` je JEDINÝ důkaz úspěchu.
            if (updateResult.meta.changes === 1) {
                // KROK 2 -- transakční záznam. Až TEĎ, když je jisté, že se
                // odečetlo. Selhání na unique indexu tady znamená, že týž
                // webhook už jednou proběhl -- ale odečet z KROKU 1 je
                // skutečný a musí se vrátit zpět, jinak by dvojí doručení
                // webhooku odečetlo kredit dvakrát.
                try {
                    await db
                        .prepare(
                            `INSERT INTO voucher_transactions
                                 (voucher_id, tenant_id, type, amount_minor, currency, order_id)
                             VALUES (?1, ?2, 'REDEEMED', ?3, ?4, ?5)`,
                        )
                        .bind(
                            input.voucherId,
                            input.tenantId,
                            input.amountMinor,
                            input.currency,
                            input.orderId,
                        )
                        .run();
                } catch (insertError) {
                    const insertMessage = errorMessage(insertError);
                    if (isUniqueConstraintViolation(insertMessage)) {
                        // KOMPENZACE odečtu z KROKU 1. Bez ní by opakovaný
                        // webhook ukrojil kredit podruhé, přestože transakce
                        // je v historii jen jednou.
                        await compensateRedemption(db, input);
                        log('info', 'voucher.redeem.idempotent_replay', {
                            tenantId: input.tenantId,
                            orderId: input.orderId,
                            voucherId: redactVoucherCode(input.voucherId),
                            compensated: true,
                        });
                        const fresh = await readVoucherRow(db, input.tenantId, input.voucherId);
                        return {
                            consumed: true,
                            newBalanceMinor: fresh?.current_balance_minor ?? 0,
                            attempts: attempt,
                        };
                    }
                    // Jiná chyba INSERTu: kredit JE odečtený, záznam chybí.
                    // Vědomě zvolený směr chyby (viz hlavička) -- odchytí
                    // reconciliace. Hlásí se jako alert, ne jako tichý stav.
                    log('error', 'voucher.redeem.transaction_write_failed', {
                        tenantId: input.tenantId,
                        orderId: input.orderId,
                        voucherId: redactVoucherCode(input.voucherId),
                        amountMinor: input.amountMinor,
                        message: insertMessage,
                        alert: true,
                    });
                    throw insertError;
                }

                const fresh = await readVoucherRow(db, input.tenantId, input.voucherId);
                return {
                    consumed: true,
                    newBalanceMinor: fresh?.current_balance_minor ?? 0,
                    attempts: attempt,
                };
            }

            // `changes === 0` -- konflikt NEBO nesplněná podmínka. §7 říká
            // výslovně: načti čerstvý stav a ROZLIŠ DŮVOD, neretryuj slepě.
            const fresh = await readVoucherRow(db, input.tenantId, input.voucherId);
            if (fresh === null) {
                return { consumed: false, newBalanceMinor: 0, attempts: attempt, reason: 'Poukaz zmizel.' };
            }

            const reason = classifyConflict(fresh, input.amountMinor);
            if (reason !== null) {
                // Trvalý důvod (expirace / nízký zůstatek / neaktivní) --
                // retry by ho nezměnil, jen by zdržel.
                return { consumed: false, newBalanceMinor: fresh.current_balance_minor, attempts: attempt, reason };
            }

            // Jen verze se rozešla -> souběžný zápis. Retry s čerstvou verzí.
            expectedVersion = fresh.version;
            log('warn', 'voucher.redeem.version_conflict', {
                tenantId: input.tenantId,
                voucherId: redactVoucherCode(input.voucherId),
                attempt,
                freshVersion: fresh.version,
            });

            // §7: exponenciální backoff.
            await sleep(2 ** (attempt - 1) * 25);
        } catch (error) {
            const message = errorMessage(error);

            // POZOR -- unique violation se ZDE VĚDOMĚ NEODCHYTÁVÁ jako úspěch.
            // Idempotenci dvojího webhooku řeší vnitřní catch kolem INSERTu
            // (KROK 2), který jediný ví, že odečet z KROKU 1 proběhl, a umí
            // ho zkompenzovat. Kdyby se violation vyhodnocovala i tady,
            // vrátil by se `consumed: true` bez důkazu, že se kredit skutečně
            // odečetl -- objednávka by prošla jako zaplacená kreditem, který
            // nikdo neodečetl. Sem doputují jen skutečné chyby úložiště.
            log('error', 'voucher.d1.consume_failed', {
                tenantId: input.tenantId,
                voucherId: redactVoucherCode(input.voucherId),
                attempt,
                message,
            });
            throw new ApiError('STORAGE_UNAVAILABLE', 503, 'Zápis čerpání selhal.');
        }
    }

    // §7: po vyčerpání pokusů se operace ZAMÍTNE a jde do auditu -- ne tichý neúspěch.
    return {
        consumed: false,
        newBalanceMinor: 0,
        attempts: MAX_REDEMPTION_ATTEMPTS,
        reason: `Čerpání se nepodařilo po ${MAX_REDEMPTION_ATTEMPTS} pokusech (souběh).`,
    };
}

/**
 * Vrátí zpět odečet z KROKU 1, když INSERT transakce spadl na partial unique
 * indexu -- tedy když týž webhook už jednou proběhl.
 *
 * PROČ TO MUSÍ EXISTOVAT: kroky jsou vědomě oddělené (nematchnutý UPDATE není
 * v D1 SQL chyba, takže `batch()` by transakci zapsal i bez odečtu -- viz
 * hlavička `consumeCredit`). Cenou za to je, že při opakovaném doručení
 * webhooku odečet z KROKU 1 SKUTEČNĚ PROBĚHNE, i když transakce už v historii
 * je. Bez téhle kompenzace by druhé doručení ukrojilo kredit podruhé.
 *
 * Kompenzace je záměrně BEZ optimistického zámku a bez zápisu transakce:
 *   - `version` se nekontroluje: vracíme přesně tolik, kolik jsme právě
 *     odečetli, a kdyby mezitím proběhlo jiné čerpání, `version` by seděla
 *     stejně málo jako `current_balance_minor` -- podmínka na horní mez
 *     (`<= initial`) je bezpečnější a nezacyklí se.
 *   - transakce se NEZAPISUJE: v historii nemá vzniknout ani REDEEMED (ten
 *     už tam je z prvního doručení), ani REFUNDED (žádná refundace se
 *     nestala). Reconciliační invariant tak zůstává v pořádku.
 *
 * Selhání kompenzace se NESMÍ propagovat jako chyba requestu -- webhook by
 * se retryoval a odečetl potřetí. Loguje se jako alert; rozdíl odchytí
 * reconciliace.
 */
async function compensateRedemption(db: D1Database, input: ConsumeInput): Promise<void> {
    try {
        const result = await db
            .prepare(
                `UPDATE vouchers
                    SET current_balance_minor = current_balance_minor + ?3,
                        version = version + 1,
                        status = CASE WHEN status = 'DEPLETED' THEN 'ACTIVE' ELSE status END
                  WHERE tenant_id = ?1
                    AND id = ?2
                    AND current_balance_minor + ?3 <= initial_balance_minor`,
            )
            .bind(input.tenantId, input.voucherId, input.amountMinor)
            .run();

        if (result.meta.changes !== 1) {
            log('error', 'voucher.redeem.compensation_missed', {
                tenantId: input.tenantId,
                orderId: input.orderId,
                voucherId: redactVoucherCode(input.voucherId),
                amountMinor: input.amountMinor,
                alert: true,
            });
        }
    } catch (error) {
        log('error', 'voucher.redeem.compensation_failed', {
            tenantId: input.tenantId,
            orderId: input.orderId,
            voucherId: redactVoucherCode(input.voucherId),
            amountMinor: input.amountMinor,
            message: errorMessage(error),
            alert: true,
        });
    }
}

/** Rozliší TRVALÝ důvod od pouhého version konfliktu. `null` = jen verze. */
function classifyConflict(row: VoucherRow, amountMinor: number): string | null {
    if (row.status !== 'ACTIVE') {
        return `Poukaz není aktivní (stav "${row.status}").`;
    }
    if (Date.parse(row.expires_at) <= Date.now()) {
        return `Platnost poukazu vypršela ${row.expires_at}.`;
    }
    if (row.current_balance_minor < amountMinor) {
        return 'Zůstatek poukazu nestačí (mezitím byl vyčerpán jinou objednávkou).';
    }
    return null;
}

function isUniqueConstraintViolation(message: string): boolean {
    const normalized = message.toUpperCase();
    return normalized.includes('UNIQUE CONSTRAINT') || normalized.includes('SQLITE_CONSTRAINT');
}

interface HoldAuditInput {
    readonly tenantId: string;
    readonly orderId: string;
    readonly voucherId: string;
    readonly recomputedMinor: number;
    readonly claimedMinor: number;
    readonly tokenAmountMinor: number;
}

/**
 * Audit HOLD (§6.2 bod 3: "zapíše se audit záznam a odejde alert").
 *
 * Selhání zápisu auditu NESMÍ shodit HOLD -- HOLD už platí tím, že se
 * kredit neodečetl, a alert už je v logu (`alert: true`). Vyhozená výjimka
 * odsud by změnila 409 HOLD na 503, což by webhook odesílatel retryoval
 * a HOLD by se ztratil v šumu.
 *
 * Tabulka `voucher_audit` je v migraci 0002 -- vědomě oddělená od
 * `voucher_transactions`: ta je finanční historie (jen skutečné pohyby,
 * drží reconciliační součet), tahle je provozní (události BEZ finančního
 * dopadu, které musí být dohledatelné). Selhání zápisu se jen loguje,
 * nikdy neshodí HOLD -- 503 by webhook retryoval a HOLD by se ztratil.
 */
async function writeHoldAudit(db: D1Database, input: HoldAuditInput): Promise<void> {
    try {
        await db
            .prepare(
                `INSERT INTO voucher_audit
                     (tenant_id, voucher_id, order_id, event_type, payload_json)
                 VALUES (?1, ?2, ?3, 'REDEMPTION_HOLD', ?4)`,
            )
            .bind(
                input.tenantId,
                input.voucherId,
                input.orderId,
                JSON.stringify({
                    recomputedMinor: input.recomputedMinor,
                    claimedMinor: input.claimedMinor,
                    tokenAmountMinor: input.tokenAmountMinor,
                }),
            )
            .run();
    } catch (error) {
        log('error', 'voucher.audit.hold_write_failed', {
            alert: true,
            tenantId: input.tenantId,
            orderId: input.orderId,
            message: errorMessage(error),
        });
    }
}

// ---------------------------------------------------------------------------
// Nonce store (kontrakt, DO se píše samostatně -- viz types.ts)
// ---------------------------------------------------------------------------

/**
 * Adaptér na Durable Object dle PoC (`/reserve-nonce`).
 *
 * DO TŘÍDA SE V TOMHLE KROKU NEPÍŠE -- chybí jí binding ve wrangler.jsonc.
 * Chybí-li binding za běhu, tahle funkce HODÍ 503 a redemption neproběhne.
 * Žádný in-memory fallback (viz komentář u kroku 4 v `handleRedeem`).
 */
function resolveNonceStore(env: Env): NonceStore {
    const namespace = env.VOUCHER_SECURITY;

    if (namespace === undefined) {
        log('error', 'voucher.nonce.binding_missing', { alert: true });
        throw new ApiError(
            'MISSING_BINDING',
            503,
            'Replay protection není nakonfigurována -- čerpání je zastaveno.',
        );
    }

    return {
        async reserve(nonce: string, ttlSeconds: number): Promise<boolean> {
            try {
                const stub = namespace.get(namespace.idFromName('global'));
                const response = await stub.fetch(
                    `https://voucher-security.internal/reserve-nonce?nonce=${encodeURIComponent(nonce)}&ttl=${ttlSeconds}`,
                );

                if (!response.ok) {
                    throw new Error(`nonce store status ${response.status}`);
                }

                const data = (await response.json()) as { ok?: unknown };
                return data.ok === true;
            } catch (error) {
                log('error', 'voucher.nonce.reserve_failed', {
                    alert: true,
                    message: errorMessage(error),
                });
                // FAIL-CLOSED: nedostupné úložiště NIKDY neznamená "nonce je volný".
                throw new ApiError(
                    'STORAGE_UNAVAILABLE',
                    503,
                    'Replay protection je nedostupná -- čerpání zastaveno.',
                );
            }
        },
    };
}

// ---------------------------------------------------------------------------
// Validace vstupu
// ---------------------------------------------------------------------------

async function parseJsonBody(request: Request): Promise<unknown> {
    try {
        return await request.json();
    } catch {
        throw new ApiError('INVALID_JSON', 400, 'Tělo požadavku není platný JSON.');
    }
}

function validateRedeemRequest(body: unknown): RedeemRequest {
    if (typeof body !== 'object' || body === null) {
        throw new ApiError('VALIDATION_ERROR', 400, 'Tělo požadavku musí být objekt.');
    }

    const raw = body as Record<string, unknown>;

    const tenantId = requireTenantId(raw['tenantId']);
    const orderId = requireNonEmptyString(raw['orderId'], 'orderId');
    const token = requireNonEmptyString(raw['token'], 'token');
    const claimedDiscountMinor = parseMinorAmount(raw['claimedDiscountMinor'], 'claimedDiscountMinor');

    if (!Array.isArray(raw['lines']) || raw['lines'].length === 0) {
        throw new ApiError('VALIDATION_ERROR', 400, 'lines musí být neprázdné pole položek objednávky.');
    }

    const lines = raw['lines'].map((line, index) => validateOrderLine(line, index));

    return { tenantId, orderId, token, lines, claimedDiscountMinor };
}

function validateOrderLine(raw: unknown, index: number): OrderLineInput {
    if (typeof raw !== 'object' || raw === null) {
        throw new ApiError('VALIDATION_ERROR', 400, `lines[${index}] musí být objekt.`);
    }
    const line = raw as Record<string, unknown>;

    const quantity = line['quantity'];
    if (!Number.isSafeInteger(quantity) || (quantity as number) <= 0) {
        throw new ApiError('VALIDATION_ERROR', 400, `lines[${index}].quantity musí být kladný integer.`);
    }

    return {
        sku: requireNonEmptyString(line['sku'], `lines[${index}].sku`),
        quantity: quantity as number,
        unitPriceMinor: parseMinorAmount(line['unitPriceMinor'], `lines[${index}].unitPriceMinor`),
        isVoucherProduct: line['isVoucherProduct'] === true,
    };
}

/**
 * Součet položek. `unitPriceMinor * quantity` v INTEGERECH -- žádný float,
 * takže se součet nemůže rozejít se sumou v D1 (migrace 0001, ODCHYLKA).
 */
function sumLines(lines: readonly OrderLineInput[]): number {
    let total = 0;
    for (const line of lines) {
        total += line.unitPriceMinor * line.quantity;
        if (!Number.isSafeInteger(total)) {
            throw new ApiError('VALIDATION_ERROR', 400, 'Součet objednávky přesahuje bezpečný rozsah.');
        }
    }
    return total;
}

function requireNonEmptyString(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new ApiError('VALIDATION_ERROR', 400, `${field} musí být neprázdný string.`);
    }
    return value.trim();
}

function requireTenantId(value: unknown): string {
    const tenantId = requireNonEmptyString(value, 'tenantId');
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(tenantId)) {
        throw new ApiError('VALIDATION_ERROR', 400, 'tenantId má neplatný formát.');
    }
    return tenantId;
}

function requireCartFingerprint(value: unknown): string {
    const fingerprint = requireNonEmptyString(value, 'cartFingerprint');
    if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
        throw new ApiError('VALIDATION_ERROR', 400, 'cartFingerprint musí být SHA-256 hex.');
    }
    return fingerprint;
}

/** Částky VŽDY jako nezáporný integer v haléřích. Float se odmítá, netoleruje. */
function parseMinorAmount(value: unknown, field: string): number {
    const parsed = typeof value === 'string' ? Number(value) : value;
    if (!Number.isSafeInteger(parsed) || (parsed as number) < 0) {
        throw new ApiError('VALIDATION_ERROR', 400, `${field} musí být nezáporný integer v haléřích.`);
    }
    return parsed as number;
}

function isWellFormedVoucherCode(code: unknown): code is string {
    return typeof code === 'string' && VOUCHER_CODE_PATTERN.test(code);
}

// ---------------------------------------------------------------------------
// Token kódování
// ---------------------------------------------------------------------------

/**
 * Token = `base64url(payload JSON)` + `.` + `hex podpis`.
 * Payload je čitelný ZÁMĚRNĚ -- neobsahuje nic tajného (částku a kód
 * voucheru zákazník zná) a jeho integritu drží podpis, ne skrytost.
 * Šifrovat by znamenalo předstírat důvěrnost, kterou tenhle token nemá.
 */
function signToken(payload: VoucherTokenPayload, secret: string): Promise<string> {
    return signVoucherToken(payload, secret).then(
        (signature) => `${base64UrlEncode(JSON.stringify(payload))}.${signature}`,
    );
}

function decodeToken(token: string): { payload: VoucherTokenPayload; signature: string } {
    const separator = token.lastIndexOf('.');
    if (separator <= 0 || separator === token.length - 1) {
        throw new ApiError('REJECT_SIGNATURE', 403, 'Token má neplatný tvar.');
    }

    const encodedPayload = token.slice(0, separator);
    const signature = token.slice(separator + 1);

    let parsed: unknown;
    try {
        parsed = JSON.parse(base64UrlDecode(encodedPayload));
    } catch {
        throw new ApiError('REJECT_SIGNATURE', 403, 'Token nelze dekódovat.');
    }

    if (typeof parsed !== 'object' || parsed === null) {
        throw new ApiError('REJECT_SIGNATURE', 403, 'Token nese neplatný payload.');
    }

    const raw = parsed as Record<string, unknown>;

    // Tvar payloadu se ověřuje PŘED verifikací podpisu, protože kanonizace
    // (`buildVoucherCanonicalString`) na nevalidním vstupu hodí. Podpis
    // samotný to nekompromituje -- kontroluje se struktura, ne obsah.
    if (
        typeof raw['voucherId'] !== 'string' ||
        typeof raw['cartFingerprint'] !== 'string' ||
        typeof raw['nonce'] !== 'string' ||
        !Number.isSafeInteger(raw['amountMinor']) ||
        !Number.isSafeInteger(raw['timestamp'])
    ) {
        throw new ApiError('REJECT_SIGNATURE', 403, 'Token nese neúplný payload.');
    }

    return {
        payload: {
            voucherId: raw['voucherId'],
            amountMinor: raw['amountMinor'] as number,
            cartFingerprint: raw['cartFingerprint'],
            timestamp: raw['timestamp'] as number,
            nonce: raw['nonce'],
        },
        signature,
    };
}

function base64UrlEncode(value: string): string {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): string {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
