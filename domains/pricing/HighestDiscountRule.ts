// HighestDiscountRule -- migrace legacy HighestDiscountPolicy (connectors/
// pricing-engine/legacy/policies/HighestDiscountPolicy.ts) pod Nexus Rule
// contract. Ctvrty krok migracni sekvence po RoundingRule, ValidationRule,
// DiscountLimitRule (MIGRATION_PLAN.md).
//
// Zachovano 1:1 vcetne netrivialnich detailu:
//   1. `customerTier && allowLoyaltyDiscount` -- customerTier musi byt
//      truthy string, allowLoyaltyDiscount musi byt truthy (true).
//   2. `discountPercent` (loyaltyTiers[tier]) je zkontrolovan jako truthy --
//      protoze Decimal je vzdy truthy objekt v JS, jediny zpusob jak je
//      "falsy" je `undefined` (tier neni v mape). Decimal(0) v mape BY
//      proslo (loyaltyPrice = basePrice * (1-0) = basePrice), ale legacy
//      config nikdy 0% tier nedefinuje -- zachovavame chovani presne,
//      ne predpoklad o datech.
//   3. `if (salePrice && loyaltyPrice)` -- oboji testovano jako truthy,
//      ne `!== undefined` -- ale protoze Decimal je vzdy truthy, efekt
//      je stejny jako "oboji definovano".
//   4. Kdyz jsou OBE definovane: NIZSI vyhrava. Presna ROVNOST jde do
//      LOYALTY vetve (strict lessThan, ne <=) -- ne SALE.
//   5. Priorita: obe definovane -> porovnani; jen salePrice -> SALE;
//      jen loyaltyPrice -> LOYALTY; nic -> no-op.

import Decimal from 'decimal.js';
import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';

export interface HighestDiscountRuleInput {
    readonly basePrice: Decimal;
    readonly salePrice?: Decimal;
    readonly customerTier?: string;
    readonly allowLoyaltyDiscount?: boolean;
    readonly loyaltyTiers: Record<string, Decimal>;
}

export interface HighestDiscountRuleResult {
    readonly applied: boolean;
    readonly price?: Decimal;
    readonly rule?: 'SALE' | 'LOYALTY';
}

export class HighestDiscountRule implements Rule<HighestDiscountRuleInput, HighestDiscountRuleResult> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: HighestDiscountRuleInput): HighestDiscountRuleResult {
        const salePrice = input.salePrice;
        let loyaltyPrice: Decimal | undefined;

        if (input.customerTier && input.allowLoyaltyDiscount) {
            const discountPercent = input.loyaltyTiers[input.customerTier];
            if (discountPercent) {
                const one = new Decimal('1');
                loyaltyPrice = input.basePrice.mul(one.minus(discountPercent));
            }
        }

        if (salePrice && loyaltyPrice) {
            if (salePrice.lessThan(loyaltyPrice)) {
                return { applied: true, price: salePrice, rule: 'SALE' };
            } else {
                return { applied: true, price: loyaltyPrice, rule: 'LOYALTY' };
            }
        } else if (salePrice) {
            return { applied: true, price: salePrice, rule: 'SALE' };
        } else if (loyaltyPrice) {
            return { applied: true, price: loyaltyPrice, rule: 'LOYALTY' };
        }

        return { applied: false };
    }
}
