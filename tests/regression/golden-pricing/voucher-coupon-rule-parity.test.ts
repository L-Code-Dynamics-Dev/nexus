// Regresní parita VoucherCouponRule vs. legacy VoucherCouponPolicy
// ("L-Code Pricing Engine(API) doplněk Shoptet", tests/voucher_policy.test.ts)
// -- ověřuje, že Rule contract obal nezměnil žádné chování oproti
// originálu. Sada testů 1:1 přenesena, plus parity assertion navíc.

import { describe, it, expect } from 'vitest';
import { VoucherCouponRule } from '../../../domains/pricing/VoucherCouponRule.js';
import { VoucherCouponPolicy, type CodeDefinition, type CartItemInput } from '../../../connectors/pricing-engine/legacy/voucher/VoucherCouponPolicy.js';

describe('VoucherCouponRule — parity with legacy VoucherCouponPolicy', () => {
    const rule = new VoucherCouponRule({ tenantId: 'ten_1', ruleId: 'voucher-coupon-v1', ruleVersion: '1' });

    const sampleCartItems: CartItemInput[] = [
        { sku: 'REGULAR-1', unitPrice: 100, standardUnitPrice: 100, quantity: 1, isOnSale: false, hasVipDiscount: false },
        { sku: 'SALE-1', unitPrice: 80, standardUnitPrice: 100, quantity: 1, isOnSale: true, hasVipDiscount: false },
        { sku: 'VIP-1', unitPrice: 90, standardUnitPrice: 100, quantity: 1, isOnSale: false, hasVipDiscount: true },
    ];

    it('Gift Voucher applies as prepaid asset to ALL cart items including sale and VIP', () => {
        const voucher: CodeDefinition = {
            code: 'GIFT50',
            type: 'VOUCHER',
            value: 50,
            isPercentage: false,
            allowOnSaleItems: false, // Gift Vouchers ignore this and apply to entire cart
        };

        const result = rule.evaluate({ codeDef: voucher, items: sampleCartItems });
        const legacyResult = VoucherCouponPolicy.evaluateCode(voucher, sampleCartItems);

        expect(result).toEqual(legacyResult);
        expect(result.type).toBe('VOUCHER');
        expect(result.applicableDiscountTotal).toBe(50);
        expect(result.eligibleItemSkus).toEqual(['REGULAR-1', 'SALE-1', 'VIP-1']);
        expect(result.excludedItemSkus).toEqual([]);
    });

    it('Discount Coupon with allowOnSaleItems=false ONLY applies to regular non-discounted items', () => {
        const coupon: CodeDefinition = {
            code: 'COUPON10PCT',
            type: 'COUPON',
            value: 10, // 10%
            isPercentage: true,
            allowOnSaleItems: false,
        };

        const result = rule.evaluate({ codeDef: coupon, items: sampleCartItems });
        const legacyResult = VoucherCouponPolicy.evaluateCode(coupon, sampleCartItems);

        expect(result).toEqual(legacyResult);
        expect(result.type).toBe('COUPON');
        // Total subtotal of eligible items = 100 (REGULAR-1 only)
        // 10% of 100 = 10 EUR discount
        expect(result.applicableDiscountTotal).toBe(10);
        expect(result.eligibleItemSkus).toEqual(['REGULAR-1']);
        expect(result.excludedItemSkus).toEqual(['SALE-1', 'VIP-1']);
    });

    it('Discount Coupon fails gracefully if cart contains ONLY sale/VIP items', () => {
        const coupon: CodeDefinition = {
            code: 'COUPON10PCT',
            type: 'COUPON',
            value: 10,
            isPercentage: true,
            allowOnSaleItems: false,
        };

        const saleOnlyCart: CartItemInput[] = [
            { sku: 'SALE-1', unitPrice: 80, standardUnitPrice: 100, quantity: 1, isOnSale: true, hasVipDiscount: false },
        ];

        const result = rule.evaluate({ codeDef: coupon, items: saleOnlyCart });
        const legacyResult = VoucherCouponPolicy.evaluateCode(coupon, saleOnlyCart);

        expect(result).toEqual(legacyResult);
        expect(result.applicableDiscountTotal).toBe(0);
        expect(result.eligibleItemSkus).toEqual([]);
        expect(result.excludedItemSkus).toEqual(['SALE-1']);
        expect(result.message).toContain('nelze uplatnit');
    });

    it('Discount Coupon allowOnSaleItems=true includes already-discounted items', () => {
        const coupon: CodeDefinition = {
            code: 'ALLIN10',
            type: 'COUPON',
            value: 10,
            isPercentage: true,
            allowOnSaleItems: true,
        };

        const result = rule.evaluate({ codeDef: coupon, items: sampleCartItems });
        const legacyResult = VoucherCouponPolicy.evaluateCode(coupon, sampleCartItems);

        expect(result).toEqual(legacyResult);
        expect(result.eligibleItemSkus).toEqual(['REGULAR-1', 'SALE-1', 'VIP-1']);
        expect(result.excludedItemSkus).toEqual([]);
    });

    it('Fixed-amount COUPON never discounts more than the eligible subtotal', () => {
        const coupon: CodeDefinition = {
            code: 'FIXED500',
            type: 'COUPON',
            value: 500,
            isPercentage: false,
            allowOnSaleItems: false,
        };

        const result = rule.evaluate({ codeDef: coupon, items: sampleCartItems });
        const legacyResult = VoucherCouponPolicy.evaluateCode(coupon, sampleCartItems);

        expect(result).toEqual(legacyResult);
        // Eligible subtotal = 100 (REGULAR-1 only) -- fixed 500 clamps to it
        expect(result.applicableDiscountTotal).toBe(100);
    });

    it('VOUCHER value never exceeds cart total (clamped, never goes negative)', () => {
        const voucher: CodeDefinition = {
            code: 'GIFT1000',
            type: 'VOUCHER',
            value: 1000,
            isPercentage: false,
            allowOnSaleItems: false,
        };

        const result = rule.evaluate({ codeDef: voucher, items: sampleCartItems });
        const legacyResult = VoucherCouponPolicy.evaluateCode(voucher, sampleCartItems);

        expect(result).toEqual(legacyResult);
        // Cart total = 100 + 80 + 90 = 270
        expect(result.applicableDiscountTotal).toBe(270);
    });

    it('is a pure function — same input always yields same output (determinism requirement, Rule.ts)', () => {
        const coupon: CodeDefinition = {
            code: 'COUPON10PCT',
            type: 'COUPON',
            value: 10,
            isPercentage: true,
            allowOnSaleItems: false,
        };
        const input = { codeDef: coupon, items: sampleCartItems };
        const first = rule.evaluate(input);
        const second = rule.evaluate(input);
        expect(first).toEqual(second);
    });
});
