// Kombinatoricka regression matrix: Nexus DiscountLimitRule vs legacy
// DiscountLimitPolicy. MIGRATION_PLAN.md: DiscountLimitPolicy ma hierarchicke
// fallbacky + VAGNER pravidlo -- explicitni kombinatoricka matice, abychom
// omylem "nezjednodusili" chovani pri prevodu do Nexus modelu.
//
// Legacy engine se vola SKUTECNE (pres PricingContext/applyCommand), ne
// re-implementovan.

import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { DiscountLimitRule, type DiscountLimitRuleInput } from '../../../domains/pricing/DiscountLimitRule.js';
import { DiscountLimitPolicy } from '../../../connectors/pricing-engine/legacy/policies/DiscountLimitPolicy.js';
import { PricingContext } from '../../../connectors/pricing-engine/legacy/core/PricingContext.js';
import { RuleType, type PricingInput } from '../../../connectors/pricing-engine/legacy/core/interfaces.js';

interface Scenario {
    name: string;
    basePrice: string;
    currentPrice: string;
    salePrice?: string;
    productMaxDiscount?: string;
    manufacturer?: string;
    category?: string;
    brandLimits: Record<string, string>;
    categoryLimits: Record<string, string>;
}

function toDecimalMap(m: Record<string, string>): Record<string, Decimal> {
    const out: Record<string, Decimal> = {};
    for (const [k, v] of Object.entries(m)) out[k] = new Decimal(v);
    return out;
}

function runLegacy(s: Scenario) {
    const input: PricingInput = {
        sku: 'parity-test',
        basePrice: new Decimal(s.basePrice),
        salePrice: s.salePrice !== undefined ? new Decimal(s.salePrice) : undefined,
        productMaxDiscount: s.productMaxDiscount !== undefined ? new Decimal(s.productMaxDiscount) : undefined,
        manufacturer: s.manufacturer,
        category: s.category,
    };
    const context = new PricingContext(input);
    // currentPrice v legacy = context.currentPrice, ktera zacina na basePrice.
    // Abychom mohli testovat currentPrice != basePrice (napr. po predchozi
    // HighestDiscountPolicy), simulujeme to primym SET_PRICE prikazem pred
    // spustenim DiscountLimitPolicy -- presne jak by to vypadalo v realnem
    // policy chainu (BasePrice -> HighestDiscount -> DiscountLimit).
    if (s.currentPrice !== s.basePrice) {
        context.applyCommand({ type: 'SET_PRICE', price: new Decimal(s.currentPrice), rule: RuleType.LOYALTY });
    }

    const policy = new DiscountLimitPolicy(toDecimalMap(s.brandLimits), toDecimalMap(s.categoryLimits));
    const command = policy.apply(context);

    if (!command || command.type !== 'SET_PRICE') {
        return { applied: false as const };
    }
    return { applied: true as const, price: command.price, rule: command.rule as string };
}

function runNexus(s: Scenario) {
    const rule = new DiscountLimitRule({ tenantId: 'ten_1', ruleId: 'discount-limit-v1', ruleVersion: '1' });
    const input: DiscountLimitRuleInput = {
        basePrice: new Decimal(s.basePrice),
        currentPrice: new Decimal(s.currentPrice),
        salePrice: s.salePrice !== undefined ? new Decimal(s.salePrice) : undefined,
        productMaxDiscount: s.productMaxDiscount !== undefined ? new Decimal(s.productMaxDiscount) : undefined,
        manufacturer: s.manufacturer,
        category: s.category,
        brandLimits: toDecimalMap(s.brandLimits),
        categoryLimits: toDecimalMap(s.categoryLimits),
    };
    return rule.evaluate(input);
}

const BRAND_LIMITS = { VAGNER: '0.10', Samsung: '0.10' };
const CATEGORY_LIMITS = { Rybareni: '0.05' };

describe('DiscountLimitRule parity vs legacy DiscountLimitPolicy — combinatorial matrix', () => {
    const scenarios: Scenario[] = [
        // --- No limit active at all ---
        {
            name: 'no limit: no productMaxDiscount, unknown manufacturer, unknown category -> no-op',
            basePrice: '100', currentPrice: '100', manufacturer: 'Unknown', category: 'Unknown',
            brandLimits: BRAND_LIMITS, categoryLimits: CATEGORY_LIMITS,
        },
        {
            name: 'no limit: manufacturer undefined, category undefined -> no-op',
            basePrice: '100', currentPrice: '100',
            brandLimits: BRAND_LIMITS, categoryLimits: CATEGORY_LIMITS,
        },
        {
            name: 'no limit: manufacturer empty string (falsy) -> brand lookup skipped -> no-op',
            basePrice: '100', currentPrice: '100', manufacturer: '',
            brandLimits: BRAND_LIMITS, categoryLimits: CATEGORY_LIMITS,
        },

        // --- Product limit: highest priority, first match wins ---
        {
            name: 'product limit active, currentPrice above cap-floor -> no-op (limit not violated)',
            basePrice: '100', currentPrice: '95', productMaxDiscount: '0.10',
            brandLimits: BRAND_LIMITS, categoryLimits: CATEGORY_LIMITS,
        },
        {
            name: 'product limit active, currentPrice below cap-floor -> SET to cap-floor, PRODUCT_LIMIT',
            basePrice: '100', currentPrice: '85', productMaxDiscount: '0.10',
            brandLimits: BRAND_LIMITS, categoryLimits: CATEGORY_LIMITS,
        },
        {
            name: 'product limit active, currentPrice exactly AT cap-floor -> no-op (strict lessThan, not <=)',
            basePrice: '100', currentPrice: '90', productMaxDiscount: '0.10',
            brandLimits: BRAND_LIMITS, categoryLimits: CATEGORY_LIMITS,
        },
        {
            name: 'product limit active AND manufacturer/category also match limits -> product wins, brand/category ignored',
            basePrice: '100', currentPrice: '50', productMaxDiscount: '0.02', manufacturer: 'VAGNER', category: 'Rybareni',
            brandLimits: BRAND_LIMITS, categoryLimits: CATEGORY_LIMITS,
        },
        {
            name: 'product limit exactly 0 (0% allowed discount) -> cap-floor equals basePrice',
            basePrice: '100', currentPrice: '99', productMaxDiscount: '0',
            brandLimits: BRAND_LIMITS, categoryLimits: CATEGORY_LIMITS,
        },

        // --- Brand limit: second priority, only when product limit absent ---
        {
            name: 'brand limit active (known manufacturer), currentPrice below cap-floor -> SET, BRAND_LIMIT',
            basePrice: '200', currentPrice: '170', manufacturer: 'VAGNER',
            brandLimits: BRAND_LIMITS, categoryLimits: CATEGORY_LIMITS,
        },
        {
            name: 'brand limit active, currentPrice above cap-floor -> no-op',
            basePrice: '200', currentPrice: '190', manufacturer: 'VAGNER',
            brandLimits: BRAND_LIMITS, categoryLimits: CATEGORY_LIMITS,
        },
        {
            name: 'brand + category both match, no product limit -> brand wins (checked first)',
            basePrice: '200', currentPrice: '150', manufacturer: 'VAGNER', category: 'Rybareni',
            brandLimits: BRAND_LIMITS, categoryLimits: CATEGORY_LIMITS,
        },

        // --- Category limit: lowest priority ---
        {
            name: 'category limit active (unknown manufacturer, known category), currentPrice below cap-floor -> SET, CATEGORY_LIMIT',
            basePrice: '100', currentPrice: '94', category: 'Rybareni',
            brandLimits: BRAND_LIMITS, categoryLimits: CATEGORY_LIMITS,
        },
        {
            name: 'category limit active, currentPrice above cap-floor -> no-op',
            basePrice: '100', currentPrice: '96', category: 'Rybareni',
            brandLimits: BRAND_LIMITS, categoryLimits: CATEGORY_LIMITS,
        },
        {
            name: 'category empty string (falsy) with no product/brand match -> no-op',
            basePrice: '100', currentPrice: '50', category: '',
            brandLimits: BRAND_LIMITS, categoryLimits: CATEGORY_LIMITS,
        },

        // --- VAGNER rule: salePrice authoritative whenever a limit is active ---
        {
            name: 'VAGNER: product limit active + salePrice present -> salePrice wins, SALE, regardless of cap-floor comparison',
            basePrice: '100', currentPrice: '100', salePrice: '92', productMaxDiscount: '0.10',
            brandLimits: BRAND_LIMITS, categoryLimits: CATEGORY_LIMITS,
        },
        {
            name: 'VAGNER: salePrice is HIGHER than cap-floor -> salePrice still wins unchanged (never raised)',
            basePrice: '100', currentPrice: '100', salePrice: '95', productMaxDiscount: '0.10',
            brandLimits: BRAND_LIMITS, categoryLimits: CATEGORY_LIMITS,
        },
        {
            name: 'VAGNER: salePrice is LOWER than cap-floor -> salePrice still wins unchanged (never floored up)',
            basePrice: '100', currentPrice: '100', salePrice: '50', productMaxDiscount: '0.10',
            brandLimits: BRAND_LIMITS, categoryLimits: CATEGORY_LIMITS,
        },
        {
            name: 'VAGNER: brand limit active + salePrice present -> salePrice wins, SALE',
            basePrice: '200', currentPrice: '200', salePrice: '150', manufacturer: 'VAGNER',
            brandLimits: BRAND_LIMITS, categoryLimits: CATEGORY_LIMITS,
        },
        {
            name: 'VAGNER: category limit active + salePrice present -> salePrice wins, SALE',
            basePrice: '100', currentPrice: '100', salePrice: '80', category: 'Rybareni',
            brandLimits: BRAND_LIMITS, categoryLimits: CATEGORY_LIMITS,
        },
        {
            name: 'salePrice present but NO limit active -> no-op (salePrice authoritativeness requires an active cap)',
            basePrice: '100', currentPrice: '100', salePrice: '80',
            brandLimits: BRAND_LIMITS, categoryLimits: CATEGORY_LIMITS,
        },

        // --- Golden regression reference case (from PricingEndToEnd.test.ts) ---
        {
            name: 'golden SKU 93682: base 14.94, limit 15%, salePrice 12.70 -> salePrice wins (SALE)',
            basePrice: '14.94', currentPrice: '11.952', salePrice: '12.70', productMaxDiscount: '0.15',
            brandLimits: {}, categoryLimits: {},
        },
    ];

    for (const scenario of scenarios) {
        it(scenario.name, () => {
            const legacy = runLegacy(scenario);
            const nexus = runNexus(scenario);

            expect(nexus.applied).toBe(legacy.applied);
            if (legacy.applied) {
                expect(nexus.price?.toString()).toBe(legacy.price.toString());
                expect(nexus.rule).toBe(legacy.rule);
            }
        });
    }
});
