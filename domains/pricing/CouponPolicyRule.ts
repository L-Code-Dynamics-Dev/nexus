// CouponPolicyRule -- migrace legacy CouponPolicy (connectors/
// pricing-engine/legacy/coupon/CouponPolicy.ts) pod Nexus Rule contract.
// Fáze 1 pokračování (docs/MIGRATION_PLAN.md zmiňuje "Z Desktop Pricing
// Engine přenést navíc VoucherCouponPolicy" -- toto je okfish verze
// coupon-eligibility vrstvy, samostatná od PricingEngine pipeline).
//
// Zachováno 1:1 vcetne poradi pravidel (Rule 4 ma absolutni prednost):
//   Rule 4: locked tier (ZR20/ZR25 vychozi) -> NIKDY kupon, bez vyjimky
//   Rule 1: productMaxDiscount === 0 -> zadny kupon
//   Rule 2: productMaxDiscount < standardLimit -> zbytek do product limitu
//   Rule 3: productDiscount >= standardLimit -> zadny kupon
//   Rule 5: standardni pripad -> zbytek do standardLimit
//
// POZOR: toto NENI soucast PricingEngine chainu (BasePrice->HighestDiscount
// ->DiscountLimit->Rounding) -- je to samostatna, paralelni eligibility
// vrstva. Napojeni do createNexusPricingCalculator je zamerne mimo scope
// teto migrace (stejne jako v legacy -- "Wiring this into EngineBuilder/
// Worker is a deliberate later step").

import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import { CouponPolicy } from '../../connectors/pricing-engine/legacy/coupon/CouponPolicy.js';
import type { CouponPolicyInput, CouponPolicyResult } from '../../connectors/pricing-engine/legacy/coupon/types.js';
import Decimal from 'decimal.js';

export interface CouponPolicyRuleInput extends CouponPolicyInput {
    readonly standardLimit?: Decimal;
    readonly lockedTiers?: Set<string>;
}

export class CouponPolicyRule implements Rule<CouponPolicyRuleInput, CouponPolicyResult> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: CouponPolicyRuleInput): CouponPolicyResult {
        const policy = new CouponPolicy(input.standardLimit, input.lockedTiers);
        return policy.decide(input);
    }
}
