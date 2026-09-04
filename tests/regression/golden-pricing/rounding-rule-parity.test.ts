// Regression parity test: Nexus RoundingRule vs legacy RoundingPolicy.
// Součást migračního postupu z MIGRATION_PLAN.md: LEGACY POLICY -> NEXUS
// RULE CONTRACT -> NEXUS IMPLEMENTACE -> REGRESSION FIXTURES -> POROVNÁNÍ
// S LEGACY REFERENCE. Nová Nexus Rule nesmí změnit výsledek legacy enginu.

import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { RoundingRule } from '../../../domains/pricing/RoundingRule.js';
import { RoundingPolicy } from '../../../connectors/pricing-engine/legacy/policies/RoundingPolicy.js';
import { PricingContext } from '../../../connectors/pricing-engine/legacy/core/PricingContext.js';
import type { PricingInput } from '../../../connectors/pricing-engine/legacy/core/interfaces.js';

function runLegacyRounding(currentPrice: Decimal): { finalPrice: Decimal; applied: boolean } {
    const input: PricingInput = { sku: 'parity-test', basePrice: currentPrice };
    const context = new PricingContext(input);
    const policy = new RoundingPolicy();
    const command = policy.apply(context);
    if (command) context.applyCommand(command);
    return { finalPrice: context.currentPrice, applied: command !== undefined };
}

describe('RoundingRule parity vs legacy RoundingPolicy', () => {
    const rule = new RoundingRule({ tenantId: 'ten_1', ruleId: 'rounding-v1', ruleVersion: '1' });

    const cases: string[] = [
        '12.699',        // golden SKU 93682 candidatePrice pre-rounding
        '12.70',         // already exactly 2 decimal places
        '12',             // whole number
        '12.7',           // 1 decimal place
        '0.005',          // rounds at the boundary
        '99.999999',
        '0',
        '0.00',
        '1000000.126',
        '14.94',
        '-5.555',         // shouldn't occur in practice, but must match legacy behavior if it does
    ];

    for (const raw of cases) {
        it(`matches legacy for currentPrice=${raw}`, () => {
            const currentPrice = new Decimal(raw);

            const legacy = runLegacyRounding(currentPrice);
            const nexus = rule.evaluate({ currentPrice });

            expect(nexus.finalPrice.toString()).toBe(legacy.finalPrice.toString());
            expect(nexus.applied).toBe(legacy.applied);
        });
    }
});
