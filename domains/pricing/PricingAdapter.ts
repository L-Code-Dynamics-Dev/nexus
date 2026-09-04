// PricingAdapter -- obaluje legacy Pricing Engine, nepřepisuje ho.
// Legacy Pricing Engine -> PricingAdapter -> Nexus Pricing Contract
// Ownership pravidel se postupně přesune do Nexusu; legacy zůstává
// referenční, dokud tento adapter nedosáhne parity (viz MIGRATION_PLAN.md).

import Decimal from 'decimal.js';
import type { PricingComputationInput } from '../../core/canonical/entities/Price.js';
import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import type { Decision } from '../../core/canonical/rules/Decision.js';

export interface PricingRuleResult {
    readonly finalPrice: Decimal;
    readonly appliedRules: string[];
    readonly rejected: boolean;
    readonly rejectReason?: string;
}

/**
 * Nexus-side Rule, deleguje výpočet na legacy PricingEngine (injektováno,
 * ne re-implementováno). Zachovává: HighestDiscountPolicy,
 * DiscountLimitPolicy (Product->Brand->Category), RoundingPolicy,
 * Decimal aritmetika -- to vše je LEGACY, nemigrováno, jen obaleno.
 */
export class PricingAdapter implements Rule<PricingComputationInput, PricingRuleResult> {
    constructor(
        public readonly context: RuleContext,
        private readonly legacyCalculatePrice: (input: {
            sku: string;
            basePrice: Decimal;
            salePrice?: Decimal;
            productMaxDiscount?: Decimal;
        }) => { finalPrice: Decimal; appliedRules: { rule: string }[]; rejected: boolean; rejectReason?: string }
    ) {}

    evaluate(input: PricingComputationInput): PricingRuleResult {
        const legacyResult = this.legacyCalculatePrice({
            sku: input.productSku,
            basePrice: input.basePrice.amount,
            salePrice: input.salePrice?.amount,
            productMaxDiscount: input.productMaxDiscount !== undefined
                ? new Decimal(input.productMaxDiscount)
                : undefined,
        });

        return {
            finalPrice: legacyResult.finalPrice,
            appliedRules: legacyResult.appliedRules.map((r) => r.rule),
            rejected: legacyResult.rejected,
            rejectReason: legacyResult.rejectReason,
        };
    }

    toDecision(result: PricingRuleResult, inputReference: string, fingerprint: string): Omit<Decision<PricingRuleResult>, keyof import('../../core/canonical/entities/base.js').CanonicalEntity> {
        return {
            ruleId: this.context.ruleId,
            ruleVersion: this.context.ruleVersion,
            inputReference,
            result,
            reason: result.rejected
                ? (result.rejectReason ?? 'rejected')
                : `applied: ${result.appliedRules.join(', ')}`,
            fingerprint,
        };
    }
}
