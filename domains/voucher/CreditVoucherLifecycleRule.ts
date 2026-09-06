// CreditVoucherLifecycleRule -- doména `domains/voucher/`, Fáze A
// (docs/design-proposals/Digital-Voucher.md §7 stavový diagram,
// ROZHODNUTO Lucky 2026-09-06).
//
// Vzor 1:1 podle `domains/campaign/CampaignLifecycleRule.ts`: tenká Rule
// nad `evaluateTransition()` a `CREDIT_VOUCHER_LIFECYCLE_DEFINITION`.
// Osa je definovaná v entitě (core/canonical/entities/CreditVoucher.ts),
// tady se JEN vyhodnocuje -- druhá kopie seznamu přechodů by byla přesně
// ten typ duplicity, kvůli které se stavy rozejdou.
//
// KRITICKÉ -- `DEPLETED` NENÍ terminální stav.
// §7 diagram říká výslovně `DEPLETED --refundace--> ACTIVE`: vrácení
// objednávky, ve které byl kredit vyčerpán do nuly, musí kredit vrátit
// na poukaz a poukaz znovu zaktivnit. Terminální jsou JEN `EXPIRED`
// a `CANCELLED` (čas neteče zpět; storno je konečné rozhodnutí operátora).
// Tohle drží `CREDIT_VOUCHER_LIFECYCLE_DEFINITION`, ne tenhle soubor --
// kdyby někdo `DEPLETED` do `terminalStates` doplnil, fail-closed
// `evaluateTransition()` by refundaci zamítl a jediná cesta zpět by bylo
// ruční přepsání stavu v DB.
//
// Co tahle Rule DĚLÁ:
//   1. Vyhodnotí dovolenost přechodu `currentStatus -> targetStatus`
//      na ose `creditVoucherLifecycle` (fail-closed: co není deklarované,
//      je zamítnuté).
//   2. Vrátí čitelný důvod zamítnutí pro audit (§13) a pro admin (Fáze D).
//
// Co tahle Rule EXPLICITNĚ NEDĚLÁ:
//   - NEZAPISUJE stav. Přechod zapisuje TÝŽ atomický UPDATE, který mění
//     zůstatek (§7, invariant 4 v CreditVoucher.ts) -- perzistence je
//     vždy na volajícím a autorita je SQL WHERE, ne tahle Rule.
//   - NEPOČÍTÁ čerpatelnou částku ani zůstatek -- to je
//     CreditVoucherRedemptionRule (§6). `ACTIVE -> DEPLETED` sem přijde
//     už rozhodnuté jako `resultingStatus`.
//   - NEVYHODNOCUJE platnost poukazu (ACTIVE + neexpirováno + zůstatek)
//     -- to je CreditVoucherValidityRule (§8).
//   - NEČTE hodiny ani D1. `evaluate()` je čistá funkce (TVRDÝ POŽADAVEK
//     core/canonical/rules/Rule.ts: stejný vstup = stejný výsledek).
//   - NEROZHODUJE, KDY se `ACTIVE -> EXPIRED` překlápí (batch job vs.
//     lazy) -- OPEN QUESTION 3 v CreditVoucher.ts, nerozhodnuto. Rule
//     jen řekne, že ten přechod je dovolený.
//   - NEZAKLÁDÁ `CreditVoucherTransaction` -- pohyb na kreditu je
//     samostatný append-only záznam, ne vedlejší efekt přechodu.
//
// POZOR na self-transition: částečné čerpání stav NEMĚNÍ a NENÍ přechod
// (§7). `ACTIVE -> ACTIVE` proto osa neuvádí a tahle Rule ho zamítne --
// záměrně. "Nic se nestalo" nesmí projít auditem jako přechod.
//
// §12: voucher je platební vrstva ZA Pricing Engine. Tenhle soubor proto
// NESMÍ importovat nic z `domains/pricing/` -- ani nepřímo.

import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import type { CreditVoucherLifecycleState } from '../../core/canonical/entities/CreditVoucher.js';
import { CREDIT_VOUCHER_LIFECYCLE_DEFINITION } from '../../core/canonical/entities/CreditVoucher.js';
import { evaluateTransition } from '../../core/state-machine/StateMachine.js';

export interface CreditVoucherLifecycleRuleInput {
    /** CreditVoucher.status -- snapshot přečtený z D1, ne živý stav. */
    readonly currentStatus: CreditVoucherLifecycleState;
    /** Cílový stav, typicky `resultingStatus` z CreditVoucherRedemptionRule. */
    readonly targetStatus: CreditVoucherLifecycleState;
}

export interface CreditVoucherLifecycleRuleResult {
    readonly allowed: boolean;
    readonly reason?: string;
}

export class CreditVoucherLifecycleRule
    implements Rule<CreditVoucherLifecycleRuleInput, CreditVoucherLifecycleRuleResult>
{
    constructor(public readonly context: RuleContext) {}

    evaluate(input: CreditVoucherLifecycleRuleInput): CreditVoucherLifecycleRuleResult {
        const transition = evaluateTransition(
            CREDIT_VOUCHER_LIFECYCLE_DEFINITION,
            input.currentStatus,
            input.targetStatus
        );

        if (!transition.allowed) {
            return { allowed: false, reason: transition.reason };
        }

        // Žádný další doménový invariant. Na rozdíl od Campaign
        // (DRAFT -> ACTIVE vyžaduje PromoGroup) nemá §7 u poukazu žádnou
        // podmínku, kterou by šlo vyhodnotit BEZ dat, jež stejně musí být
        // v SQL WHERE (zůstatek, expirace, version). Domýšlet ji sem by
        // znovu otevřelo TOCTOU okno, které §8 zakazuje.
        return { allowed: true };
    }
}

/**
 * Je poukaz v koncovém stavu, ze kterého už žádná cesta nevede?
 * Čistá funkce, čte JEN `terminalStates` z osy -- tedy `EXPIRED`
 * a `CANCELLED`. `DEPLETED` je záměrně NEterminální (refundace, §7),
 * proto vrací `false`; kdo potřebuje "poukaz je momentálně
 * neuplatnitelný", ptá se CreditVoucherValidityRule, ne téhle funkce.
 */
export function isCreditVoucherTerminal(status: CreditVoucherLifecycleState): boolean {
    return CREDIT_VOUCHER_LIFECYCLE_DEFINITION.terminalStates.includes(status);
}
