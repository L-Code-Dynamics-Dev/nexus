// SubscriptionLifecycleRule -- Fáze 6.2 business rule nad Fáze 6.1 kostrou
// (core/canonical/entities/Billing.ts). Josovo zadání 2026-09-05:
// "Subscription/Billing: TRIAL -> ACTIVE -> PAST_DUE -> CANCELLED;
// respektuj existující Tenant/Plan model; Billing je SaaS subscription
// billing; žádné usage billing ani payment gateway; Invoice z objednávky
// je od Billingu vždy oddělená."
//
// Co tahle Rule DĚLÁ (a nic víc):
//   1. Validuje lifecycle přechod (SUBSCRIPTION_LIFECYCLE_DEFINITION,
//      přes evaluateTransition() -- žádná vlastní stavová logika,
//      deleguje na existující definici z core/canonical/entities/Billing.ts).
//   2. Validuje, že Subscription.planTier je jedna z platných `PlanTier`
//      hodnot z core/tenant/types.ts -- NEDUPLIKUJE TenantPlan logiku,
//      jen kontroluje členství v existujícím union typu (žádná nová
//      enum definice, žádné čtení/zápis do TenantPlan záznamu samotného
//      -- to by vyžadovalo I/O, které Rule.evaluate() nesmí mít).
//
// Co tahle Rule EXPLICITNĚ NEDĚLÁ (UNRESOLVED, Jose nezadal):
//   - UNRESOLVED: žádná validace usage/limitů (usageLimit/usageCurrent)
//     -- Jose explicitně zakázal "usage billing", a nezadal žádné
//     konkrétní pravidlo pro tato pole (jsou stále TBD v Billing.ts).
//   - UNRESOLVED: žádné napojení na platební bránu / kontrola platby
//     -- Jose explicitně zakázal "payment gateway".
//
// Invoice/Order oddělenost je u tohoto souboru vynucena STRUKTURÁLNĚ (Rule
// nemá žádný Invoice/Order import/typ ve svém vstupu) a otestována v
// tests/unit/BillingRules.test.ts jako typový invariant na Subscription
// samotné -- není to něco, co by tahle Rule musela "hlídat" za běhu.
//
// ROZHODNUTO (Jose 2026-09-05, Fáze 6.3), bod 5 -- Subscription <->
// TenantPlan konzistence: "Subscription nesmí mít vlastní paralelní
// pravdu. Stav musí být konzistentní s TenantPlan." Subscription.status
// ('TRIAL'|'ACTIVE'|'PAST_DUE'|'CANCELLED') a TenantPlan.status
// ('ACTIVE'|'GRACE_PERIOD'|'SUSPENDED'|'CANCELED', core/tenant/types.ts)
// NEJSOU stejný typ ani hodnoty -- nejde je slít. `isConsistentWithTenantPlan()`
// níže je čistá KONZISTENČNÍ KONTROLA (booleovská otázka "jsou tyhle dva
// stavy spolu v pořádku, ano/ne"), NENÍ to sync workflow -- nic
// nepřepisuje, jen ověřuje. Mapování odvozeno POUZE ze sémantické
// podobnosti názvů, fail-safe (nejisté kombinace -> false, ne true):
//   - Subscription 'ACTIVE'    <-> TenantPlan 'ACTIVE'        -- jistá shoda.
//   - Subscription 'CANCELLED' <-> TenantPlan 'CANCELED'      -- jistá shoda
//     (pozor na pravopis: TenantPlan má JEDNO L, Subscription DVĚ L).
//   - Subscription 'PAST_DUE'  <-> TenantPlan 'GRACE_PERIOD'  -- NEJLEPŠÍ
//     DOSTUPNÉ odvození (obojí signalizuje "platba selhala, ještě
//     neukončeno"), ale UNRESOLVED zbytek: přesná definice "GRACE_PERIOD"
//     nebyla nikde jinde v repu blíž specifikována, takže tohle mapování
//     není jistota, jen nejrozumnější dostupná domněnka ze jmen samotných.
//   - Subscription 'TRIAL'     <-> TenantPlan 'ACTIVE'        -- UNRESOLVED
//     mapping (TRIAL nemá přímý ekvivalent v TenantPlan enum). Jose zadal
//     fail-safe pro nejisté případy, TRIAL proto vrací `false`
//     (nekonzistentní/neověřitelné), NE `true` -- i když komentář v
//     zadání zmiňuje TRIAL jako "pořád aktivní tenant", tahle funkce
//     nedomýšlí a raději signalizuje "nelze potvrdit" než tichou shodu.
//   - TenantPlan 'SUSPENDED' proti JAKÉMUKOLIV Subscription stavu --
//     NENÍ jednoznačně mapovatelné, vrací `false` vždy.

import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import { evaluateTransition, type TransitionResult } from '../../core/state-machine/StateMachine.js';
import { SUBSCRIPTION_LIFECYCLE_DEFINITION, type SubscriptionLifecycleState } from '../../core/canonical/entities/Billing.js';
import type { PlanTier } from '../../core/tenant/types.js';

/** Zdroj pravdy pro platné PlanTier hodnoty -- core/tenant/types.ts union, žádná duplicitní enum. */
const VALID_PLAN_TIERS: readonly PlanTier[] = ['STARTER', 'GROWTH', 'ENTERPRISE', 'CUSTOM'];

/** TenantPlan.status union -- ZRCADLENO z core/tenant/types.ts (ne re-export, ať tenhle soubor nemusí importovat celý TenantPlan interface jen kvůli jednomu poli). */
type TenantPlanStatus = 'ACTIVE' | 'GRACE_PERIOD' | 'SUSPENDED' | 'CANCELED';

/**
 * Konzistenční kontrola Subscription.status <-> TenantPlan.status --
 * ROZHODNUTO (Jose 2026-09-05, bod 5), viz komentář nahoře pro mapování
 * a UNRESOLVED zbytky (TRIAL, GRACE_PERIOD nejistota). Čistá funkce, žádné
 * I/O, nepřepisuje žádný stav -- jen odpovídá ANO/NE.
 */
export function isConsistentWithTenantPlan(
    subscriptionStatus: SubscriptionLifecycleState,
    tenantPlanStatus: TenantPlanStatus
): boolean {
    switch (subscriptionStatus) {
        case 'ACTIVE':
            return tenantPlanStatus === 'ACTIVE';
        case 'CANCELLED':
            return tenantPlanStatus === 'CANCELED';
        case 'PAST_DUE':
            // Nejlepší dostupné odvození, ne jistota -- viz UNRESOLVED komentář nahoře.
            return tenantPlanStatus === 'GRACE_PERIOD';
        case 'TRIAL':
            // UNRESOLVED mapping -- fail-safe, TRIAL nikdy nevrací true.
            return false;
        default: {
            const exhaustiveCheck: never = subscriptionStatus;
            return exhaustiveCheck;
        }
    }
}

export interface SubscriptionLifecycleRuleInput {
    readonly currentStatus: SubscriptionLifecycleState;
    readonly targetStatus: SubscriptionLifecycleState;
    readonly planTier: PlanTier;
}

export interface SubscriptionLifecycleRuleResult {
    readonly allowed: boolean;
    readonly reason?: string;
    readonly transition: TransitionResult<SubscriptionLifecycleState>;
}

export class SubscriptionLifecycleRule implements Rule<SubscriptionLifecycleRuleInput, SubscriptionLifecycleRuleResult> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: SubscriptionLifecycleRuleInput): SubscriptionLifecycleRuleResult {
        // planTier validace MÁ PŘEDNOST před lifecycle vyhodnocením --
        // neplatný tier je konfigurační chyba nezávislá na požadovaném
        // přechodu, nemá smysl ji maskovat lifecycle výsledkem.
        if (!VALID_PLAN_TIERS.includes(input.planTier)) {
            const reason = `Invalid planTier "${input.planTier}" -- must be one of: ${VALID_PLAN_TIERS.join(', ')}`;
            return {
                allowed: false,
                reason,
                transition: { allowed: false, fromState: input.currentStatus, toState: input.targetStatus, reason },
            };
        }

        const transition = evaluateTransition(SUBSCRIPTION_LIFECYCLE_DEFINITION, input.currentStatus, input.targetStatus);

        return {
            allowed: transition.allowed,
            reason: transition.reason,
            transition,
        };
    }
}
