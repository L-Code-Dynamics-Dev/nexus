// RoundingRule -- první policy migrovaná pod Nexus Rule contract (viz
// MIGRATION_PLAN.md Fáze 1: LEGACY POLICY -> NEXUS RULE CONTRACT ->
// NEXUS IMPLEMENTACE -> REGRESSION FIXTURES -> POROVNÁNÍ S LEGACY).
//
// 1:1 s legacy RoundingPolicy (connectors/pricing-engine/legacy/policies/
// RoundingPolicy.ts): zaokrouhlí na 2 desetinná místa, pokud se hodnota
// mění. Žádná změna chování -- ověřeno proti legacy referenci v
// tests/regression/golden-pricing/rounding-rule-parity.test.ts.

import Decimal from 'decimal.js';
import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';

export interface RoundingRuleInput {
    readonly currentPrice: Decimal;
}

export interface RoundingRuleResult {
    readonly finalPrice: Decimal;
    /** true, pokud zaokrouhlení hodnotu skutečně změnilo (legacy: SET_PRICE command byl vydán). */
    readonly applied: boolean;
}

export class RoundingRule implements Rule<RoundingRuleInput, RoundingRuleResult> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: RoundingRuleInput): RoundingRuleResult {
        const rounded = input.currentPrice.toDecimalPlaces(2);
        return {
            finalPrice: rounded,
            applied: !rounded.equals(input.currentPrice),
        };
    }
}
