// Regression parity test: Nexus BasePriceRule vs legacy BasePricePolicy.
// Triviala, ale drzena stejna disciplina jako predchozi 4 rules.

import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { BasePriceRule } from '../../../domains/pricing/BasePriceRule.js';
import { BasePricePolicy } from '../../../connectors/pricing-engine/legacy/policies/BasePricePolicy.js';
import { PricingContext } from '../../../connectors/pricing-engine/legacy/core/PricingContext.js';
import type { PricingInput } from '../../../connectors/pricing-engine/legacy/core/interfaces.js';

function runLegacy(basePrice: Decimal) {
    const input: PricingInput = { sku: 'parity-test', basePrice };
    const context = new PricingContext(input);
    const policy = new BasePricePolicy();
    const command = policy.apply(context);
    if (command) context.applyCommand(command);
    return { finalPrice: context.currentPrice, rule: context.appliedRules[0]?.rule as string };
}

describe('BasePriceRule parity vs legacy BasePricePolicy', () => {
    const rule = new BasePriceRule({ tenantId: 'ten_1', ruleId: 'base-price-v1', ruleVersion: '1' });

    const cases = ['14.94', '0', '0.01', '99999.99'];

    for (const raw of cases) {
        it(`matches legacy for basePrice=${raw}`, () => {
            const basePrice = new Decimal(raw);
            const legacy = runLegacy(basePrice);
            const nexus = rule.evaluate({ basePrice });

            expect(nexus.price.toString()).toBe(legacy.finalPrice.toString());
            expect(nexus.rule).toBe(legacy.rule);
        });
    }
});
