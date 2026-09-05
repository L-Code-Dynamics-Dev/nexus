import type { SalesUnit, ProductAvailabilityBySalesUnit, SalesUnitPricing } from './types.js';
import { ConversionEngine } from './ConversionEngine.js';

export interface SalesUnitAvailabilityInput {
    ownStockBaseQuantity: number;
    salesUnits: SalesUnit[];
    basePriceExVat?: number;  // price per 1 base unit, excl VAT
    vatRate?: number;          // e.g. 0.21 for 21%
    currency?: string;
}

/**
 * Main entry point for sales-unit domain.
 * Converts canonical stock to per-sales-unit availability and pricing.
 *
 * Flow:
 *   canonical base quantity
 *       ↓ SalesUnitEngine
 *   per-sales-unit availability + pricing
 *
 * Shoptet is only an adapter — this engine knows nothing about HTTP or external APIs.
 */
export class SalesUnitEngine {
    static getAvailabilityBySalesUnit(input: SalesUnitAvailabilityInput): ProductAvailabilityBySalesUnit[] {
        const results: ProductAvailabilityBySalesUnit[] = [];
        for (const su of input.salesUnits) {
            if (!su.active) continue;
            const availableBaseQty = Math.max(0, input.ownStockBaseQuantity);
            const suAvailable = ConversionEngine.fromBaseQuantity(su, availableBaseQty);
            const baseQtyForAvailable = suAvailable * su.baseQuantity;
            const totalWeightGrams = su.weightPerBaseUnitGrams * baseQtyForAvailable;

            let pricing: SalesUnitPricing | undefined;
            if (input.basePriceExVat !== undefined && input.currency !== undefined) {
                const vatRate = input.vatRate ?? 0;
                const unitPriceExVat = input.basePriceExVat * su.baseQuantity * su.priceMultiplier;
                const unitPriceIncVat = unitPriceExVat * (1 + vatRate);
                pricing = {
                    unitPriceExVat,
                    unitPriceIncVat,
                    pricePerBaseUnit: unitPriceExVat / su.baseQuantity,
                    currency: input.currency,
                };
            }

            results.push({
                salesUnitCode: su.code,
                salesUnitName: su.name,
                salesUnitQuantityAvailable: suAvailable,
                baseQuantityAvailable: baseQtyForAvailable,
                totalWeightGrams,
                pricing,
            });
        }
        return results;
    }

    /**
     * Normalises a customer order expressed in sales units to canonical base quantity.
     * Use this result as quantity / ownStockQuantity before feeding into ProcurementEngine.
     *
     * Correct flow:
     *   salesUnitQuantity
     *       ↓ SalesUnitEngine.normaliseToProcurementDemand
     *   canonicalQuantity + canonicalOwnStock
     *       ↓ ProcurementEngine.plan
     *   purchase orders
     */
    static normaliseToProcurementDemand(
        salesUnit: SalesUnit,
        salesUnitQuantity: number,
        ownStockBaseQuantity: number,
    ): { canonicalQuantity: number; canonicalOwnStock: number; deficit: number } {
        const { baseQuantity } = ConversionEngine.toBaseQuantity(salesUnit, salesUnitQuantity);
        const stock = Math.max(0, ownStockBaseQuantity);
        const deficit = Math.max(0, baseQuantity - stock);
        return {
            canonicalQuantity: baseQuantity,
            canonicalOwnStock: stock,
            deficit,
        };
    }
}
