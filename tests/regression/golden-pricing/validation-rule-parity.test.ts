// Regression parity test: Nexus ValidationRule vs legacy ValidationEngine.
// MIGRATION_PLAN.md: nova Nexus Rule nesmi zmenit vysledek legacy chovani.
// Pokryto: validni vstupy, hranicni hodnoty, chybejici hodnoty, neplatne
// hodnoty, vsechny legacy error paths, poradi/priorita chyb.

import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { ValidationRule } from '../../../domains/pricing/ValidationRule.js';
import { ValidationEngine } from '../../../connectors/pricing-engine/legacy/core/ValidationEngine.js';
import type { PricingInput, PricingResult } from '../../../connectors/pricing-engine/legacy/core/interfaces.js';

const legacyEngine = new ValidationEngine();
const rule = new ValidationRule({ tenantId: 'ten_1', ruleId: 'validation-v1', ruleVersion: '1' });

function legacyInput(overrides: Partial<PricingInput>): PricingInput {
    return { sku: 'parity-test', basePrice: new Decimal('10'), ...overrides };
}

describe('ValidationRule.evaluate (validateInput) parity vs legacy ValidationEngine', () => {
    const inputCases: { name: string; input: PricingInput }[] = [
        { name: 'valid: plain positive basePrice, no discount', input: legacyInput({ basePrice: new Decimal('14.94') }) },
        { name: 'valid: basePrice exactly 0', input: legacyInput({ basePrice: new Decimal('0') }) },
        { name: 'valid: productMaxDiscount exactly 0 (falsy-but-defined Decimal, must NOT be skipped)', input: legacyInput({ productMaxDiscount: new Decimal('0') }) },
        { name: 'valid: productMaxDiscount exactly 1 (upper boundary)', input: legacyInput({ productMaxDiscount: new Decimal('1') }) },
        { name: 'valid: productMaxDiscount mid-range', input: legacyInput({ productMaxDiscount: new Decimal('0.15') }) },
        { name: 'valid: productMaxDiscount undefined (missing)', input: legacyInput({ productMaxDiscount: undefined }) },
        { name: 'invalid: basePrice negative', input: legacyInput({ basePrice: new Decimal('-0.01') }) },
        { name: 'invalid: basePrice very negative', input: legacyInput({ basePrice: new Decimal('-99999') }) },
        { name: 'invalid: productMaxDiscount negative', input: legacyInput({ productMaxDiscount: new Decimal('-0.01') }) },
        { name: 'invalid: productMaxDiscount > 1', input: legacyInput({ productMaxDiscount: new Decimal('1.01') }) },
        { name: 'invalid: productMaxDiscount way > 1', input: legacyInput({ productMaxDiscount: new Decimal('50') }) },
        {
            name: 'ordering: BOTH basePrice negative AND productMaxDiscount invalid -> basePrice error wins (checked first)',
            input: legacyInput({ basePrice: new Decimal('-5'), productMaxDiscount: new Decimal('2') }),
        },
        { name: 'edge: basePrice is NaN Decimal -> legacy lessThan(0) is false -> valid', input: legacyInput({ basePrice: new Decimal(NaN) }) },
        { name: 'edge: basePrice is Infinity Decimal -> valid (lessThan(0) false)', input: legacyInput({ basePrice: new Decimal(Infinity) }) },
        { name: 'edge: productMaxDiscount is NaN Decimal -> both comparisons false -> valid', input: legacyInput({ productMaxDiscount: new Decimal(NaN) }) },
    ];

    for (const { name, input } of inputCases) {
        it(name, () => {
            const legacyResult = legacyEngine.validateInput(input);
            const nexusResult = rule.evaluate({ basePrice: input.basePrice, productMaxDiscount: input.productMaxDiscount });

            expect(nexusResult.valid).toBe(legacyResult.valid);
            expect(nexusResult.reason).toBe(legacyResult.reason);
        });
    }
});

describe('ValidationRule.evaluateResult (validateResult) parity vs legacy ValidationEngine', () => {
    function legacyResult(finalPrice: Decimal): PricingResult {
        return {
            sku: 'parity-test',
            originalPrice: new Decimal('10'),
            finalPrice,
            appliedRules: [],
            warnings: [],
            rejected: false,
        };
    }

    const resultCases: { name: string; finalPrice: Decimal }[] = [
        { name: 'valid: positive finalPrice', finalPrice: new Decimal('12.70') },
        { name: 'valid: finalPrice exactly 0', finalPrice: new Decimal('0') },
        { name: 'invalid: finalPrice negative', finalPrice: new Decimal('-0.01') },
        { name: 'invalid: finalPrice very negative', finalPrice: new Decimal('-99999') },
        { name: 'edge: finalPrice is NaN Decimal -> valid (lessThan(0) false)', finalPrice: new Decimal(NaN) },
    ];

    for (const { name, finalPrice } of resultCases) {
        it(name, () => {
            const legacy = legacyEngine.validateResult(legacyResult(finalPrice));
            const nexus = rule.evaluateResult({ finalPrice });

            expect(nexus.valid).toBe(legacy.valid);
            expect(nexus.reason).toBe(legacy.reason);
        });
    }
});
