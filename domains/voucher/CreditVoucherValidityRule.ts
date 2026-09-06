// CreditVoucherValidityRule -- doména `domains/voucher/`, Fáze A
// (docs/design-proposals/Digital-Voucher.md §8, ROZHODNUTO Lucky 2026-09-06).
//
// §8 definuje podmínky platnosti doslova:
//   status = 'ACTIVE'  AND  expires_at > NOW()  AND  current_balance > 0
//
// ============================================================================
// KRITICKÉ -- tahle Rule je DOPLNĚK, NE NÁHRADA SQL WHERE klauzule.
// ============================================================================
// §8 říká výslovně: "Vyhodnocuje se v SQL WHERE klauzuli čerpacího UPDATE
// (§7), ne v aplikačním kódu před ním -- jinak vzniká TOCTOU okno mezi
// kontrolou a zápisem."
//
// AUTORITA ZŮSTÁVÁ V DATABÁZI. Mezi okamžikem, kdy tahle Rule řekne
// "platný", a okamžikem zápisu, může voucher vypršet, být vyčerpán jiným
// paralelním košíkem nebo stornován. Proto:
//
//   - Tahle Rule slouží pro VALIDAČNÍ ENDPOINT (`GET /api/vouchers/validate`,
//     §6.1) a pro ČITELNÉ CHYBOVÉ HLÁŠKY.
//   - NENÍ to bezpečnostní kontrola. Kladný výsledek NEOPRAVŇUJE k odečtu
//     kreditu. Odečet smí proběhnout výhradně přes atomický UPDATE z §7
//     (optimistický zámek + `status`/`current_balance`/`expires_at`
//     podmínky přímo ve WHERE + `meta.changes === 1`).
//   - Kdo tuhle Rule použije jako jedinou obranu před zápisem, znovu otevře
//     přesně to TOCTOU okno, které §8 zakazuje.
//
// Co tahle Rule DĚLÁ:
//   1. Vyhodnotí tři podmínky z §8 nad předaným snapshotem voucheru.
//   2. Vrátí per-podmínku výsledek, aby volající uměl uživateli říct PROČ
//      (vypršel / vyčerpán / stornován), ne jen "neplatný".
//
// Co tahle Rule EXPLICITNĚ NEDĚLÁ:
//   - Nečte D1 ani nic jiného -- `evaluate()` je čistá funkce (TVRDÝ
//     POŽADAVEK core/canonical/rules/Rule.ts: stejný vstup = stejný výsledek,
//     žádné skryté side effects).
//   - Nevolá `Date.now()`. `now` je VSTUP -- jinak by Rule nebyla
//     deterministická a nešla by otestovat ani reprodukovat.
//   - Nepočítá čerpatelnou částku -- to je CreditVoucherRedemptionRule (§6).
//   - Nevaliduje přechody stavů -- to je CreditVoucherLifecycleRule (§7).
//   - Neověřuje HMAC token z §6.2 -- crypto patří do Worker vrstvy.
//   - Nezapisuje nic do DB -- perzistence je vždy na volajícím.
//
// §12: voucher je platební vrstva ZA Pricing Engine ("až na hotový součet
// košíku, nikdy na cenu položky"). Tenhle soubor proto NESMÍ importovat nic
// z `domains/pricing/` -- ani nepřímo.

import Decimal from 'decimal.js';
import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import type { ISODateTime, Money } from '../../core/canonical/entities/base.js';
import type { CreditVoucherLifecycleState } from '../../core/canonical/entities/CreditVoucher.js';

export interface CreditVoucherValidityRuleInput {
    /** CreditVoucher.status -- snapshot přečtený z D1, ne živý stav. */
    readonly status: CreditVoucherLifecycleState;
    /** CreditVoucher.expiresAt (§3: `expires_at`, ISO8601 TEXT). */
    readonly expiresAt: ISODateTime;
    /** CreditVoucher.currentBalance (§3: `current_balance`). */
    readonly currentBalance: Money;
    /**
     * Referenční čas. VSTUP, nikdy `Date.now()` uvnitř `evaluate()` --
     * Rule.ts vyžaduje determinismus.
     */
    readonly now: ISODateTime;
}

/** Strojově čitelný důvod neplatnosti -- pro překlad hlášek v UI. */
export type CreditVoucherInvalidityReason =
    | 'NOT_ACTIVE'
    | 'EXPIRED'
    | 'DEPLETED'
    | 'INVALID_TIMESTAMP';

export interface CreditVoucherValidityRuleResult {
    /**
     * Souhrn všech tří podmínek §8. POZOR: `true` NEOPRAVŇUJE k odečtu
     * kreditu -- viz hlavička, autorita je SQL WHERE z §7.
     */
    readonly valid: boolean;
    /** První porušená podmínka, v pořadí NOT_ACTIVE -> EXPIRED -> DEPLETED. */
    readonly reasonCode?: CreditVoucherInvalidityReason;
    /** Lidsky čitelná hláška pro validační endpoint (§6.1). */
    readonly reason?: string;
    /** Per-podmínku výsledek -- ať volající nemusí důvod odvozovat z textu. */
    readonly checks: {
        readonly isActive: boolean;
        readonly isNotExpired: boolean;
        readonly hasBalance: boolean;
    };
}

/**
 * Porovnání dvou ISO8601 timestampů. `Date.parse` je deterministické (žádné
 * čtení hodin), `now` i `expiresAt` jsou vstupy. Vrací `undefined`, pokud
 * některý timestamp nejde rozparsovat -- fail-closed, ne tichý `false`.
 */
function isStrictlyAfter(later: ISODateTime, earlier: ISODateTime): boolean | undefined {
    const laterMs = Date.parse(later);
    const earlierMs = Date.parse(earlier);
    if (Number.isNaN(laterMs) || Number.isNaN(earlierMs)) {
        return undefined;
    }
    return laterMs > earlierMs;
}

export class CreditVoucherValidityRule
    implements Rule<CreditVoucherValidityRuleInput, CreditVoucherValidityRuleResult>
{
    constructor(public readonly context: RuleContext) {}

    evaluate(input: CreditVoucherValidityRuleInput): CreditVoucherValidityRuleResult {
        const isActive = input.status === 'ACTIVE';

        // `expires_at > NOW()` -- ostrá nerovnost, přesně jak je v §8 a v SQL
        // WHERE z §7. Voucher expirující přesně v `now` už NENÍ platný.
        const notExpired = isStrictlyAfter(input.expiresAt, input.now);
        if (notExpired === undefined) {
            // Nerozparsovatelný timestamp -- fail-closed. Radši nečitelný
            // vstup zamítnout než ho tiše vyhodnotit jako platný.
            return {
                valid: false,
                reasonCode: 'INVALID_TIMESTAMP',
                reason: `Neplatný ISO8601 timestamp (expiresAt="${input.expiresAt}", now="${input.now}")`,
                checks: { isActive, isNotExpired: false, hasBalance: false },
            };
        }

        // `current_balance > 0` -- Decimal porovnání, nikdy float
        // (base.ts: "Peníze vždy jako Decimal, nikdy float").
        const hasBalance = input.currentBalance.amount.greaterThan(new Decimal(0));

        const checks = { isActive, isNotExpired: notExpired, hasBalance };

        // Pořadí důvodů je stabilní a záměrné: stav voucheru (stornován /
        // vypršel jako stav) má přednost před odvozenými důvody, protože
        // nese nejvíc informace pro zákazníka i pro podporu.
        if (!isActive) {
            return {
                valid: false,
                reasonCode: 'NOT_ACTIVE',
                reason: `Poukaz není aktivní (stav "${input.status}")`,
                checks,
            };
        }

        if (!notExpired) {
            return {
                valid: false,
                reasonCode: 'EXPIRED',
                reason: `Platnost poukazu vypršela ${input.expiresAt}`,
                checks,
            };
        }

        if (!hasBalance) {
            return {
                valid: false,
                reasonCode: 'DEPLETED',
                reason: 'Poukaz má nulový zůstatek',
                checks,
            };
        }

        return { valid: true, checks };
    }
}
