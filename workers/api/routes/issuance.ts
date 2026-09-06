// Issuance endpoint -- Worker vrstva, Fáze A "Voucher Core"
// (docs/design-proposals/Digital-Voucher.md §4, ROZHODNUTO Lucky 2026-09-06).
//
//   POST /api/vouchers/issue   -- order webhook: zákazník KOUPIL poukaz
//
// Tok dle §4:
//   Shoptet Order (obsahuje voucher produkt N x 1 Kč)
//     -> ověření objednávky (zaplaceno?)
//     -> idempotency check (klíč = (tenantId, sourceOrderId))
//     -> vygenerování kódu
//     -> D1 INSERT vouchers + voucher_transactions(ISSUED)
//     -> vrácení kódu
//
// ============================================================================
// KONTRAKT MPV -- EMISE NENÍ ZDANITELNÉ PLNĚNÍ (§15)
// ============================================================================
// Kreditní poukaz je VÍCEÚČELOVÝ POUKAZ podle § 15b ZDPH (ROZHODNUTO Lucky
// 2026-09-06). Kredit je čerpatelný napříč sortimentem s různými sazbami
// (12 % / 21 %), takže v okamžiku prodeje NENÍ ZNÁMO, jaké plnění bude
// poskytnuto -- definiční znak MPV.
//
// CO Z TOHO PLYNE PRO TENHLE SOUBOR -- je to KONTRAKT, ne výpočet:
//   - NEZAPISUJE SE ŽÁDNÁ DPH. Ani sazba, ani základ daně, ani rozpad.
//     Schéma (migrations/0001) proto žádný takový sloupec nemá a tenhle
//     endpoint žádný nepřidává.
//   - NEVYSTAVUJE SE DAŇOVÝ DOKLAD. Emise poukazu je příjem platby na
//     budoucí plnění, ne plnění samo. Daňový doklad vzniká až při ČERPÁNÍ,
//     a to v účetním systému (Omega / Pohoda / Money S3, §15.1), ne tady.
//   - `core/canonical/entities/Invoice.ts` (rozhodnutí Jose, Fáze 6.1):
//     "NEXUS nevytváří účetní pravdu" a "automatické vytváření/vystavování
//     Invoice je EXPLICITNĚ MIMO SCOPE". Tenhle endpoint tedy Invoice
//     NEZAKLÁDÁ a nesahá na `domains/billing/` ani na `connectors/`.
//   - NEXUS eviduje KREDIT A JEHO POHYBY jako fakta; účetní pravdu z nich
//     dělá účetní systém. Vazba Voucher -> Invoice je PŘES Order
//     (`voucher_transactions.order_id`), nová vazba se nezavádí.
//
// Kdyby sem někdy někdo přidal sazbu DPH "aby to bylo úplné", rozbije tím
// daňový režim MPV -- nejde o kosmetiku, jde o § 15b ZDPH.
//
// ============================================================================
// CO TENHLE SOUBOR NEDĚLÁ
// ============================================================================
// PDF a e-mail (Resend) jsou FÁZE C, ne tady (§14). Endpoint vrátí kód
// a zaloguje emisi; doručení zákazníkovi řeší samostatný krok. Vracet kód
// v odpovědi je záměr: webhook odesílatel (nebo reconciliace) tak má důkaz,
// že emise proběhla, i než existuje doručovací vrstva.
//
// ŽÁDNÝ import z `domains/pricing/` -- ani nepřímo (§12: voucher je platební
// vrstva ZA hotovým součtem košíku, nikdy sleva v Pricing Engine).
//
// ============================================================================
// PENÍZE
// ============================================================================
// D1 drží haléře jako INTEGER (`_minor` sufix, migrations/0001 ODCHYLKA:
// REAL je IEEE-754 float a na penězích se rozejde s reconciliačním
// invariantem). Tenhle soubor počítá VÝHRADNĚ v celých haléřích a nikde
// nepoužívá float -- na rozdíl od `routes/voucher.ts` tu není potřeba
// převod na `Money{Decimal}`, protože se nevolá žádná Rule: hodnota poukazu
// je prostý součet položek, ne business rozhodnutí.

import {
    generateVoucherCode,
    isValidVoucherCodeFormat,
} from '../../../domains/voucher/CreditVoucherCodeGenerator.js';
import { ApiError, jsonResponse, log, redactVoucherCode } from '../http.js';
import type { D1Database, Env } from '../types.js';

// ---------------------------------------------------------------------------
// Konfigurace
// ---------------------------------------------------------------------------

/**
 * §8: `created_at + 1 rok` (ROZHODNUTO), konfigurovatelné per tenant (§11).
 *
 * Konfigurace per tenant dnes NEMÁ kam sáhnout -- `core/tenant/types.ts`
 * definuje `Tenant` a `TenantPolicy`, ale žádný store, který by je za běhu
 * načetl, v repu neexistuje (Fáze A je první perzistenční vrstva vůbec).
 * Proto je tady DEFAULT + přepis přes `VOUCHER_VALIDITY_MONTHS` z env
 * a jasně pojmenované místo, kam tenant lookup přijde, až store vznikne.
 * NENÍ to hardcode "nastálo" -- §11 výslovně zakazuje dávat to natvrdo
 * do kódu, a tohle je nejbližší dostupná konfigurovatelná forma.
 */
const DEFAULT_VALIDITY_MONTHS = 12;

/** Rozumné meze pro konfiguraci -- ochrana proti překlepu v env (0 nebo 9999). */
const MIN_VALIDITY_MONTHS = 1;
const MAX_VALIDITY_MONTHS = 120;

/**
 * §4: kolize kódu -> zkus znovu, max 5x, pak selhat s alertem.
 *
 * Při 30^8 (~6,6x10^11) kombinacích je kolize prakticky nemožná -- ale
 * "prakticky nemožná" není u platidla totéž co "ošetřená". Pět pokusů je
 * strop z §4: kdyby selhaly všechny, není to smůla, ale rozbitý zdroj
 * entropie, a to se MUSÍ dozvědět člověk (alert), ne retry smyčka.
 */
const MAX_CODE_COLLISION_RETRIES = 5;

/**
 * Stavy objednávky, které považujeme za ZAPLACENÉ (§4: "ověření objednávky
 * (zaplaceno?)"). Poukaz je kredit -- vystavit ho na nezaplacenou objednávku
 * znamená rozdat peníze.
 *
 * Seznam je záměrně KRÁTKÝ a explicitní, ne "všechno kromě CANCELLED":
 * neznámý stav (nový stav v Shoptetu, překlep v konfiguraci) musí skončit
 * odmítnutím, ne emisí. Fail-closed.
 */
const PAID_ORDER_STATES: ReadonlySet<string> = new Set(['PAID', 'COMPLETED', 'SETTLED']);

// ---------------------------------------------------------------------------
// Request / Response kontrakt
// ---------------------------------------------------------------------------

/**
 * Položka objednávky. Hodnota poukazu se počítá Z NICH, ne z requestu --
 * viz `IssueRequest`.
 */
interface OrderLineInput {
    readonly sku: string;
    readonly quantity: number;
    readonly unitPriceMinor: number;
    /**
     * `true` = tohle JE kredit produkt (§1: poukaz je produkt se základní
     * cenou 1 Kč a hodnota se tvoří MNOŽSTVÍM, 1500 Kč = 1500 ks).
     * Jen z těchto řádků se skládá hodnota poukazu.
     */
    readonly isVoucherProduct?: boolean;
}

interface IssueRequest {
    readonly tenantId: string;
    /** Objednávka, KTEROU BYL POUKAZ ZAKOUPEN. Idempotency klíč emise (§4). */
    readonly orderId: string;
    /** Stav objednávky -- musí být v `PAID_ORDER_STATES`, jinak se nevystavuje. */
    readonly orderState: string;
    /** Komu poukaz patří. Doručení je Fáze C, ale adresát se eviduje hned. */
    readonly customerEmail: string;
    readonly lines: readonly OrderLineInput[];
    /**
     * ZÁMĚRNĚ TU NENÍ `voucherValueMinor`. Hodnotu si Worker POČÍTÁ SÁM
     * z položek objednávky -- stejný princip jako §6.2 bod 2 u čerpání:
     * "Worker si částku přepočítá sám, při order webhooku se NEPŘEBÍRÁ
     * hodnota z objednávky."
     *
     * Kdyby hodnota chodila v requestu, kdokoli, kdo umí zavolat webhook,
     * si vystaví poukaz na libovolnou částku. To, že request přichází přes
     * podepsaný kanál, na tom nic nemění -- obrana v hloubce znamená, že
     * ani autentizovaný odesílatel neurčuje, kolik peněz vznikne.
     */
    readonly currency?: string;
}

interface IssueResponse {
    readonly ok: true;
    /** Kód poukazu `NEXUS-XXXX-XXXX-RRRR`. Jediné místo, kde jde ven celý. */
    readonly code: string;
    readonly balance: number;
    readonly currency: string;
    readonly expiresAt: string;
    /**
     * `true` = poukaz pro tuhle objednávku UŽ EXISTOVAL a vrací se ten
     * původní. Není to chyba, je to očekávaný výsledek dvojího doručení
     * webhooku (§4). Odesílatel podle toho pozná, že se nic nového nestalo.
     */
    readonly alreadyIssued: boolean;
}

// ---------------------------------------------------------------------------
// POST /api/vouchers/issue
// ---------------------------------------------------------------------------

export async function handleIssue(request: Request, env: Env): Promise<Response> {
    const body = await parseJsonBody(request);
    const input = validateIssueRequest(body);

    // -----------------------------------------------------------------
    // 1. OVĚŘENÍ OBJEDNÁVKY (§4). Nezaplacená objednávka = žádný kredit.
    //    Fail-closed: neznámý stav se NEVYSTAVUJE.
    // -----------------------------------------------------------------
    if (!PAID_ORDER_STATES.has(input.orderState)) {
        log('warn', 'voucher.issue.reject_unpaid', {
            tenantId: input.tenantId,
            orderId: input.orderId,
            orderState: input.orderState,
        });
        throw new ApiError(
            'VOUCHER_NOT_APPLICABLE',
            409,
            `Objednávka není ve stavu, ze kterého lze vystavit poukaz (stav "${input.orderState}").`,
        );
    }

    // -----------------------------------------------------------------
    // 2. HODNOTA POUKAZU -- WORKER SI JI SPOČÍTÁ SÁM (§1, princip §6.2/2).
    //    N x 1 Kč: hodnota = suma (quantity * unitPriceMinor) přes řádky
    //    kredit produktu. Nepřebírá se z requestu -- viz IssueRequest.
    // -----------------------------------------------------------------
    const voucherLines = input.lines.filter((line) => line.isVoucherProduct === true);
    if (voucherLines.length === 0) {
        log('warn', 'voucher.issue.no_voucher_lines', {
            tenantId: input.tenantId,
            orderId: input.orderId,
        });
        throw new ApiError(
            'VALIDATION_ERROR',
            400,
            'Objednávka neobsahuje žádnou položku kreditního poukazu.',
        );
    }

    const initialBalanceMinor = sumLines(voucherLines);
    if (initialBalanceMinor <= 0) {
        // `ck_vouchers_initial_positive` by to zachytil taky, ale s nečitelnou
        // SQL hláškou. Poukaz na nulu není edge case, je to nesmysl.
        throw new ApiError('VALIDATION_ERROR', 400, 'Hodnota poukazu musí být kladná.');
    }

    // -----------------------------------------------------------------
    // 3. IDEMPOTENCY CHECK (§4, klíč = (tenantId, sourceOrderId)).
    //
    //    RYCHLÁ CESTA. Autorita je `uq_vouchers_source_order` v D1 -- tenhle
    //    SELECT ji NENAHRAZUJE, jen šetří generování kódu a INSERT u drtivé
    //    většiny opakovaných doručení. Mezi ním a INSERTem je TOCTOU okno
    //    (dvě souběžná doručení téhož webhooku), které zavírá až unique
    //    index; proto se violation MUSÍ ošetřit i dole (krok 5).
    //
    //    Vzor je `IdempotencyStore`: "DB constraint řeší race condition, ne
    //    aplikační kód". Aplikační kód tu je kvůli ČITELNÉ odpovědi
    //    (vrátit existující poukaz, ne chybu), ne kvůli korektnosti.
    // -----------------------------------------------------------------
    const existing = await findVoucherBySourceOrder(env.DB, input.tenantId, input.orderId);
    if (existing !== null) {
        log('info', 'voucher.issue.idempotent_replay', {
            tenantId: input.tenantId,
            orderId: input.orderId,
            code: redactVoucherCode(existing.id),
        });
        return jsonResponse(toIssueResponse(existing, true), 200);
    }

    // -----------------------------------------------------------------
    // 4. EXPIRACE (§8: created_at + 1 rok, konfigurovatelné per tenant §11).
    //
    //    Čas se čte JEDNOU a používá se pro `created_at` i pro odvození
    //    `expires_at` a roku v kódu. Dvě nezávislá čtení hodin by se mohla
    //    rozejít o půlnoci a poukaz by nesl v kódu jiný rok, než má v D1.
    // -----------------------------------------------------------------
    const issuedAt = new Date();
    const validityMonths = resolveValidityMonths(env, input.tenantId);
    const expiresAt = addMonthsUtc(issuedAt, validityMonths);
    const currency = input.currency ?? 'CZK';

    // -----------------------------------------------------------------
    // 5. GENEROVÁNÍ KÓDU + ZÁPIS, s ošetřením KOLIZE KÓDU (§4: max 5 pokusů).
    // -----------------------------------------------------------------
    const issued = await issueWithCollisionRetry(env.DB, {
        tenantId: input.tenantId,
        orderId: input.orderId,
        customerEmail: input.customerEmail,
        initialBalanceMinor,
        currency,
        issuedAt: toSqliteDateTime(issuedAt),
        expiresAt: toSqliteDateTime(expiresAt),
        expiryYear: expiresAt.getUTCFullYear(),
    });

    if (issued.alreadyExisted) {
        // Souběžné doručení téhož webhooku prošlo TOCTOU oknem z kroku 3
        // a stihlo INSERT první. Unique index ho odchytil; my vracíme
        // POUKAZ, KTERÝ VYHRÁL -- ne chybu a rozhodně ne druhý poukaz.
        const winner = await findVoucherBySourceOrder(env.DB, input.tenantId, input.orderId);
        if (winner === null) {
            // Index hlásil kolizi, ale řádek tam není -- rozbitý invariant
            // úložiště, ne business případ. Tiché pokračování by vystavilo
            // druhý poukaz.
            log('error', 'voucher.issue.source_order_conflict_without_row', {
                alert: true,
                tenantId: input.tenantId,
                orderId: input.orderId,
            });
            throw new ApiError('STORAGE_UNAVAILABLE', 503, 'Emisi se nepodařilo dokončit.');
        }
        log('info', 'voucher.issue.idempotent_race', {
            tenantId: input.tenantId,
            orderId: input.orderId,
            code: redactVoucherCode(winner.id),
        });
        return jsonResponse(toIssueResponse(winner, true), 200);
    }

    // §15: ŽÁDNÁ DPH, ŽÁDNÝ DAŇOVÝ DOKLAD. Log je evidence pohybu kreditu
    // (fakt pro účetní systém), ne účetní zápis.
    // Kód poukazu je PLATIDLO -- do logu jen redigovaný (`http.ts`).
    log('info', 'voucher.issue.ok', {
        tenantId: input.tenantId,
        orderId: input.orderId,
        code: redactVoucherCode(issued.code),
        initialBalanceMinor,
        currency,
        expiresAt: issued.expiresAt,
        attempts: issued.attempts,
        // Explicitní stopa kontraktu §15 v auditní stopě -- aby při pozdější
        // účetní kontrole bylo v logu vidět, v jakém režimu emise proběhla.
        taxTreatment: 'MPV_NOT_TAXABLE_SUPPLY',
    });

    // PDF + e-mail (Resend) = FÁZE C. Tady se jen vrací kód (§14).
    return jsonResponse(
        {
            ok: true,
            code: issued.code,
            balance: initialBalanceMinor,
            currency,
            expiresAt: issued.expiresAt,
            alreadyIssued: false,
        } satisfies IssueResponse,
        201,
    );
}

// ---------------------------------------------------------------------------
// D1 přístup -- try/catch na KAŽDÉM I/O (master rule: defenzivní programování)
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
    readonly source_order_id: string;
    readonly status: string;
}

function toIssueResponse(row: VoucherRow, alreadyIssued: boolean): IssueResponse {
    return {
        ok: true,
        code: row.id,
        balance: row.current_balance_minor,
        currency: row.currency,
        expiresAt: row.expires_at,
        alreadyIssued,
    };
}

/** Idempotency lookup přes `uq_vouchers_source_order` (tenant_id, source_order_id). */
async function findVoucherBySourceOrder(
    db: D1Database,
    tenantId: string,
    sourceOrderId: string,
): Promise<VoucherRow | null> {
    try {
        return await db
            .prepare(
                `SELECT id, tenant_id, initial_balance_minor, current_balance_minor,
                        currency, created_at, expires_at, source_order_id, status
                   FROM vouchers
                  WHERE tenant_id = ?1 AND source_order_id = ?2`,
            )
            .bind(tenantId, sourceOrderId)
            .first<VoucherRow>();
    } catch (error) {
        log('error', 'voucher.issue.d1_read_failed', {
            tenantId,
            sourceOrderId,
            message: errorMessage(error),
        });
        // 503, ne 500: D1 výpadek je dočasný a webhook odesílatel má retryovat.
        // Retry je bezpečný právě proto, že celý tok je idempotentní.
        throw new ApiError('STORAGE_UNAVAILABLE', 503, 'Databáze poukazů je dočasně nedostupná.');
    }
}

interface IssueDbInput {
    readonly tenantId: string;
    readonly orderId: string;
    readonly customerEmail: string;
    readonly initialBalanceMinor: number;
    readonly currency: string;
    readonly issuedAt: string;
    readonly expiresAt: string;
    readonly expiryYear: number;
}

interface IssueDbResult {
    readonly code: string;
    readonly expiresAt: string;
    readonly attempts: number;
    /** `true` = `uq_vouchers_source_order` -- poukaz pro tuhle objednávku už je. */
    readonly alreadyExisted: boolean;
}

/**
 * Vygeneruje kód a zapíše poukaz. Řeší DVA RŮZNÉ unique konflikty, které se
 * NESMÍ splést dohromady:
 *
 *   `uq_vouchers_source_order` (tenant_id, source_order_id)
 *       -> IDEMPOTENCE. Dvojí doručení webhooku. Vrátit PŮVODNÍ poukaz,
 *          NEZKOUŠET znovu -- druhý pokus by vyrobil druhý poukaz na tutéž
 *          objednávku, kdyby index nebyl.
 *
 *   PRIMARY KEY na `id` (kód poukazu)
 *       -> KOLIZE GENERÁTORU. Vygenerovaný kód už existuje. Zkusit ZNOVU
 *          s novým kódem, max 5x (§4), pak selhat s alertem.
 *
 * Rozlišit je nutné podle toho, KTERÝ index spadl -- ne podle "spadl nějaký
 * unique". Kdyby se source-order konflikt vyhodnotil jako kolize kódu,
 * generovalo by se 5 nových kódů, které by všechny spadly na tomtéž indexu,
 * a emise by skončila falešným alertem místo idempotentní odpovědi.
 *
 * SQLite v hlášce unique violation uvádí sloupce (`vouchers.source_order_id`
 * / `vouchers.id`), takže rozlišení je možné. Fail-closed pro případ, že by
 * hláška byla nečitelná: neznámý unique konflikt se NEBERE jako kolize kódu
 * (retry), ale jako chyba -- retry na neznámém konfliktu je horší než pád.
 *
 * PDF/e-mail se tu NEDĚLAJÍ (Fáze C) -- funkce končí zápisem do D1.
 */
async function issueWithCollisionRetry(db: D1Database, input: IssueDbInput): Promise<IssueDbResult> {
    for (let attempt = 1; attempt <= MAX_CODE_COLLISION_RETRIES; attempt += 1) {
        const code = generateVoucherCode({ expiryYear: input.expiryYear });

        // Pojistka: generátor i tenhle Worker musí vidět stejný formát.
        // Rozejití by se jinak projevilo až u zákazníka, kterému `/validate`
        // odmítne kód, jaký mu NEXUS sám vystavil.
        if (!isValidVoucherCodeFormat(code)) {
            log('error', 'voucher.issue.malformed_generated_code', { alert: true });
            throw new ApiError('INTERNAL_ERROR', 500, 'Generátor kódu vrátil neplatný formát.');
        }

        try {
            // KROK 1 -- samotný poukaz.
            //
            // KRITICKÉ: INSERT vouchers a INSERT transakce NESMÍ JÍT JEDNÍM
            // `batch()`. D1 `batch()` se rollbackuje POUZE při SQL chybě;
            // kdyby první INSERT spadl na unique indexu, batch by se sice
            // rollbackl, ale my potřebujeme mezi oběma zápisy ROZHODNOUT
            // (idempotence vs. kolize kódu) -- což v batchi nejde.
            // Pořadí je proto NEMĚNNÉ: nejdřív voucher, po prokázaném
            // úspěchu transakce. Stejná úvaha jako v `CreditVoucherStore`.
            await db
                .prepare(
                    `INSERT INTO vouchers
                         (id, tenant_id, initial_balance_minor, current_balance_minor,
                          currency, created_at, expires_at, source_order_id,
                          customer_email, status, version)
                     VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7, ?8, 'ACTIVE', 0)`,
                )
                .bind(
                    code,
                    input.tenantId,
                    input.initialBalanceMinor,
                    input.currency,
                    input.issuedAt,
                    input.expiresAt,
                    input.orderId,
                    input.customerEmail,
                )
                .run();

            // KROK 2 -- ISSUED transakce. AŽ TEĎ, když poukaz prokazatelně
            // vznikl. `order_id` je NULL: `ck_vtx_order_id_presence` ho
            // u ISSUED ZAKAZUJE -- objednávka nákupu poukazu je na voucheru
            // (`source_order_id`), emise není spotřebitelská objednávka.
            //
            // §15: `amount_minor` je hodnota kreditu. ŽÁDNÁ DPH, žádný
            // rozpad základu daně -- emise není zdanitelné plnění.
            try {
                await db
                    .prepare(
                        `INSERT INTO voucher_transactions
                             (voucher_id, tenant_id, type, amount_minor, currency, order_id, created_at)
                         VALUES (?1, ?2, 'ISSUED', ?3, ?4, NULL, ?5)`,
                    )
                    .bind(
                        code,
                        input.tenantId,
                        input.initialBalanceMinor,
                        input.currency,
                        input.issuedAt,
                    )
                    .run();
            } catch (txError) {
                // Poukaz JE zapsaný, ISSUED transakce chybí -- rozejitý
                // reconciliační invariant (CreditVoucher.ts). Vědomě zvolený
                // SMĚR CHYBY: poukaz bez ISSUED záznamu odchytí reconciliace
                // a dohledá se. Opačné pořadí (transakce první) by při pádu
                // nechalo ISSUED záznam ukazující na neexistující poukaz,
                // což FOREIGN KEY stejně nedovolí.
                //
                // Emise se NEROLLBACKUJE: zákazník zaplatil a poukaz musí
                // existovat. Chybějící pohyb je opravitelný, zmizelý kredit ne.
                log('error', 'voucher.issue.transaction_write_failed', {
                    alert: true,
                    tenantId: input.tenantId,
                    orderId: input.orderId,
                    code: redactVoucherCode(code),
                    amountMinor: input.initialBalanceMinor,
                    message: errorMessage(txError),
                });
            }

            return { code, expiresAt: input.expiresAt, attempts: attempt, alreadyExisted: false };
        } catch (error) {
            const message = errorMessage(error);

            // Idempotence: poukaz pro tuhle objednávku už existuje.
            // NEZKOUŠET znovu -- volající vrátí ten původní.
            if (isSourceOrderConflict(message)) {
                return {
                    code: '',
                    expiresAt: input.expiresAt,
                    attempts: attempt,
                    alreadyExisted: true,
                };
            }

            // Kolize kódu (§4) -- nový kód, další pokus.
            if (isCodeCollision(message)) {
                log('warn', 'voucher.issue.code_collision', {
                    tenantId: input.tenantId,
                    orderId: input.orderId,
                    code: redactVoucherCode(code),
                    attempt,
                });
                continue;
            }

            // Cokoli jiného: skutečná chyba úložiště. NERETRYOVAT --
            // opakování neznámé chyby jen znásobí její dopad.
            log('error', 'voucher.issue.d1_write_failed', {
                tenantId: input.tenantId,
                orderId: input.orderId,
                attempt,
                message,
            });
            throw new ApiError('STORAGE_UNAVAILABLE', 503, 'Zápis poukazu selhal.');
        }
    }

    // §4: po vyčerpání pokusů SELHAT S ALERTEM. Pět kolizí za sebou při
    // 6,6x10^11 kombinacích není smůla -- je to rozbitý zdroj entropie
    // (např. `crypto.getRandomValues` vracející konstantu). To musí vidět
    // člověk, ne retry smyčka.
    log('error', 'voucher.issue.code_collision_exhausted', {
        alert: true,
        tenantId: input.tenantId,
        orderId: input.orderId,
        attempts: MAX_CODE_COLLISION_RETRIES,
    });
    throw new ApiError(
        'INTERNAL_ERROR',
        500,
        `Nepodařilo se vygenerovat unikátní kód poukazu po ${MAX_CODE_COLLISION_RETRIES} pokusech.`,
    );
}

/**
 * Rozliší konflikt na `uq_vouchers_source_order` -- IDEMPOTENCE, ne kolize kódu.
 *
 * SQLite hláška má tvar `UNIQUE constraint failed: vouchers.tenant_id,
 * vouchers.source_order_id`. Hledá se název sloupce, ne název indexu:
 * SQLite v hlášce uvádí sloupce, ne index.
 */
function isSourceOrderConflict(message: string): boolean {
    const normalized = message.toUpperCase();
    return isUniqueConstraintViolation(normalized) && normalized.includes('SOURCE_ORDER_ID');
}

/**
 * Rozliší kolizi PRIMARY KEY na `vouchers.id` -- tedy kód poukazu.
 *
 * Fail-closed: unique violation, kterou nelze zařadit ani jako source-order
 * konflikt, ani jako kolizi `vouchers.id`, se NEBERE jako kolize kódu.
 * Retry na neznámém konfliktu by mohl 5x zopakovat něco úplně jiného.
 */
function isCodeCollision(message: string): boolean {
    const normalized = message.toUpperCase();
    if (!isUniqueConstraintViolation(normalized)) {
        return false;
    }
    if (normalized.includes('SOURCE_ORDER_ID')) {
        return false;
    }
    return normalized.includes('VOUCHERS.ID') || normalized.includes('PRIMARY KEY');
}

function isUniqueConstraintViolation(normalizedMessage: string): boolean {
    return (
        normalizedMessage.includes('UNIQUE CONSTRAINT') ||
        normalizedMessage.includes('SQLITE_CONSTRAINT')
    );
}

// ---------------------------------------------------------------------------
// Expirace (§8 / §11)
// ---------------------------------------------------------------------------

/**
 * Délka platnosti v měsících. §8: default 12 (rok), §11: konfigurovatelné
 * per tenant.
 *
 * `tenantId` je v signatuře ZÁMĚRNĚ, i když se dnes nepoužívá: je to místo,
 * kam přijde tenant lookup, jakmile bude existovat tenant config store
 * (§11, `core/tenant/types.ts`). Bez parametru by se na to při doplňování
 * konfigurace muselo sahat do volajícího.
 *
 * Nevalidní hodnota v env se NEIGNORUJE tiše -- loguje se a použije default.
 * Tichý fallback u platnosti platidla je přesně ta věc, která se odhalí až
 * za rok, když poukazy expirují jindy, než měly.
 */
function resolveValidityMonths(env: Env, tenantId: string): number {
    const raw = env.VOUCHER_VALIDITY_MONTHS;
    if (raw === undefined || raw.trim().length === 0) {
        return DEFAULT_VALIDITY_MONTHS;
    }

    const parsed = Number(raw);
    if (
        !Number.isSafeInteger(parsed) ||
        parsed < MIN_VALIDITY_MONTHS ||
        parsed > MAX_VALIDITY_MONTHS
    ) {
        log('warn', 'voucher.issue.invalid_validity_config', {
            tenantId,
            configured: raw,
            fallbackMonths: DEFAULT_VALIDITY_MONTHS,
        });
        return DEFAULT_VALIDITY_MONTHS;
    }
    return parsed;
}

/**
 * Přičte měsíce v UTC. Ošetřuje přetečení dne v měsíci: 31. 1. + 1 měsíc
 * není 3. 3. (což by `setUTCMonth` udělal), ale 28. / 29. 2.
 *
 * Kdyby se datum přetočilo dopředu, poukaz by platil DÉLE, než má -- což je
 * u platidla peněžní rozdíl, ne kosmetika.
 */
function addMonthsUtc(from: Date, months: number): Date {
    const year = from.getUTCFullYear();
    const month = from.getUTCMonth();
    const day = from.getUTCDate();

    const targetMonthStart = new Date(
        Date.UTC(
            year,
            month + months,
            1,
            from.getUTCHours(),
            from.getUTCMinutes(),
            from.getUTCSeconds(),
            from.getUTCMilliseconds(),
        ),
    );

    // Poslední den cílového měsíce: den 0 následujícího měsíce.
    const lastDayOfTargetMonth = new Date(
        Date.UTC(targetMonthStart.getUTCFullYear(), targetMonthStart.getUTCMonth() + 1, 0),
    ).getUTCDate();

    targetMonthStart.setUTCDate(Math.min(day, lastDayOfTargetMonth));
    return targetMonthStart;
}

/**
 * SQLite/D1 formát data (migrations/0001: TEXT v ISO 8601, `datetime('now')`).
 *
 * `datetime('now')` v SQLite vrací `YYYY-MM-DD HH:MM:SS` (mezera, bez `Z`),
 * a §8 porovnává `expires_at > datetime('now')` LEXIKOGRAFICKY. Kdyby se sem
 * uložil `toISOString()` (`YYYY-MM-DDTHH:MM:SS.sssZ`), porovnávalo by se
 * `'2027-09-06T00:00:00.000Z' > '2026-09-06 12:00:00'` -- což by pro rok 2027
 * náhodou vyšlo správně, ale `'T'` (0x54) je větší než mezera (0x20), takže
 * ve STEJNÉM dni by expirovaný poukaz vypadal jako platný.
 *
 * Formát se proto sjednocuje na ten, který používá `datetime('now')`
 * v čerpacím UPDATE (`routes/voucher.ts`, §7).
 */
function toSqliteDateTime(date: Date): string {
    return date.toISOString().replace('T', ' ').slice(0, 19);
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

function validateIssueRequest(body: unknown): IssueRequest {
    if (typeof body !== 'object' || body === null) {
        throw new ApiError('VALIDATION_ERROR', 400, 'Tělo požadavku musí být objekt.');
    }

    const raw = body as Record<string, unknown>;

    const tenantId = requireTenantId(raw['tenantId']);
    const orderId = requireNonEmptyString(raw['orderId'], 'orderId');
    const orderState = requireNonEmptyString(raw['orderState'], 'orderState').toUpperCase();
    const customerEmail = requireEmail(raw['customerEmail']);

    if (!Array.isArray(raw['lines']) || raw['lines'].length === 0) {
        throw new ApiError(
            'VALIDATION_ERROR',
            400,
            'lines musí být neprázdné pole položek objednávky.',
        );
    }

    const lines = raw['lines'].map((line, index) => validateOrderLine(line, index));

    const currencyRaw = raw['currency'];
    const currency =
        currencyRaw === undefined ? undefined : requireCurrency(currencyRaw);

    return {
        tenantId,
        orderId,
        orderState,
        customerEmail,
        lines,
        ...(currency !== undefined ? { currency } : {}),
    };
}

function validateOrderLine(raw: unknown, index: number): OrderLineInput {
    if (typeof raw !== 'object' || raw === null) {
        throw new ApiError('VALIDATION_ERROR', 400, `lines[${index}] musí být objekt.`);
    }
    const line = raw as Record<string, unknown>;

    const quantity = line['quantity'];
    if (!Number.isSafeInteger(quantity) || (quantity as number) <= 0) {
        throw new ApiError(
            'VALIDATION_ERROR',
            400,
            `lines[${index}].quantity musí být kladný integer.`,
        );
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
 *
 * §1: kredit produkt je `N x 1 Kč`, tedy `unitPriceMinor = 100` a
 * `quantity = N`. Vzorec se ale na tu jedničku NESPOLÉHÁ -- kdyby tenant
 * změnil základní cenu produktu, součet musí zůstat správně.
 */
function sumLines(lines: readonly OrderLineInput[]): number {
    let total = 0;
    for (const line of lines) {
        total += line.unitPriceMinor * line.quantity;
        if (!Number.isSafeInteger(total)) {
            throw new ApiError(
                'VALIDATION_ERROR',
                400,
                'Hodnota poukazu přesahuje bezpečný rozsah.',
            );
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

/**
 * E-mail se validuje jen HRUBĚ (tvar `x@y.z`, rozumná délka). Přísnější
 * regex podle RFC 5322 odmítá platné adresy a nic nezískává -- jediné
 * skutečné ověření je doručení, což je Fáze C.
 */
function requireEmail(value: unknown): string {
    const email = requireNonEmptyString(value, 'customerEmail');
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new ApiError('VALIDATION_ERROR', 400, 'customerEmail má neplatný formát.');
    }
    return email;
}

/** ISO 4217 -- tři velká písmena. D1 default je 'CZK' (migrace 0001). */
function requireCurrency(value: unknown): string {
    const currency = requireNonEmptyString(value, 'currency').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
        throw new ApiError('VALIDATION_ERROR', 400, 'currency musí být ISO 4217 kód (3 písmena).');
    }
    return currency;
}

/** Částky VŽDY jako nezáporný integer v haléřích. Float se odmítá, netoleruje. */
function parseMinorAmount(value: unknown, field: string): number {
    const parsed = typeof value === 'string' ? Number(value) : value;
    if (!Number.isSafeInteger(parsed) || (parsed as number) < 0) {
        throw new ApiError(
            'VALIDATION_ERROR',
            400,
            `${field} musí být nezáporný integer v haléřích.`,
        );
    }
    return parsed as number;
}

// ---------------------------------------------------------------------------

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
