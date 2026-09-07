// Parity test pro createNexusPricingCalculator samotnou (produkční factory,
// ne testovací helper) proti createLegacyPricingCalculator, na všech 70
// golden kombinacích. Toto je poslední ověření PŘED přepnutím
// PricingAdapteru -- factory funkce musí dávat stejný výsledek jako chain
// runner ověřený v full-chain-parity.test.ts, protože throw handling
// (Unknown customerTier) a shape výstupu (LegacyPricingResult) se mezi
// testovacím helperem a produkční factory mírně liší ve struktuře kódu.

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse';
import Decimal from 'decimal.js';

import { createLegacyPricingCalculator } from '../../../connectors/pricing-engine/createLegacyPricingCalculator.js';
import { createNexusPricingCalculator } from '../../../domains/pricing/createNexusPricingCalculator.js';
import { FsPricingConfigurationProvider } from '../../../connectors/pricing-engine/FsPricingConfigurationProvider.js';
import type { TenantContext } from '../../../core/tenant/types.js';
import type { LegacyPricingInput } from '../../../domains/pricing/PricingAdapter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '../../../connectors/pricing-engine/legacy/config/policies/policy-v1.json');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

describe('createNexusPricingCalculator parity vs createLegacyPricingCalculator (70 golden combinations)', () => {
    const legacyCalculate = createLegacyPricingCalculator(CONFIG_PATH);
    // Setup-only změna (P0 2026-09-07): factory teď bere provider + tenant
    // zvenku místo configPath. Stejný policy-v1.json, stejný chain, stejné
    // asserce -- parita proti legacy se nemění.
    const NEXUS_TENANT: TenantContext = { tenantId: 'ten_okfish', platform: 'shoptet' };
    const nexusCalculate = createNexusPricingCalculator(
        new FsPricingConfigurationProvider(CONFIG_PATH),
        NEXUS_TENANT
    );

    const tiers = ["ZR4", "ZR6", "ZR8", "ZR10", "ZR12", "ZR14", "ZR16", "ZR18", "ZR20", "ZR25"];
    const files = fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.csv'));

    for (const file of files) {
        const fixtureName = path.basename(file, '.csv');

        it(`matches for fixture ${fixtureName}, all 10 tiers`, async () => {
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
                    const input: LegacyPricingInput = { ...product, customerTier: tier };

                    let legacy;
                    try {
                        legacy = legacyCalculate(input);
                    } catch (err) {
                        legacy = { finalPrice: input.basePrice, appliedRules: [], rejected: true, rejectReason: `THROW: ${(err as Error).message}` };
                    }

                    let nexus;
                    try {
                        nexus = nexusCalculate(input);
                    } catch (err) {
                        nexus = { finalPrice: input.basePrice, appliedRules: [], rejected: true, rejectReason: `THROW: ${(err as Error).message}` };
                    }

                    if (legacy.rejected !== nexus.rejected || legacy.finalPrice.toString() !== nexus.finalPrice.toString()) {
                        mismatches.push(
                            `SKU=${input.sku} | tier=${tier} | basePrice=${input.basePrice} | salePrice=${input.salePrice ?? '(none)'} | ` +
                            `productMaxDiscount=${input.productMaxDiscount ?? '(none)'} | ` +
                            `legacy={rejected=${legacy.rejected}, finalPrice=${legacy.finalPrice}, rules=[${legacy.appliedRules.map((r) => r.rule).join(',')}]} | ` +
                            `nexus={rejected=${nexus.rejected}, finalPrice=${nexus.finalPrice}, rules=[${nexus.appliedRules.map((r) => r.rule).join(',')}]}`
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
