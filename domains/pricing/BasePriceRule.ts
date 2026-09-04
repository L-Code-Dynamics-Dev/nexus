// BasePriceRule -- migrace legacy BasePricePolicy (connectors/pricing-engine/
// legacy/policies/BasePricePolicy.ts) pod Nexus Rule contract. Paty a
// posledni krok migrace jednotlivych policies (MIGRATION_PLAN.md) --
// uzavira cely chain BasePrice -> HighestDiscount -> DiscountLimit -> Rounding.
//
// 1:1 legacy: vzdy nastavi currentPrice na basePrice. Zadna podminka,
// zadne "vylepseni".

import Decimal from 'decimal.js';
import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';

export interface BasePriceRuleInput {
    readonly basePrice: Decimal;
}

export interface BasePriceRuleResult {
    readonly applied: true;
    readonly price: Decimal;
    readonly rule: 'BASE_PRICE';
}

export class BasePriceRule implements Rule<BasePriceRuleInput, BasePriceRuleResult> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: BasePriceRuleInput): BasePriceRuleResult {
        return { applied: true, price: input.basePrice, rule: 'BASE_PRICE' };
    }
}
