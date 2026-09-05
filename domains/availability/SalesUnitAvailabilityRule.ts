// SalesUnitAvailabilityRule -- migrace legacy SalesUnitEngine (connectors/
// availability-intelligence/legacy/sales-units/SalesUnitEngine.ts) pod
// Nexus Rule contract. Fáze 3 (docs/MIGRATION_PLAN.md).
//
// 1:1 s legacy: dvě samostatné odpovědnosti zůstávají dvě Rules (stejné
// veřejné API jako legacy dvě statické metody). Legacy interně volá
// ConversionEngine.fromBaseQuantity/toBaseQuantity -- zde je stejná
// floor-dělení/násobení logika inline, aby Rule zůstala samostatná čistá
// funkce bez závislosti na instanci jiné Rule (žádná Rule-uvnitř-Rule
// kompozice v tomto repu zatím nemá precedens, viz domains/pricing/*).
//
// Komentář z legacy hlavičky zachován jako důležitý architektonický
// fakt: "Shoptet is only an adapter -- this engine knows nothing about
// HTTP or external APIs."

import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import type { SalesUnit, ProductAvailabilityBySalesUnit, SalesUnitPricing } from '../../connectors/availability-intelligence/legacy/sales-units/types.js';

export interface SalesUnitAvailabilityInput {
    readonly ownStockBaseQuantity: number;
    readonly salesUnits: readonly SalesUnit[];
    readonly basePriceExVat?: number;
    readonly vatRate?: number;
    readonly currency?: string;
}

export class SalesUnitAvailabilityRule implements Rule<SalesUnitAvailabilityInput, ProductAvailabilityBySalesUnit[]> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: SalesUnitAvailabilityInput): ProductAvailabilityBySalesUnit[] {
        const results: ProductAvailabilityBySalesUnit[] = [];
        for (const su of input.salesUnits) {
            if (!su.active) continue;
            const availableBaseQty = Math.max(0, input.ownStockBaseQuantity);
            const suAvailable = Math.floor(availableBaseQty / su.baseQuantity);
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
}

export interface NormaliseToProcurementDemandInput {
    readonly salesUnit: SalesUnit;
    readonly salesUnitQuantity: number;
    readonly ownStockBaseQuantity: number;
}

export interface NormaliseToProcurementDemandResult {
    readonly canonicalQuantity: number;
    readonly canonicalOwnStock: number;
    readonly deficit: number;
}

export class NormaliseToProcurementDemandRule implements Rule<NormaliseToProcurementDemandInput, NormaliseToProcurementDemandResult> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: NormaliseToProcurementDemandInput): NormaliseToProcurementDemandResult {
        const { salesUnit, salesUnitQuantity, ownStockBaseQuantity } = input;
        if (!Number.isInteger(salesUnitQuantity) || salesUnitQuantity <= 0) {
            throw new Error(`salesUnitQuantity must be a positive integer, got ${salesUnitQuantity}`);
        }
        if (!Number.isInteger(salesUnit.baseQuantity) || salesUnit.baseQuantity <= 0) {
            throw new Error(`salesUnit.baseQuantity must be a positive integer, got ${salesUnit.baseQuantity}`);
        }
        const baseQuantity = salesUnit.baseQuantity * salesUnitQuantity;
        const stock = Math.max(0, ownStockBaseQuantity);
        const deficit = Math.max(0, baseQuantity - stock);
        return {
            canonicalQuantity: baseQuantity,
            canonicalOwnStock: stock,
            deficit,
        };
    }
}
