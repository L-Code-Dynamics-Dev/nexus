// ConversionRule -- migrace legacy ConversionEngine (connectors/
// availability-intelligence/legacy/sales-units/ConversionEngine.ts) pod
// Nexus Rule contract. Fáze 3 (docs/MIGRATION_PLAN.md).
//
// 1:1 s legacy: integer-only aritmetika (žádné float zaokrouhlování),
// throw na neceločíselné/nekladné vstupy zachován beze změny -- to je
// byznys invariant (precision-safe konverze), ne detail k "vylepšení".
// toBaseQuantity/fromBaseQuantity zůstávají dvě samostatné operace
// (round-trip není vždy symetrický -- fromBaseQuantity je floor dělení).

import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import type { SalesUnit, ConversionResult } from '../../connectors/availability-intelligence/legacy/sales-units/types.js';

export interface ToBaseQuantityInput {
    readonly salesUnit: SalesUnit;
    readonly salesUnitQuantity: number;
}

export interface FromBaseQuantityInput {
    readonly salesUnit: SalesUnit;
    readonly baseQuantity: number;
}

export class ToBaseQuantityRule implements Rule<ToBaseQuantityInput, ConversionResult> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: ToBaseQuantityInput): ConversionResult {
        const { salesUnit, salesUnitQuantity } = input;
        if (!Number.isInteger(salesUnitQuantity) || salesUnitQuantity <= 0) {
            throw new Error(`salesUnitQuantity must be a positive integer, got ${salesUnitQuantity}`);
        }
        if (!Number.isInteger(salesUnit.baseQuantity) || salesUnit.baseQuantity <= 0) {
            throw new Error(`salesUnit.baseQuantity must be a positive integer, got ${salesUnit.baseQuantity}`);
        }
        const baseQuantity = salesUnit.baseQuantity * salesUnitQuantity;
        const totalWeightGrams = salesUnit.weightPerBaseUnitGrams * baseQuantity;
        return {
            salesUnitCode: salesUnit.code,
            salesUnitQuantity,
            baseQuantity,
            totalWeightGrams,
        };
    }
}

export class FromBaseQuantityRule implements Rule<FromBaseQuantityInput, number> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: FromBaseQuantityInput): number {
        const { salesUnit, baseQuantity } = input;
        if (!Number.isInteger(baseQuantity) || baseQuantity < 0) {
            throw new Error(`baseQuantity must be a non-negative integer, got ${baseQuantity}`);
        }
        return Math.floor(baseQuantity / salesUnit.baseQuantity);
    }
}
