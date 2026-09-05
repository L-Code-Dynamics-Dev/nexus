// CampaignLifecycleRule -- Fáze 6.2 business rule nad Fáze 6.1 kostrou
// (core/canonical/entities/Campaign.ts). Josovo zadání: "pravidla přechodů
// DRAFT -> ACTIVE -> PAUSED -> ENDED" + "validace, že Campaign nelze
// aktivovat bez potřebných vazeb".
//
// Kombinuje evaluateTransition() (obecná dovolenost přechodu na
// CAMPAIGN_LIFECYCLE_DEFINITION ose) s jediným doménovým invariantem,
// který lze doslovně odvodit ze zadání: DRAFT -> ACTIVE vyžaduje alespoň
// jednu PromoGroup (kampaň bez PromoGroup nemá co propagovat).
//
// UNRESOLVED (Jose: "pokud nejde jednoznačně odvodit, neimplementuj a
// označ UNRESOLVED"): "explicitní pravidla pro aktivní/pozastavenou/
// ukončenou kampaň" -- zadání neuvádí KONKRÉTNÍ chování (např. co přesně
// PAUSED dělá jinak než ACTIVE, jaké invarianty ENDED vynucuje navíc mimo
// terminalitu, kterou už řeší evaluateTransition()). Bez konkrétní
// specifikace by cokoliv navíc byla domněnka -- neimplementováno, čeká na
// upřesnění.

import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import type { CampaignLifecycleState } from '../../core/canonical/entities/Campaign.js';
import { CAMPAIGN_LIFECYCLE_DEFINITION } from '../../core/canonical/entities/Campaign.js';
import { evaluateTransition } from '../../core/state-machine/StateMachine.js';

export interface CampaignLifecycleRuleInput {
    readonly currentStatus: CampaignLifecycleState;
    readonly targetStatus: CampaignLifecycleState;
    /** Campaign.promoGroupIds -- vyžadováno pro DRAFT -> ACTIVE validaci. */
    readonly promoGroupIds: readonly string[];
}

export interface CampaignLifecycleRuleResult {
    readonly allowed: boolean;
    readonly reason?: string;
}

export class CampaignLifecycleRule implements Rule<CampaignLifecycleRuleInput, CampaignLifecycleRuleResult> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: CampaignLifecycleRuleInput): CampaignLifecycleRuleResult {
        const transition = evaluateTransition(
            CAMPAIGN_LIFECYCLE_DEFINITION,
            input.currentStatus,
            input.targetStatus
        );

        if (!transition.allowed) {
            return { allowed: false, reason: transition.reason };
        }

        // Doménový invariant navíc (Jose): aktivace (přechod DO ACTIVE)
        // vyžaduje alespoň jednu PromoGroup -- kampaň bez PromoGroup nemá
        // co propagovat. Kontrola se týká JEN cílového stavu ACTIVE, ne
        // obecně "je Campaign platná" -- PAUSED->ACTIVE prochází stejnou
        // kontrolou jako DRAFT->ACTIVE (obě jsou přechody DO ACTIVE).
        if (input.targetStatus === 'ACTIVE' && input.promoGroupIds.length === 0) {
            return {
                allowed: false,
                reason: 'Campaign nelze aktivovat bez alespoň jedné PromoGroup (promoGroupIds je prázdné)',
            };
        }

        return { allowed: true };
    }
}
