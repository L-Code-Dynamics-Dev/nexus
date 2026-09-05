import type { SalesUnit, ConversionResult } from './types.js';

/**
 * Deterministic, no-float conversion between sales units and canonical base quantity.
 * All arithmetic is integer multiplication only.
 */
export class ConversionEngine {
    /**
     * Convert a customer order (salesUnitQuantity of a given SalesUnit) to canonical base quantity.
     * Throws if inputs are not positive integers.
     */
    static toBaseQuantity(salesUnit: SalesUnit, salesUnitQuantity: number): ConversionResult {
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

    /**
     * How many complete sales units fit in a given base quantity (floor division).
     */
    static fromBaseQuantity(salesUnit: SalesUnit, baseQuantity: number): number {
        if (!Number.isInteger(baseQuantity) || baseQuantity < 0) {
            throw new Error(`baseQuantity must be a non-negative integer, got ${baseQuantity}`);
        }
        return Math.floor(baseQuantity / salesUnit.baseQuantity);
    }
}
