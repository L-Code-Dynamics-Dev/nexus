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
//   - UNRESOLVED: přesný vztah Subscription.status <-> TenantPlan.status
//     zůstává neřešen (viz Billing.ts Open Question #1) -- Jose zadal jen
//     "respektuj existující Tenant/Plan model", ne konkrétní syncing
//     pravidlo mezi oběma stavy. Rule proto NEČTE ani nevaliduje
//     TenantPlan.status vůbec, jen Subscription.planTier členství.
//
// Invoice/Order oddělenost je u tohoto souboru vynucena STRUKTURÁLNĚ (Rule
// nemá žádný Invoice/Order import/typ ve svém vstupu) a otestována v
// tests/unit/BillingRules.test.ts jako typový invariant na Subscription
// samotné -- není to něco, co by tahle Rule musela "hlídat" za běhu.

import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import { evaluateTransition, type TransitionResult } from '../../core/state-machine/StateMachine.js';
import { SUBSCRIPTION_LIFECYCLE_DEFINITION, type SubscriptionLifecycleState } from '../../core/canonical/entities/Billing.js';
import type { PlanTier } from '../../core/tenant/types.js';

/** Zdroj pravdy pro platné PlanTier hodnoty -- core/tenant/types.ts union, žádná duplicitní enum. */
const VALID_PLAN_TIERS: readonly PlanTier[] = ['STARTER', 'GROWTH', 'ENTERPRISE', 'CUSTOM'];

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
