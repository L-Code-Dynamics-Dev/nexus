// CreditVoucherRedemptionRule -- doména `domains/voucher/`, Fáze A
// (docs/design-proposals/Digital-Voucher.md §6, ROZHODNUTO Lucky 2026-09-06).
//
// §6 definuje čerpatelnou částku doslova:
//   redeemableAmount = min(currentBalance, cartTotal)
//
// Poukaz je PLATEBNÍ vrstva ZA hotovým součtem košíku (§12), ne cenová
// sleva. Vstupem je tedy `cartTotal` -- hotová částka po Pricing Engine,
// ne cena položky. Částečné čerpání je normální stav: zbytek zůstává na
// poukazu a uplatní se v další objednávce.
//
// ============================================================================
// KRITICKÉ -- tahle Rule NENÍ BEZPEČNOSTNÍ KONTROLA.
// ============================================================================
// Autorita je SQL WHERE v čerpacím UPDATE (§8, §7 optimistický zámek),
// nikdy tenhle výpočet. Mezi okamžikem, kdy tahle Rule spočítá
// `redeemableAmount`, a okamžikem zápisu může poukaz vypršet, být vyčerpán
// jiným paralelním košíkem nebo stornován -- to je TOCTOU okno, které §8
// výslovně zakazuje uzavírat aplikačním kódem.
//
//   - `allowed: true` NEOPRAVŇUJE k odečtu kreditu. Odečet smí proběhnout
//     výhradně atomickým UPDATE z §7 (`WHERE version = :expected_version`
//     AND podmínky platnosti přímo ve WHERE, `meta.changes === 1` jako
//     jediný důkaz úspěchu).
//   - Výsledek slouží k ZOBRAZENÍ v košíku (§6.1) a k naplnění částky
//     kandidátního UPDATE. Nic víc.
//
// Co tahle Rule DĚLÁ:
//   1. Ověří uplatnitelnost snapshotu (§8: ACTIVE + neexpirováno + zůstatek)
//      -- stejné podmínky jako CreditVoucherValidityRule, aby volající
//      nemusel skládat dvě Rules jen kvůli jedné odpovědi.
//   2. Spočítá `redeemableAmount = min(currentBalance, cartTotal)`.
//   3. Spočítá `remainingBalance = currentBalance - redeemableAmount`.
//   4. Odvodí `resultingStatus`: 'DEPLETED' při nulovém zbytku, jinak
//      stav BEZE ZMĚNY (§7: částečné čerpání není stavový přechod).
//
// Co tahle Rule EXPLICITNĚ NEDĚLÁ:
//   - NEOVĚŘUJE HMAC token z §6.2 -- crypto patří do Worker vrstvy.
//   - NEZAPISUJE nic do DB. Žádný SQL UPDATE, žádná perzistence --
//     ta je vždy na volajícím (§7).
//   - NERETRYUJE. Vyčerpaný optimistický zámek (`changes === 0`, max 3
//     pokusy + backoff) řeší volající, ne Rule -- retry je I/O politika.
//   - NEGENERUJE kód poukazu -- generování je nedeterministické a Rule.ts
//     vyžaduje `stejný vstup = stejný výsledek`.
//   - NEČTE hodiny. `now` je VSTUP, nikdy `Date.now()` uvnitř `evaluate()`.
//   - NEVALIDUJE stavové přechody obecně -- to je
//     CreditVoucherLifecycleRule.
//   - NEROZPOČÍTÁVÁ částku mezi více poukazů v jedné objednávce -- OPEN
//     QUESTION 4 v CreditVoucher.ts, Fáze E.
//
// §12: voucher je platební vrstva ZA Pricing Engine. Tenhle soubor proto
// NESMÍ importovat nic z `domains/pricing/` -- ani nepřímo.

import Decimal from 'decimal.js';
import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import type { ISODateTime, Money } from '../../core/canonical/entities/base.js';
import type { CreditVoucherLifecycleState } from '../../core/canonical/entities/CreditVoucher.js';

export interface CreditVoucherRedemptionRuleInput {
    /** CreditVoucher.currentBalance -- snapshot přečtený z D1, ne živý stav. */
    readonly currentBalance: Money;
    /** CreditVoucher.status ze stejného snapshotu. */
    readonly status: CreditVoucherLifecycleState;
    /** CreditVoucher.expiresAt (§3: `expires_at`, ISO8601 TEXT). */
    readonly expiresAt: ISODateTime;
    /**
     * Referenční čas. VSTUP, nikdy `Date.now()` uvnitř `evaluate()` --
     * Rule.ts vyžaduje determinismus.
     */
    readonly now: ISODateTime;
    /**
     * Hotový součet košíku PO Pricing Engine (§12) -- částka, proti které
     * se kredit uplatňuje. Ne cena položky, ne základ pro slevu.
     */
    readonly cartTotal: Money;
}

/** Strojově čitelný důvod zamítnutí -- pro překlad hlášek v UI. */
export type CreditVoucherRedemptionRejectionReason =
    | 'NOT_ACTIVE'
    | 'EXPIRED'
    | 'DEPLETED'
    | 'INVALID_TIMESTAMP'
    | 'CURRENCY_MISMATCH'
    | 'NEGATIVE_CART_TOTAL'
    | 'ZERO_CART_TOTAL';

export interface CreditVoucherRedemptionRuleResult {
    /**
     * Smí se čerpat? POZOR: `true` NEOPRAVŇUJE k odečtu kreditu --
     * viz hlavička, autorita je SQL WHERE z §7/§8.
     */
    readonly allowed: boolean;
    /** Strojově čitelný důvod zamítnutí. */
    readonly reasonCode?: CreditVoucherRedemptionRejectionReason;
    /** Lidsky čitelná hláška pro košík / validační endpoint (§6.1). */
    readonly reason?: string;
    /**
     * `min(currentBalance, cartTotal)`. Při zamítnutí je nula v měně
     * poukazu -- volající nikdy nedostane `undefined` a nemusí větvit.
     */
    readonly redeemableAmount: Money;
    /**
     * `currentBalance - redeemableAmount`. Při zamítnutí beze změny,
     * tedy rovno `currentBalance`.
     */
    readonly remainingBalance: Money;
    /**
     * Stav PO čerpání. 'DEPLETED' při nulovém zbytku, jinak `input.status`
     * beze změny -- částečné čerpání NENÍ stavový přechod (§7, komentář
     * `ACTIVE -> ACTIVE` v CreditVoucher.ts). Volající tenhle stav zapisuje
     * TÝMŽ UPDATE, který snižuje zůstatek (invariant 4), ne druhým příkazem.
     */
    readonly resultingStatus: CreditVoucherLifecycleState;
}

const ZERO = new Decimal(0);

/**
 * Porovnání dvou ISO8601 timestampů. `Date.parse` je deterministické (žádné
 * čtení hodin), `now` i `expiresAt` jsou vstupy. Vrací `undefined`, pokud
 * některý timestamp nejde rozparsovat -- fail-closed, ne tichý `false`.
 * Záměrně shodná sémantika s CreditVoucherValidityRule.
 */
function isStrictlyAfter(later: ISODateTime, earlier: ISODateTime): boolean | undefined {
    const laterMs = Date.parse(later);
    const earlierMs = Date.parse(earlier);
    if (Number.isNaN(laterMs) || Number.isNaN(earlierMs)) {
        return undefined;
    }
    return laterMs > earlierMs;
}

export class CreditVoucherRedemptionRule
    implements Rule<CreditVoucherRedemptionRuleInput, CreditVoucherRedemptionRuleResult>
{
    constructor(public readonly context: RuleContext) {}

    evaluate(input: CreditVoucherRedemptionRuleInput): CreditVoucherRedemptionRuleResult {
        // Zamítnutí nemění nic: nula k čerpání, zůstatek i stav beze změny.
        const reject = (
            reasonCode: CreditVoucherRedemptionRejectionReason,
            reason: string
        ): CreditVoucherRedemptionRuleResult => ({
            allowed: false,
            reasonCode,
            reason,
            redeemableAmount: { amount: ZERO, currency: input.currentBalance.currency },
            remainingBalance: input.currentBalance,
            resultingStatus: input.status,
        });

        // 1. Měna PRVNÍ -- bez shodné měny nemá `min()` ani odečet smysl.
        //    Invariant 2 v CreditVoucher.ts drží měnu poukazu neměnnou;
        //    tenhle test chytá košík v jiné měně, ne rozbitý poukaz.
        if (input.currentBalance.currency !== input.cartTotal.currency) {
            return reject(
                'CURRENCY_MISMATCH',
                `Měna poukazu (${input.currentBalance.currency}) neodpovídá měně košíku (${input.cartTotal.currency})`
            );
        }

        // 2. Podmínky platnosti §8 -- stejné tři jako
        //    CreditVoucherValidityRule, ve stejném pořadí.
        const notExpired = isStrictlyAfter(input.expiresAt, input.now);
        if (notExpired === undefined) {
            // Nerozparsovatelný timestamp -- fail-closed.
            return reject(
                'INVALID_TIMESTAMP',
                `Neplatný ISO8601 timestamp (expiresAt="${input.expiresAt}", now="${input.now}")`
            );
        }

        if (input.status !== 'ACTIVE') {
            return reject('NOT_ACTIVE', `Poukaz není aktivní (stav "${input.status}")`);
        }

        if (!notExpired) {
            return reject('EXPIRED', `Platnost poukazu vypršela ${input.expiresAt}`);
        }

        // `current_balance > 0` -- Decimal porovnání, nikdy float
        // (base.ts: "Peníze vždy jako Decimal, nikdy float").
        if (!input.currentBalance.amount.greaterThan(ZERO)) {
            return reject('DEPLETED', 'Poukaz má nulový zůstatek');
        }

        // 3. Košík. Záporný součet je vada volajícího, ne poukazu --
        //    zamítáme hlasitě, ať se to neprojeví jako "vrácení" kreditu.
        if (input.cartTotal.amount.lessThan(ZERO)) {
            return reject(
                'NEGATIVE_CART_TOTAL',
                `Součet košíku je záporný (${input.cartTotal.amount.toString()} ${input.cartTotal.currency})`
            );
        }

        // Nulový košík: čerpat není z čeho. Odlišený důvod od záporného,
        // protože pro UI to není chyba, jen "není co platit".
        if (input.cartTotal.amount.isZero()) {
            return reject('ZERO_CART_TOTAL', 'Součet košíku je nulový, není z čeho čerpat');
        }

        // 4. §6: redeemableAmount = min(currentBalance, cartTotal).
        const redeemable = Decimal.min(input.currentBalance.amount, input.cartTotal.amount);
        const remaining = input.currentBalance.amount.minus(redeemable);

        // Invariant 4 (CreditVoucher.ts): `currentBalance === 0`
        // <=> `status === 'DEPLETED'`. Částečné čerpání stav NEMĚNÍ.
        const resultingStatus: CreditVoucherLifecycleState = remaining.isZero()
            ? 'DEPLETED'
            : input.status;

        return {
            allowed: true,
            redeemableAmount: { amount: redeemable, currency: input.currentBalance.currency },
            remainingBalance: { amount: remaining, currency: input.currentBalance.currency },
            resultingStatus,
        };
    }
}
