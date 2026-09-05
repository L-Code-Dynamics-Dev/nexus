// OutcomeEngineRule -- migrace legacy outcome-engine.ts (connectors/
// safeorder/legacy/learning/outcome-engine.ts) pod Nexus Rule contract.
// Fáze 2 (docs/MIGRATION_PLAN.md).
//
// POZOR K NÁZVU: MIGRATION_PLAN.md nazývá tento modul "outcome learning" /
// "outcome-tracker", ale skutečný soubor v repu se jmenuje
// core/learning/outcome-engine.ts -- žádný soubor jménem "outcome-tracker"
// neexistuje. Tento modul zůstává pojmenovaný podle skutečného zdroje.
//
// Zachováno 1:1: invariant RESTRICTED != BAD CUSTOMER (UNKNOWN_COUNTERFACTUAL
// výsledky se vylučují z trénovacích dat), false-positive rate (RESTRICT/
// REVIEW rozhodnutí, co skončilo MERCHANT_OVERRIDE_SUCCESS nebo
// DELIVERED_SUCCESS), rto-catch-rate (kolik skutečných RTO bylo zachyceno
// přes RESTRICT), a adaptivní úprava vah (fp rate > 1.5% snižuje
// uncollectedWeightMultiplier a zvyšuje suppression faktor, fp rate < 0.3%
// a catch rate < 90% naopak zvyšuje multiplier). Žádná re-implementace.

import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import { computeAdaptiveWeights, type OutcomeRecord, type LearningWeights } from '../../connectors/safeorder/legacy/learning/outcome-engine.js';

export interface OutcomeEngineRuleInput {
    readonly outcomes: OutcomeRecord[];
    readonly baseWeights?: LearningWeights;
}

export interface OutcomeEngineRuleResult {
    readonly updatedWeights: LearningWeights;
    readonly falsePositiveRate: number;
    readonly rtoCatchRate: number;
    readonly learningSignalsProcessed: number;
    readonly counterfactualsExcludedCount: number;
}

export class OutcomeEngineRule implements Rule<OutcomeEngineRuleInput, OutcomeEngineRuleResult> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: OutcomeEngineRuleInput): OutcomeEngineRuleResult {
        return input.baseWeights !== undefined
            ? computeAdaptiveWeights(input.outcomes, input.baseWeights)
            : computeAdaptiveWeights(input.outcomes);
    }
}
