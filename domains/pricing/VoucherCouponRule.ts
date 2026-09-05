// VoucherCouponRule -- migrace VoucherCouponPolicy ("L-Code Pricing
// Engine(API) doplněk Shoptet", src/core/policies/VoucherCouponPolicy.ts)
// pod Nexus Rule contract. Fáze 1 pokračování (docs/MIGRATION_PLAN.md:
// "Z Desktop Pricing Engine přenést navíc VoucherCouponPolicy (VOUCHER vs
// COUPON distinkce, nemá ekvivalent v okfish)").
//
// Zachováno 1:1 -- žádná nová business logika, jen Rule contract obal:
//   VOUCHER: dárkový poukaz = platidlo, aplikuje se na CELÝ košík bez
//            ohledu na sale/VIP stav položek.
//   COUPON:  slevový kód, respektuje allowOnSaleItems -- pokud false,
//            vylučuje již zlevněné položky (isOnSale/hasVipDiscount/
//            unitPrice < standardUnitPrice) ze základu výpočtu.
//
// POZOR: toto je JINÁ eligibility vrstva než CouponPolicyRule.ts (ta řeší
// per-tier/product limit eligibility, tahle řeší VOUCHER vs COUPON
// aplikaci na položky košíku) -- obě jsou samostatné, paralelní k
// PricingEngine chainu (BasePrice->HighestDiscount->DiscountLimit->
// Rounding), ne jeho součást. Napojení do createNexusPricingCalculator je
// záměrně mimo scope této migrace, stejně jako u CouponPolicyRule.

import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import {
    VoucherCouponPolicy,
    type CodeDefinition,
    type CartItemInput,
    type CouponEvaluationResult,
} from '../../connectors/pricing-engine/legacy/voucher/VoucherCouponPolicy.js';

export interface VoucherCouponRuleInput {
    readonly codeDef: CodeDefinition;
    readonly items: readonly CartItemInput[];
}

export class VoucherCouponRule implements Rule<VoucherCouponRuleInput, CouponEvaluationResult> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: VoucherCouponRuleInput): CouponEvaluationResult {
        return VoucherCouponPolicy.evaluateCode(input.codeDef, input.items as CartItemInput[]);
    }
}

export type { CodeDefinition, CodeType, CartItemInput, CouponEvaluationResult } from '../../connectors/pricing-engine/legacy/voucher/VoucherCouponPolicy.js';
