// Regression parity test: Nexus HighestDiscountRule vs legacy
// HighestDiscountPolicy. MIGRATION_PLAN.md ctvrty krok. Pokryto: salePrice
// only, loyalty only, both (nizsi vyhrava, presna rovnost -> LOYALTY),
// zadny (no-op), allowLoyaltyDiscount false, unknown tier, plus chain
// interakce s DiscountLimitRule (priority 20 -> 30 v realnem enginu).
//
// Legacy engine se vola SKUTECNE (pres PricingContext/applyCommand), ne
// re-implementovan.

import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { HighestDiscountRule, type HighestDiscountRuleInput } from '../../../domains/pricing/HighestDiscountRule.js';
import { DiscountLimitRule } from '../../../domains/pricing/DiscountLimitRule.js';
import { HighestDiscountPolicy } from '../../../connectors/pricing-engine/legacy/policies/HighestDiscountPolicy.js';
import { DiscountLimitPolicy } from '../../../connectors/pricing-engine/legacy/policies/DiscountLimitPolicy.js';
import { PricingContext } from '../../../connectors/pricing-engine/legacy/core/PricingContext.js';
import type { PricingInput, CustomerTier } from '../../../connectors/pricing-engine/legacy/core/interfaces.js';

function toDecimalMap(m: Record<string, string>): Record<string, Decimal> {
    const out: Record<string, Decimal> = {};
    for (const [k, v] of Object.entries(m)) out[k] = new Decimal(v);
    return out;
}

const LOYALTY_TIERS = { ZR4: '0.04', ZR10: '0.10', ZR20: '0.20', ZR25: '0.25' };

interface Scenario {
    name: string;
    basePrice: string;
    salePrice?: string;
    customerTier?: string;
    allowLoyaltyDiscount?: boolean;
    loyaltyTiers?: Record<string, string>;
}

function runLegacy(s: Scenario) {
    const input: PricingInput = {
        sku: 'parity-test',
        basePrice: new Decimal(s.basePrice),
        salePrice: s.salePrice !== undefined ? new Decimal(s.salePrice) : undefined,
        customerTier: s.customerTier as CustomerTier | undefined,
        allowLoyaltyDiscount: s.allowLoyaltyDiscount,
    };
    const context = new PricingContext(input);
    const policy = new HighestDiscountPolicy(toDecimalMap(s.loyaltyTiers ?? LOYALTY_TIERS));
    const command = policy.apply(context);

    if (!command || command.type !== 'SET_PRICE') {
        return { applied: false as const };
    }
    return { applied: true as const, price: command.price, rule: command.rule as string };
}

function runNexus(s: Scenario) {
    const rule = new HighestDiscountRule({ tenantId: 'ten_1', ruleId: 'highest-discount-v1', ruleVersion: '1' });
    const input: HighestDiscountRuleInput = {
        basePrice: new Decimal(s.basePrice),
        salePrice: s.salePrice !== undefined ? new Decimal(s.salePrice) : undefined,
        customerTier: s.customerTier,
        allowLoyaltyDiscount: s.allowLoyaltyDiscount,
        loyaltyTiers: toDecimalMap(s.loyaltyTiers ?? LOYALTY_TIERS),
    };
    return rule.evaluate(input);
}

describe('HighestDiscountRule parity vs legacy HighestDiscountPolicy', () => {
    const scenarios: Scenario[] = [
        { name: 'neither salePrice nor loyalty tier -> no-op', basePrice: '100' },
        { name: 'salePrice only, no customerTier -> SALE', basePrice: '100', salePrice: '85' },
        { name: 'loyalty only, no salePrice -> LOYALTY', basePrice: '100', customerTier: 'ZR20', allowLoyaltyDiscount: true },
        {
            name: 'both defined, salePrice LOWER than loyaltyPrice -> SALE wins',
            basePrice: '100', salePrice: '70', customerTier: 'ZR20', allowLoyaltyDiscount: true, // loyaltyPrice = 80
        },
        {
            name: 'both defined, salePrice HIGHER than loyaltyPrice -> LOYALTY wins',
            basePrice: '100', salePrice: '90', customerTier: 'ZR20', allowLoyaltyDiscount: true, // loyaltyPrice = 80
        },
        {
            name: 'both defined, EXACTLY equal -> LOYALTY wins (strict lessThan, not <=)',
            basePrice: '100', salePrice: '80', customerTier: 'ZR20', allowLoyaltyDiscount: true, // loyaltyPrice = 80
        },
        {
            name: 'customerTier set but allowLoyaltyDiscount false -> loyalty ignored, no-op',
            basePrice: '100', customerTier: 'ZR20', allowLoyaltyDiscount: false,
        },
        {
            name: 'customerTier set but allowLoyaltyDiscount undefined -> loyalty ignored, no-op',
            basePrice: '100', customerTier: 'ZR20',
        },
        {
            name: 'customerTier set + allowLoyaltyDiscount false + salePrice present -> SALE (loyalty ignored entirely)',
            basePrice: '100', salePrice: '85', customerTier: 'ZR20', allowLoyaltyDiscount: false,
        },
        {
            name: 'customerTier not present in loyaltyTiers map -> loyalty ignored, no-op',
            basePrice: '100', customerTier: 'ZR99', allowLoyaltyDiscount: true,
        },
        {
            name: 'customerTier not in map + salePrice present -> SALE',
            basePrice: '100', salePrice: '85', customerTier: 'ZR99', allowLoyaltyDiscount: true,
        },
        {
            name: 'lowest tier (ZR4), salePrice absent -> LOYALTY at 4% off',
            basePrice: '100', customerTier: 'ZR4', allowLoyaltyDiscount: true,
        },
        {
            name: 'golden SKU 93682: base 14.94, ZR20 loyalty, salePrice 12.70 -> LOYALTY (11.952 < 12.70)',
            basePrice: '14.94', salePrice: '12.70', customerTier: 'ZR20', allowLoyaltyDiscount: true,
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

describe('HighestDiscountRule -> DiscountLimitRule chain interaction (priority 20 -> 30 in real engine)', () => {
    interface ChainScenario {
        name: string;
        basePrice: string;
        salePrice?: string;
        productMaxDiscount?: string;
        customerTier?: string;
        allowLoyaltyDiscount?: boolean;
    }

    function runLegacyChain(s: ChainScenario) {
        const input: PricingInput = {
            sku: 'parity-test',
            basePrice: new Decimal(s.basePrice),
            salePrice: s.salePrice !== undefined ? new Decimal(s.salePrice) : undefined,
            productMaxDiscount: s.productMaxDiscount !== undefined ? new Decimal(s.productMaxDiscount) : undefined,
            customerTier: s.customerTier as CustomerTier | undefined,
            allowLoyaltyDiscount: s.allowLoyaltyDiscount,
        };
        const context = new PricingContext(input);

        const highestDiscount = new HighestDiscountPolicy(toDecimalMap(LOYALTY_TIERS));
        const cmd1 = highestDiscount.apply(context);
        if (cmd1) context.applyCommand(cmd1);

        const discountLimit = new DiscountLimitPolicy({}, {});
        const cmd2 = discountLimit.apply(context);
        if (cmd2) context.applyCommand(cmd2);

        return { finalPrice: context.currentPrice, appliedRules: context.appliedRules.map((r) => r.rule as string) };
    }

    function runNexusChain(s: ChainScenario) {
        const highestDiscountRule = new HighestDiscountRule({ tenantId: 'ten_1', ruleId: 'highest-discount-v1', ruleVersion: '1' });
        const discountLimitRule = new DiscountLimitRule({ tenantId: 'ten_1', ruleId: 'discount-limit-v1', ruleVersion: '1' });

        const basePrice = new Decimal(s.basePrice);
        const salePrice = s.salePrice !== undefined ? new Decimal(s.salePrice) : undefined;
        const productMaxDiscount = s.productMaxDiscount !== undefined ? new Decimal(s.productMaxDiscount) : undefined;

        let currentPrice = basePrice;
        const appliedRules: string[] = [];

        const step1 = highestDiscountRule.evaluate({
            basePrice, salePrice, customerTier: s.customerTier, allowLoyaltyDiscount: s.allowLoyaltyDiscount,
            loyaltyTiers: toDecimalMap(LOYALTY_TIERS),
        });
        if (step1.applied && step1.price) {
            currentPrice = step1.price;
            appliedRules.push(step1.rule!);
        }

        const step2 = discountLimitRule.evaluate({
            basePrice, currentPrice, salePrice, productMaxDiscount,
            brandLimits: {}, categoryLimits: {},
        });
        if (step2.applied && step2.price) {
            currentPrice = step2.price;
            appliedRules.push(step2.rule!);
        }

        return { finalPrice: currentPrice, appliedRules };
    }

    const chainScenarios: ChainScenario[] = [
        {
            name: 'golden SKU 93682: loyalty picks 11.952, but product limit + salePrice overrides via VAGNER -> 12.70 SALE',
            basePrice: '14.94', salePrice: '12.70', productMaxDiscount: '0.15', customerTier: 'ZR20', allowLoyaltyDiscount: true,
        },
        {
            name: 'loyalty wins first step, no product limit -> loyalty price stands unchanged through step 2',
            basePrice: '100', customerTier: 'ZR20', allowLoyaltyDiscount: true,
        },
        {
            name: 'loyalty wins first step, product limit present but loyaltyPrice already satisfies cap -> no further change',
            basePrice: '100', customerTier: 'ZR4', allowLoyaltyDiscount: true, productMaxDiscount: '0.50',
        },
        {
            name: 'loyalty wins first step, product limit tighter than loyalty discount -> limit floors it up',
            basePrice: '100', customerTier: 'ZR25', allowLoyaltyDiscount: true, productMaxDiscount: '0.10',
        },
    ];

    for (const scenario of chainScenarios) {
        it(scenario.name, () => {
            const legacy = runLegacyChain(scenario);
            const nexus = runNexusChain(scenario);

            expect(nexus.finalPrice.toString()).toBe(legacy.finalPrice.toString());
            expect(nexus.appliedRules).toEqual(legacy.appliedRules);
        });
    }
});
