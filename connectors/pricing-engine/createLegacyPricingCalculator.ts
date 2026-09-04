// Connector-side factory -- staví reálný legacy PricingEngine (beze změny,
// viz legacy/) a vrací funkci se signaturou, kterou PricingAdapter injektuje.
// TOTO JE HRANICE: adapter nikdy neimportuje legacy/core přímo, jen skrz
// tuto funkci -- žádný refactor policies, žádné přesouvání business pravidel
// do Core (viz MIGRATION_PLAN.md Fáze 1 zásada "legacy zůstává referenční").

import { EngineBuilder } from './legacy/core/EngineBuilder.js';
import type { CustomerTier } from './legacy/core/interfaces.js';
import type { LegacyPricingInput, LegacyPricingResult } from '../../domains/pricing/PricingAdapter.js';

const VALID_TIERS: readonly string[] = ["ZR4", "ZR6", "ZR8", "ZR10", "ZR12", "ZR14", "ZR16", "ZR18", "ZR20", "ZR25"];

function toCustomerTier(tier: string | undefined): CustomerTier | undefined {
    if (tier === undefined) return undefined;
    if (!VALID_TIERS.includes(tier)) {
        throw new Error(`Unknown customerTier "${tier}" -- not one of legacy loyaltyTiers (${VALID_TIERS.join(', ')})`);
    }
    return tier as CustomerTier;
}

/**
 * Staví injektovatelnou `legacyCalculatePrice` funkci proti reálnému,
 * portovanému engine (connectors/pricing-engine/legacy/). `configPath`
 * odpovídá legacy `EngineBuilder.fromConfig()` -- stejný policy-v1.json
 * formát, žádná nová konfigurace.
 */
export function createLegacyPricingCalculator(configPath: string): (input: LegacyPricingInput) => LegacyPricingResult {
    const engine = EngineBuilder.fromConfig(configPath).build();

    return (input: LegacyPricingInput): LegacyPricingResult => {
        const result = engine.calculatePrice({
            sku: input.sku,
            basePrice: input.basePrice,
            salePrice: input.salePrice,
            productMaxDiscount: input.productMaxDiscount,
            customerTier: toCustomerTier(input.customerTier),
            allowLoyaltyDiscount: input.allowLoyaltyDiscount,
            manufacturer: input.manufacturer,
            category: input.category,
        });

        return {
            finalPrice: result.finalPrice,
            appliedRules: result.appliedRules.map((r) => ({ rule: r.rule as string, metadata: r.metadata })),
            rejected: result.rejected,
            rejectReason: result.rejectReason,
        };
    };
}
