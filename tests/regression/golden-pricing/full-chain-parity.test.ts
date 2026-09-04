// Plny chain parity test: Nexus Rule chain (BasePrice -> HighestDiscount ->
// DiscountLimit -> Rounding, s Validation na vstupu i vystupu) vs skutecny
// legacy Pricing Engine, na vsech 70 kombinacich golden datasetu
// (7 fixtures x 10 loyalty tieru). MIGRATION_PLAN.md: az po tomto testu je
// Nexus policy chain povazovan za behavioralne kompatibilni s legaci --
// teprve pak ma smysl uvazovat o prepnuti PricingAdapteru.
//
// DULEZITE: porovnava se PER-SKU vysledek (ne jen serializovany CSV vystup
// jako golden.test.ts) -- kazda kombinace SKU x tier jde pres:
//   Golden Fixture -> Legacy Engine -> expected
//   Golden Fixture -> Nexus Rule Chain -> actual
// a oba vysledky (finalPrice, rejected/valid, appliedRules) se hluboce
// porovnavaji. Pri mismatchi test vypise SKU, tier, basePrice, salePrice,
// productMaxDiscount, legacy i nexus vysledek, a mezikroky nexus chainu
// (jen pro diagnostiku, ne novy business mechanismus).

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse';
import Decimal from 'decimal.js';

import { EngineBuilder } from '../../../connectors/pricing-engine/legacy/core/EngineBuilder.js';
import { ValidationEngine as LegacyValidationEngine } from '../../../connectors/pricing-engine/legacy/core/ValidationEngine.js';
import type { PricingInput as LegacyPricingInput, CustomerTier } from '../../../connectors/pricing-engine/legacy/core/interfaces.js';

import { BasePriceRule } from '../../../domains/pricing/BasePriceRule.js';
import { HighestDiscountRule } from '../../../domains/pricing/HighestDiscountRule.js';
import { DiscountLimitRule } from '../../../domains/pricing/DiscountLimitRule.js';
import { RoundingRule } from '../../../domains/pricing/RoundingRule.js';
import { ValidationRule } from '../../../domains/pricing/ValidationRule.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '../../../connectors/pricing-engine/legacy/config/policies/policy-v1.json');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

interface PolicyConfig {
    loyaltyTiers: Record<string, number>;
    brandLimits?: Record<string, number>;
    categoryLimits?: Record<string, number>;
}

function loadConfig(): PolicyConfig {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

function toDecimalMap(m: Record<string, number> | undefined): Record<string, Decimal> {
    const out: Record<string, Decimal> = {};
    for (const [k, v] of Object.entries(m ?? {})) out[k] = new Decimal(v);
    return out;
}

interface ChainOutcome {
    rejected: boolean;
    rejectReason?: string;
    finalPrice?: Decimal;
    appliedRules: string[];
}

/**
 * Nexus Rule chain runner -- volá BasePriceRule -> HighestDiscountRule ->
 * DiscountLimitRule -> RoundingRule v tomto pořadí (odpovídá legacy
 * priority 10 -> 20 -> 30 -> 100), s ValidationRule na vstupu i výstupu.
 * Zachycuje mezikroky pro diagnostiku mismatchů, ale intermediate stav
 * NENÍ nový business mechanismus -- jen introspekce pro test.
 */
function runNexusChain(
    input: LegacyPricingInput,
    tiers: Record<string, Decimal>,
    brandLimits: Record<string, Decimal>,
    categoryLimits: Record<string, Decimal>
): ChainOutcome & { steps: { rule: string; price: string }[] } {
    const ctx = { tenantId: 'ten_1', ruleVersion: '1' };
    const validationRule = new ValidationRule({ ...ctx, ruleId: 'validation-v1' });
    const basePriceRule = new BasePriceRule({ ...ctx, ruleId: 'base-price-v1' });
    const highestDiscountRule = new HighestDiscountRule({ ...ctx, ruleId: 'highest-discount-v1' });
    const discountLimitRule = new DiscountLimitRule({ ...ctx, ruleId: 'discount-limit-v1' });
    const roundingRule = new RoundingRule({ ...ctx, ruleId: 'rounding-v1' });

    const steps: { rule: string; price: string }[] = [];

    const inputValidation = validationRule.evaluate({ basePrice: input.basePrice, productMaxDiscount: input.productMaxDiscount });
    if (!inputValidation.valid) {
        return { rejected: true, rejectReason: inputValidation.reason, appliedRules: [], steps };
    }

    const base = basePriceRule.evaluate({ basePrice: input.basePrice });
    let currentPrice = base.price;
    const appliedRules: string[] = [base.rule];
    steps.push({ rule: base.rule, price: currentPrice.toString() });

    const highest = highestDiscountRule.evaluate({
        basePrice: input.basePrice,
        salePrice: input.salePrice,
        customerTier: input.customerTier,
        allowLoyaltyDiscount: input.allowLoyaltyDiscount,
        loyaltyTiers: tiers,
    });
    if (highest.applied && highest.price) {
        currentPrice = highest.price;
        appliedRules.push(highest.rule!);
        steps.push({ rule: highest.rule!, price: currentPrice.toString() });
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
        appliedRules.push(limit.rule!);
        steps.push({ rule: limit.rule!, price: currentPrice.toString() });
    }

    const rounding = roundingRule.evaluate({ currentPrice });
    if (rounding.applied) {
        currentPrice = rounding.finalPrice;
        appliedRules.push('ROUNDING');
        steps.push({ rule: 'ROUNDING', price: currentPrice.toString() });
    }

    const outputValidation = validationRule.evaluateResult({ finalPrice: currentPrice });
    if (!outputValidation.valid) {
        return { rejected: true, rejectReason: outputValidation.reason, appliedRules, steps };
    }

    return { rejected: false, finalPrice: currentPrice, appliedRules, steps };
}

function runLegacyChain(
    input: LegacyPricingInput,
    engine: ReturnType<typeof EngineBuilder.prototype.build>,
    validationEngine: LegacyValidationEngine
): ChainOutcome {
    const inputValidation = validationEngine.validateInput(input);
    if (!inputValidation.valid) {
        return { rejected: true, rejectReason: inputValidation.reason, appliedRules: [] };
    }

    const result = engine.calculatePrice(input);

    const outputValidation = validationEngine.validateResult(result);
    if (!outputValidation.valid) {
        return { rejected: true, rejectReason: outputValidation.reason, appliedRules: result.appliedRules.map((r) => r.rule as string) };
    }

    if (result.rejected) {
        return { rejected: true, rejectReason: result.rejectReason, appliedRules: result.appliedRules.map((r) => r.rule as string) };
    }

    return { rejected: false, finalPrice: result.finalPrice, appliedRules: result.appliedRules.map((r) => r.rule as string) };
}

describe('Full chain parity — Nexus Rule chain vs legacy Pricing Engine (70 golden combinations)', () => {
    const config = loadConfig();
    const engine = EngineBuilder.fromConfig(CONFIG_PATH).build();
    const validationEngine = new LegacyValidationEngine();

    const tiers = ["ZR4", "ZR6", "ZR8", "ZR10", "ZR12", "ZR14", "ZR16", "ZR18", "ZR20", "ZR25"] as const;
    const tierDecimals = toDecimalMap(config.loyaltyTiers);
    const brandLimits = toDecimalMap(config.brandLimits);
    const categoryLimits = toDecimalMap(config.categoryLimits);

    const files = fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.csv'));

    for (const file of files) {
        const fixtureName = path.basename(file, '.csv');

        it(`full chain matches legacy for fixture ${fixtureName}, all 10 tiers`, async () => {
            const products: LegacyPricingInput[] = [];
            const parser = fs.createReadStream(path.join(FIXTURES_DIR, file)).pipe(
                parse({ delimiter: ';', columns: true, skip_empty_lines: true })
            );

            for await (const row of parser) {
                products.push({
                    sku: row.code,
                    basePrice: new Decimal(row.price),
                    salePrice: row.actionPrice ? new Decimal(row.actionPrice) : undefined,
                    productMaxDiscount: row.maxDiscount ? new Decimal(row.maxDiscount) : undefined,
                    manufacturer: row.manufacturer,
                    category: row.categoryText,
                    allowLoyaltyDiscount: true,
                });
            }

            const mismatches: string[] = [];

            for (const tier of tiers) {
                for (const product of products) {
                    const input: LegacyPricingInput = { ...product, customerTier: tier as CustomerTier };

                    let legacy: ChainOutcome;
                    try {
                        legacy = runLegacyChain(input, engine, validationEngine);
                    } catch (err) {
                        legacy = { rejected: true, rejectReason: `THROW: ${(err as Error).message}`, appliedRules: [] };
                    }

                    let nexus: ChainOutcome & { steps: { rule: string; price: string }[] };
                    try {
                        nexus = runNexusChain(input, tierDecimals, brandLimits, categoryLimits);
                    } catch (err) {
                        nexus = { rejected: true, rejectReason: `THROW: ${(err as Error).message}`, appliedRules: [], steps: [] };
                    }

                    const legacyPrice = legacy.finalPrice?.toString();
                    const nexusPrice = nexus.finalPrice?.toString();

                    if (legacy.rejected !== nexus.rejected || legacyPrice !== nexusPrice) {
                        mismatches.push(
                            [
                                `SKU=${input.sku}`,
                                `customerTier=${tier}`,
                                `basePrice=${input.basePrice.toString()}`,
                                `salePrice=${input.salePrice?.toString() ?? '(none)'}`,
                                `productMaxDiscount=${input.productMaxDiscount?.toString() ?? '(none)'}`,
                                `legacy={rejected=${legacy.rejected}, reason=${legacy.rejectReason ?? '(none)'}, finalPrice=${legacyPrice ?? '(none)'}, appliedRules=[${legacy.appliedRules.join(',')}]}`,
                                `nexus={rejected=${nexus.rejected}, reason=${nexus.rejectReason ?? '(none)'}, finalPrice=${nexusPrice ?? '(none)'}, appliedRules=[${nexus.appliedRules.join(',')}]}`,
                                `nexus.steps=[${nexus.steps.map((s) => `${s.rule}:${s.price}`).join(' -> ')}]`,
                            ].join(' | ')
                        );
                    }
                }
            }

            if (mismatches.length > 0) {
                throw new Error(`${mismatches.length} mismatch(es) in fixture ${fixtureName}:\n${mismatches.join('\n')}`);
            }

            expect(mismatches).toEqual([]);
        });
    }
});
