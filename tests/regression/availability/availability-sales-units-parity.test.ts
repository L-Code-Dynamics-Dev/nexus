// Parity testy: domains/availability/*Rule.ts vs skutečné legacy třídy
// v connectors/availability-intelligence/legacy/. Fáze 3
// (docs/MIGRATION_PLAN.md) -- žádné napojení na produkční kód, čistě
// ověření 1:1 shody chování.

import { describe, it, expect } from 'vitest';

import { AvailabilityRule } from '../../../domains/availability/AvailabilityRule.js';
import { AvailabilityEngine } from '../../../connectors/availability-intelligence/legacy/availability/AvailabilityEngine.js';
import { AvailabilityStatus } from '../../../connectors/availability-intelligence/legacy/availability/types.js';
import type { ProductAvailabilityInput, VariantAvailability } from '../../../connectors/availability-intelligence/legacy/availability/types.js';

import { SortingRule } from '../../../domains/availability/SortingRule.js';
import { SortingPipeline } from '../../../connectors/availability-intelligence/legacy/ranking/SortingPipeline.js';
import type { AvailabilityResult } from '../../../connectors/availability-intelligence/legacy/availability/types.js';

import { ToBaseQuantityRule, FromBaseQuantityRule } from '../../../domains/availability/ConversionRule.js';
import { ConversionEngine } from '../../../connectors/availability-intelligence/legacy/sales-units/ConversionEngine.js';

import { OrderQuantityValidationRule } from '../../../domains/availability/OrderQuantityValidationRule.js';
import { OrderQuantityValidator } from '../../../connectors/availability-intelligence/legacy/sales-units/OrderQuantityValidator.js';

import { PackagingDepositRule } from '../../../domains/availability/PackagingDepositRule.js';
import { PackagingDepositEngine } from '../../../connectors/availability-intelligence/legacy/sales-units/PackagingDepositEngine.js';

import { SalesUnitAvailabilityRule, NormaliseToProcurementDemandRule } from '../../../domains/availability/SalesUnitAvailabilityRule.js';
import { SalesUnitEngine } from '../../../connectors/availability-intelligence/legacy/sales-units/SalesUnitEngine.js';
import type { SalesUnit, PackagingDepositRule as PackagingDepositRuleConfig } from '../../../connectors/availability-intelligence/legacy/sales-units/types.js';

const ctx = { tenantId: 'ten_1', ruleVersion: '1' };

function variant(overrides: Partial<VariantAvailability>): VariantAvailability {
    return { id: 'v1', isPurchasable: true, inStock: false, ...overrides };
}

function product(overrides: Partial<ProductAvailabilityInput>): ProductAvailabilityInput {
    return { id: 'p1', variants: [], ...overrides };
}

describe('AvailabilityRule parity vs legacy AvailabilityEngine', () => {
    const rule = new AvailabilityRule({ ...ctx, ruleId: 'availability-v1' });

    const cases: { name: string; input: ProductAvailabilityInput; expectedStatus: AvailabilityStatus }[] = [
        { name: 'missing variants array -> UNKNOWN', input: { id: 'p1' } as ProductAvailabilityInput, expectedStatus: AvailabilityStatus.UNKNOWN },
        { name: 'empty variants -> UNKNOWN', input: product({ variants: [] }), expectedStatus: AvailabilityStatus.UNKNOWN },
        {
            name: 'all in stock (above threshold) -> IN_STOCK',
            input: product({ variants: [variant({ inStock: true, stockAmount: 50 }), variant({ inStock: true, stockAmount: 20 })] }),
            expectedStatus: AvailabilityStatus.IN_STOCK,
        },
        {
            name: 'all in stock but all at/below threshold -> LOW_STOCK',
            input: product({ variants: [variant({ inStock: true, stockAmount: 2 }), variant({ inStock: true, stockAmount: 3 })] }),
            expectedStatus: AvailabilityStatus.LOW_STOCK,
        },
        {
            name: 'mix of in-stock and low-stock -> LOW_STOCK (warning dominates)',
            input: product({ variants: [variant({ inStock: true, stockAmount: 50 }), variant({ inStock: true, stockAmount: 1 })] }),
            expectedStatus: AvailabilityStatus.LOW_STOCK,
        },
        {
            name: 'some in stock, some not purchasable -> PARTIALLY_AVAILABLE',
            input: product({ variants: [variant({ inStock: true, stockAmount: 50 }), variant({ isPurchasable: false })] }),
            expectedStatus: AvailabilityStatus.PARTIALLY_AVAILABLE,
        },
        {
            name: 'none in stock, some in transit -> IN_TRANSIT',
            input: product({ variants: [variant({ inStock: false, inTransit: true }), variant({ isPurchasable: false })] }),
            expectedStatus: AvailabilityStatus.IN_TRANSIT,
        },
        {
            name: 'none in stock/transit, some on order -> ON_ORDER',
            input: product({ variants: [variant({ inStock: false, onOrder: true }), variant({ isPurchasable: false })] }),
            expectedStatus: AvailabilityStatus.ON_ORDER,
        },
        {
            name: 'nothing available anywhere -> OUT_OF_STOCK',
            input: product({ variants: [variant({ isPurchasable: false }), variant({ isPurchasable: false })] }),
            expectedStatus: AvailabilityStatus.OUT_OF_STOCK,
        },
    ];

    for (const { name, input, expectedStatus } of cases) {
        it(name, () => {
            const legacy = AvailabilityEngine.evaluate(input);
            const nexus = rule.evaluate(input);

            expect(nexus.status).toBe(expectedStatus);
            expect(nexus.status).toBe(legacy.status);
            expect(nexus.score).toBe(legacy.score);
            expect(nexus.reason).toBe(legacy.reason);
            expect(nexus.productId).toBe(legacy.productId);
        });
    }
});

describe('SortingRule parity vs legacy SortingPipeline', () => {
    const rule = new SortingRule({ ...ctx, ruleId: 'sorting-v1' });

    function result(overrides: Partial<AvailabilityResult>): AvailabilityResult {
        return {
            productId: 'p1', status: AvailabilityStatus.IN_STOCK, score: 100, source: 'SYSTEM',
            timestamp: '2026-01-01T00:00:00Z', reason: '', baseSortPriority: 0, relevanceScore: 0,
            ...overrides,
        };
    }

    it('sorts by score desc, then baseSortPriority desc, then relevanceScore desc, then productId asc', () => {
        const input = [
            result({ productId: 'b', score: 50, baseSortPriority: 1, relevanceScore: 1 }),
            result({ productId: 'a', score: 100, baseSortPriority: 0, relevanceScore: 0 }),
            result({ productId: 'c', score: 100, baseSortPriority: 5, relevanceScore: 0 }),
            result({ productId: 'd', score: 100, baseSortPriority: 5, relevanceScore: 9 }),
        ];

        const legacy = SortingPipeline.sort(input);
        const nexus = rule.evaluate({ results: input });

        expect(nexus.sorted.map((r) => r.productId)).toEqual(legacy.map((r) => r.productId));
        expect(nexus.sorted.map((r) => r.productId)).toEqual(['d', 'c', 'a', 'b']);
    });

    it('deterministic tie-break by productId when everything else is equal', () => {
        const input = [result({ productId: 'z' }), result({ productId: 'a' }), result({ productId: 'm' })];
        const nexus = rule.evaluate({ results: input });
        expect(nexus.sorted.map((r) => r.productId)).toEqual(['a', 'm', 'z']);
    });

    it('does not mutate the input array (legacy uses spread copy)', () => {
        const input = [result({ productId: 'b', score: 1 }), result({ productId: 'a', score: 2 })];
        const inputCopy = [...input];
        rule.evaluate({ results: input });
        expect(input).toEqual(inputCopy);
    });
});

const sampleSalesUnit: SalesUnit = {
    id: 'su1', productId: 'p1', name: 'Pytel', code: 'BAG',
    baseQuantity: 10, baseUnit: 'PCS', weightPerBaseUnitGrams: 500,
    priceMultiplier: 1, minimumQuantity: 2, orderStep: 1, active: true,
};

describe('ConversionRule (toBaseQuantity/fromBaseQuantity) parity vs legacy ConversionEngine', () => {
    const toRule = new ToBaseQuantityRule({ ...ctx, ruleId: 'to-base-qty-v1' });
    const fromRule = new FromBaseQuantityRule({ ...ctx, ruleId: 'from-base-qty-v1' });

    it('toBaseQuantity: matches legacy for a valid positive integer quantity', () => {
        const legacy = ConversionEngine.toBaseQuantity(sampleSalesUnit, 3);
        const nexus = toRule.evaluate({ salesUnit: sampleSalesUnit, salesUnitQuantity: 3 });
        expect(nexus).toEqual(legacy);
    });

    it('toBaseQuantity: throws on non-integer salesUnitQuantity, matches legacy throw', () => {
        expect(() => toRule.evaluate({ salesUnit: sampleSalesUnit, salesUnitQuantity: 1.5 })).toThrow();
        expect(() => ConversionEngine.toBaseQuantity(sampleSalesUnit, 1.5)).toThrow();
    });

    it('toBaseQuantity: throws on zero/negative quantity', () => {
        expect(() => toRule.evaluate({ salesUnit: sampleSalesUnit, salesUnitQuantity: 0 })).toThrow();
    });

    it('fromBaseQuantity: matches legacy floor division', () => {
        const legacy = ConversionEngine.fromBaseQuantity(sampleSalesUnit, 25);
        const nexus = fromRule.evaluate({ salesUnit: sampleSalesUnit, baseQuantity: 25 });
        expect(nexus).toBe(legacy);
        expect(nexus).toBe(2);
    });

    it('fromBaseQuantity: zero base quantity -> zero sales units, matches legacy', () => {
        expect(fromRule.evaluate({ salesUnit: sampleSalesUnit, baseQuantity: 0 })).toBe(0);
    });

    it('fromBaseQuantity: throws on negative base quantity', () => {
        expect(() => fromRule.evaluate({ salesUnit: sampleSalesUnit, baseQuantity: -5 })).toThrow();
    });
});

describe('OrderQuantityValidationRule parity vs legacy OrderQuantityValidator', () => {
    const rule = new OrderQuantityValidationRule({ ...ctx, ruleId: 'order-qty-validation-v1' });

    const cases = [
        { name: 'inactive sales unit -> INACTIVE_SALES_UNIT', unit: { ...sampleSalesUnit, active: false }, qty: 10 },
        { name: 'below minimum -> BELOW_MINIMUM with suggestion', unit: sampleSalesUnit, qty: 1 },
        { name: 'invalid order step -> INVALID_ORDER_STEP with suggestion', unit: { ...sampleSalesUnit, minimumQuantity: 2, orderStep: 3 }, qty: 4 },
        { name: 'valid quantity -> valid true', unit: { ...sampleSalesUnit, minimumQuantity: 2, orderStep: 3 }, qty: 5 },
    ];

    for (const { name, unit, qty } of cases) {
        it(name, () => {
            const legacy = OrderQuantityValidator.validate(unit, qty);
            const nexus = rule.evaluate({ salesUnit: unit, requestedQuantity: qty });
            expect(nexus).toEqual(legacy);
        });
    }
});

describe('PackagingDepositRule parity vs legacy PackagingDepositEngine', () => {
    const rule = new PackagingDepositRule({ ...ctx, ruleId: 'packaging-deposit-v1' });

    const rules: PackagingDepositRuleConfig[] = [
        { id: 'r1', salesUnitId: 'su1', packagingType: 'EURO_PALLET', depositAmount: 15, currency: 'CZK', quantityPerSalesUnit: 1, refundable: true, active: true },
        { id: 'r2', salesUnitId: 'su1', packagingType: 'BOX', depositAmount: 2, currency: 'CZK', quantityPerSalesUnit: 4, refundable: false, active: false },
    ];

    it('matches legacy — active rules produce charges, inactive rules are skipped', () => {
        const legacy = PackagingDepositEngine.calculate(rules, 3);
        const nexus = rule.evaluate({ rules, salesUnitQuantity: 3 });
        expect(nexus).toEqual(legacy);
        expect(nexus).toHaveLength(1);
        expect(nexus[0]!.packagingType).toBe('EURO_PALLET');
    });

    it('throws on non-integer salesUnitQuantity, matches legacy', () => {
        expect(() => rule.evaluate({ rules, salesUnitQuantity: 1.2 })).toThrow();
        expect(() => PackagingDepositEngine.calculate(rules, 1.2)).toThrow();
    });
});

describe('SalesUnitAvailabilityRule + NormaliseToProcurementDemandRule parity vs legacy SalesUnitEngine', () => {
    const availRule = new SalesUnitAvailabilityRule({ ...ctx, ruleId: 'sales-unit-availability-v1' });
    const normRule = new NormaliseToProcurementDemandRule({ ...ctx, ruleId: 'normalise-procurement-demand-v1' });

    it('getAvailabilityBySalesUnit: matches legacy with pricing computed', () => {
        const input = { ownStockBaseQuantity: 25, salesUnits: [sampleSalesUnit], basePriceExVat: 10, vatRate: 0.21, currency: 'CZK' };
        const legacy = SalesUnitEngine.getAvailabilityBySalesUnit(input);
        const nexus = availRule.evaluate(input);
        expect(nexus).toEqual(legacy);
    });

    it('getAvailabilityBySalesUnit: matches legacy without pricing (basePriceExVat undefined)', () => {
        const input = { ownStockBaseQuantity: 25, salesUnits: [sampleSalesUnit] };
        const legacy = SalesUnitEngine.getAvailabilityBySalesUnit(input);
        const nexus = availRule.evaluate(input);
        expect(nexus).toEqual(legacy);
        expect(nexus[0]!.pricing).toBeUndefined();
    });

    it('getAvailabilityBySalesUnit: inactive sales unit is skipped, matches legacy', () => {
        const inactiveUnit = { ...sampleSalesUnit, active: false };
        const input = { ownStockBaseQuantity: 25, salesUnits: [inactiveUnit] };
        expect(availRule.evaluate(input)).toEqual(SalesUnitEngine.getAvailabilityBySalesUnit(input));
        expect(availRule.evaluate(input)).toHaveLength(0);
    });

    it('normaliseToProcurementDemand: matches legacy including deficit computation', () => {
        const legacy = SalesUnitEngine.normaliseToProcurementDemand(sampleSalesUnit, 3, 5);
        const nexus = normRule.evaluate({ salesUnit: sampleSalesUnit, salesUnitQuantity: 3, ownStockBaseQuantity: 5 });
        expect(nexus).toEqual(legacy);
        expect(nexus.deficit).toBe(25); // 3*10=30 needed, 5 in stock -> 25 deficit
    });

    it('normaliseToProcurementDemand: zero deficit when stock covers demand, matches legacy', () => {
        const legacy = SalesUnitEngine.normaliseToProcurementDemand(sampleSalesUnit, 2, 100);
        const nexus = normRule.evaluate({ salesUnit: sampleSalesUnit, salesUnitQuantity: 2, ownStockBaseQuantity: 100 });
        expect(nexus).toEqual(legacy);
        expect(nexus.deficit).toBe(0);
    });
});
