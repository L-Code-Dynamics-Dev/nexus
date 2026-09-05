// SortingRule -- migrace legacy SortingPipeline (connectors/
// availability-intelligence/legacy/ranking/SortingPipeline.ts) pod
// Nexus Rule contract. Fáze 3 (docs/MIGRATION_PLAN.md).
//
// 1:1 s legacy: primary=score, secondary=baseSortPriority,
// tertiary=relevanceScore, deterministic fallback=productId (alfa).
// Vstup/výstup pole beze změny -- ověřeno proti legacy referenci v
// tests/regression/availability/availability-sales-units-parity.test.ts.

import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import type { AvailabilityResult } from '../../connectors/availability-intelligence/legacy/availability/types.js';

export interface SortingRuleInput {
    readonly results: readonly AvailabilityResult[];
}

export interface SortingRuleResult {
    readonly sorted: readonly AvailabilityResult[];
}

export class SortingRule implements Rule<SortingRuleInput, SortingRuleResult> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: SortingRuleInput): SortingRuleResult {
        const sorted = [...input.results].sort((a, b) => {
            if (b.score !== a.score) {
                return b.score - a.score;
            }
            if (b.baseSortPriority !== a.baseSortPriority) {
                return b.baseSortPriority - a.baseSortPriority;
            }
            if (b.relevanceScore !== a.relevanceScore) {
                return b.relevanceScore - a.relevanceScore;
            }
            return a.productId.localeCompare(b.productId);
        });
        return { sorted };
    }
}
