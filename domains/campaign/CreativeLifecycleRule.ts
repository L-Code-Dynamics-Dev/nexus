// CreativeLifecycleRule -- Fáze 6.2 business rule nad Fáze 6.1 kostrou
// (core/canonical/entities/Campaign.ts Creative). Josovo zadání:
// "DRAFT -> PUBLISHED -> ARCHIVED" + "publikovat lze pouze validní
// Creative" + "archivovaný Creative nelze znovu použít jako aktivní
// obsah bez explicitního nového lifecycle pravidla".
//
// Doménový invariant navíc (Jose): DRAFT -> PUBLISHED vyžaduje neprázdný
// `content` -- jediný invariant odvoditelný z existujícího Creative typu
// bez domýšlení (žádný jiný povinný atribut typ definuje).
//
// ARCHIVED -> PUBLISHED zákaz NENÍ nové pravidlo v tomto souboru --
// CREATIVE_LIFECYCLE_DEFINITION už má ARCHIVED jako terminální stav
// (transitions.ARCHIVED = []), evaluateTransition() ho tedy odmítne sám.
// Tato Rule tenhle výsledek jen RESPEKTUJE (nedomýšlí žádnou výjimku,
// needeleguje na jiné pravidlo, co by terminalitu obcházelo).

import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import type { CreativeLifecycleState } from '../../core/canonical/entities/Campaign.js';
import { CREATIVE_LIFECYCLE_DEFINITION } from '../../core/canonical/entities/Campaign.js';
import { evaluateTransition } from '../../core/state-machine/StateMachine.js';

export interface CreativeLifecycleRuleInput {
    readonly currentStatus: CreativeLifecycleState;
    readonly targetStatus: CreativeLifecycleState;
    /** Creative.content -- vyžadováno pro DRAFT -> PUBLISHED validaci. */
    readonly content: string;
}

export interface CreativeLifecycleRuleResult {
    readonly allowed: boolean;
    readonly reason?: string;
}

export class CreativeLifecycleRule implements Rule<CreativeLifecycleRuleInput, CreativeLifecycleRuleResult> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: CreativeLifecycleRuleInput): CreativeLifecycleRuleResult {
        const transition = evaluateTransition(
            CREATIVE_LIFECYCLE_DEFINITION,
            input.currentStatus,
            input.targetStatus
        );

        if (!transition.allowed) {
            // Zahrnuje i ARCHIVED -> PUBLISHED (terminální stav) -- žádná
            // výjimka zde, evaluateTransition() rozhoduje, Rule respektuje.
            return { allowed: false, reason: transition.reason };
        }

        // Doménový invariant navíc (Jose): publikovat lze pouze validní
        // Creative -- neprázdný content je jediný invariant odvoditelný
        // z existujícího typu.
        if (input.targetStatus === 'PUBLISHED' && input.content.trim().length === 0) {
            return {
                allowed: false,
                reason: 'Creative nelze publikovat s prázdným content',
            };
        }

        return { allowed: true };
    }
}
