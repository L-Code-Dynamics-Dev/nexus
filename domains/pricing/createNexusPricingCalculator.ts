// Nexus-side factory -- staví plný Nexus Rule chain (BasePrice ->
// HighestDiscount -> DiscountLimit -> Rounding) a vrací funkci stejné
// signatury jako connectors/pricing-engine/createLegacyPricingCalculator.ts.
//
// SCOPE ZÁMĚRNĚ STEJNÝ JAKO LEGACY CALCULATOR: žádná ValidationRule uvnitř.
// createLegacyPricingCalculator nikdy nevolal ValidationEngine -- validace
// input/output byla vždy samostatný krok mimo calculator (viz
// tests/regression/golden-pricing/golden.test.ts, kde se
// validationEngine.validateInput/validateResult volá explicitně kolem
// engine.calculatePrice()). Kdyby tato factory validaci přidala, chovala
// by se jinak než injekce, kterou nahrazuje (např. záporná basePrice by se
// tiše propočítala v legacy, ale zde by byla odmítnuta) -- to není parita,
// to je změna chování PricingAdapter výstupu. Validace zůstává samostatná
// odpovědnost, řešená mimo tuto factory, stejně jako dnes.
//
// TOTO JE PRODUKČNÍ NÁHRADA za legacy calculator -- parita proti legacy je
// ověřena v tests/regression/golden-pricing/full-chain-parity.test.ts
// (70/70 golden kombinací) a tests/regression/golden-pricing/
// nexus-calculator-parity.test.ts (factory-level parita). Chain pořadí
// a logika je identická -- žádná nová business logika, jen produkční
// zapojení už migrovaných Rules.
//
// configPath odpovídá stejnému policy-v1.json formátu jako legacy
// EngineBuilder.fromConfig() -- žádná nová konfigurace.
//
// customerTier guard: legacy engine má `CustomerTier` jako TypeScript union,
// takže neplatný tier je compile-time chyba. Nexus PricingComputationInput
// má customerTier jako `string` (viz Price.ts -- Nexus nesmí zadrátovat
// tenant-specific tiery do core typu), takže stejná ochrana musí být
// runtime check zde -- jinak by neznámý tier tiše propadl přes
// HighestDiscountRule (loyaltyTiers[unknown] === undefined -> loyalty se
// prostě nepoužije) místo aby explicitně selhal. Zachovává chování
// createLegacyPricingCalculator.toCustomerTier().

import * as fs from 'fs';
import Decimal from 'decimal.js';
import type { LegacyPricingInput, LegacyPricingResult } from './PricingAdapter.js';
import { BasePriceRule } from './BasePriceRule.js';
import { HighestDiscountRule } from './HighestDiscountRule.js';
import { DiscountLimitRule } from './DiscountLimitRule.js';
import { RoundingRule } from './RoundingRule.js';

interface PolicyConfig {
    loyaltyTiers: Record<string, number>;
    brandLimits?: Record<string, number>;
    categoryLimits?: Record<string, number>;
}

function toDecimalMap(m: Record<string, number> | undefined): Record<string, Decimal> {
    const out: Record<string, Decimal> = {};
    for (const [k, v] of Object.entries(m ?? {})) out[k] = new Decimal(v);
    return out;
}

export function createNexusPricingCalculator(configPath: string): (input: LegacyPricingInput) => LegacyPricingResult {
    const config: PolicyConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const loyaltyTiers = toDecimalMap(config.loyaltyTiers);
    const brandLimits = toDecimalMap(config.brandLimits);
    const categoryLimits = toDecimalMap(config.categoryLimits);
    const validTiers = Object.keys(config.loyaltyTiers);

    const ctx = { tenantId: 'ten_1', ruleVersion: '1' };
    const basePriceRule = new BasePriceRule({ ...ctx, ruleId: 'base-price-v1' });
    const highestDiscountRule = new HighestDiscountRule({ ...ctx, ruleId: 'highest-discount-v1' });
    const discountLimitRule = new DiscountLimitRule({ ...ctx, ruleId: 'discount-limit-v1' });
    const roundingRule = new RoundingRule({ ...ctx, ruleId: 'rounding-v1' });

    return (input: LegacyPricingInput): LegacyPricingResult => {
        if (input.customerTier !== undefined && !validTiers.includes(input.customerTier)) {
            throw new Error(`Unknown customerTier "${input.customerTier}" -- not one of legacy loyaltyTiers (${validTiers.join(', ')})`);
        }

        const base = basePriceRule.evaluate({ basePrice: input.basePrice });
        let currentPrice = base.price;
        const appliedRules: { rule: string }[] = [{ rule: base.rule }];

        const highest = highestDiscountRule.evaluate({
            basePrice: input.basePrice,
            salePrice: input.salePrice,
            customerTier: input.customerTier,
            allowLoyaltyDiscount: input.allowLoyaltyDiscount,
            loyaltyTiers,
        });
        if (highest.applied && highest.price) {
            currentPrice = highest.price;
            appliedRules.push({ rule: highest.rule! });
        }

        const limit = discountLimitRule.evaluate({
            basePrice: input.basePrice,
            currentPrice,
            salePrice: input.salePrice,
            productMaxDiscount: input.productMaxDiscount,
            manufacturer: input.manufacturer,
            category: input.category,
            brandLimits,
            categoryLimits,
        });
        if (limit.applied && limit.price) {
            currentPrice = limit.price;
            appliedRules.push({ rule: limit.rule! });
        }

        const rounding = roundingRule.evaluate({ currentPrice });
        if (rounding.applied) {
            currentPrice = rounding.finalPrice;
            appliedRules.push({ rule: 'ROUNDING' });
        }

        return { finalPrice: currentPrice, appliedRules, rejected: false };
    };
}
