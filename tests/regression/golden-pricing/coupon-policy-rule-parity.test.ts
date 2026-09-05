import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { CouponPolicyRule } from '../../../domains/pricing/CouponPolicyRule.js';
import { CouponPolicy } from '../../../connectors/pricing-engine/legacy/coupon/CouponPolicy.js';
import type { CouponPolicyInput } from '../../../connectors/pricing-engine/legacy/coupon/types.js';

const legacyPolicy = new CouponPolicy();
const rule = new CouponPolicyRule({ tenantId: 'ten_1', ruleId: 'coupon-policy-v1', ruleVersion: '1' });

describe('CouponPolicyRule parity vs legacy CouponPolicy', () => {
    const scenarios: { name: string; input: CouponPolicyInput }[] = [
        {
            name: 'Rule 4: locked tier ZR20 -> no coupon, absolute precedence even with room',
            input: { productDiscount: new Decimal(0), customerTierDiscount: new Decimal(0), customerTier: 'ZR20' },
        },
        {
            name: 'Rule 4: locked tier ZR25 with productMaxDiscount undefined -> no coupon',
            input: { productDiscount: new Decimal(0.05), customerTierDiscount: new Decimal(0.1), customerTier: 'ZR25' },
        },
        {
            name: 'Rule 1: productMaxDiscount exactly 0 -> no coupon',
            input: { productDiscount: new Decimal(0), customerTierDiscount: new Decimal(0), productMaxDiscount: new Decimal(0) },
        },
        {
            name: 'Rule 2: productMaxDiscount below standard limit -> coupon fills remaining room',
            input: { productDiscount: new Decimal(0.05), customerTierDiscount: new Decimal(0), productMaxDiscount: new Decimal(0.1) },
        },
        {
            name: 'Rule 2: productMaxDiscount below standard, but already at product limit -> no coupon',
            input: { productDiscount: new Decimal(0.1), customerTierDiscount: new Decimal(0), productMaxDiscount: new Decimal(0.1) },
        },
        {
            name: 'Rule 3: productDiscount already at standard limit -> no coupon',
            input: { productDiscount: new Decimal(0.2), customerTierDiscount: new Decimal(0) },
        },
        {
            name: 'Rule 3: productDiscount above standard limit -> no coupon',
            input: { productDiscount: new Decimal(0.3), customerTierDiscount: new Decimal(0) },
        },
        {
            name: 'Rule 5: standard case, no discounts yet -> full standard limit as coupon room',
            input: { productDiscount: new Decimal(0), customerTierDiscount: new Decimal(0) },
        },
        {
            name: 'Rule 5: customerTierDiscount higher than productDiscount -> uses tier discount',
            input: { productDiscount: new Decimal(0.02), customerTierDiscount: new Decimal(0.15) },
        },
        {
            name: 'unlocked tier (not ZR20/ZR25) does not trigger Rule 4',
            input: { productDiscount: new Decimal(0), customerTierDiscount: new Decimal(0.04), customerTier: 'ZR4' },
        },
    ];

    for (const s of scenarios) {
        it(`matches legacy for scenario: ${s.name}`, () => {
            const legacy = legacyPolicy.decide(s.input);
            const nexus = rule.evaluate(s.input);
            expect(nexus.applyDiscountCoupon).toBe(legacy.applyDiscountCoupon);
            expect(nexus.maxDiscount.toString()).toBe(legacy.maxDiscount.toString());
        });
    }

    it('custom standardLimit/lockedTiers override matches equivalent direct CouponPolicy construction', () => {
        const customLimit = new Decimal(0.3);
        const customLockedTiers = new Set(['ZR10']);
        const input: CouponPolicyInput = { productDiscount: new Decimal(0), customerTierDiscount: new Decimal(0), customerTier: 'ZR10' };

        const legacyCustom = new CouponPolicy(customLimit, customLockedTiers);
        const legacy = legacyCustom.decide(input);
        const nexus = rule.evaluate({ ...input, standardLimit: customLimit, lockedTiers: customLockedTiers });

        expect(nexus.applyDiscountCoupon).toBe(legacy.applyDiscountCoupon);
        expect(nexus.maxDiscount.toString()).toBe(legacy.maxDiscount.toString());
    });
});
