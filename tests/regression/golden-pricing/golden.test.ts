// Portováno z ~/okfish-pricing-engine/tests/golden.test.ts beze změny logiky
// (per MIGRATION_PLAN.md Fáze 1: REGRESSION TEST musí projít se stejnými
// výsledky jako legacy). Legacy engine je zde přímý import z
// connectors/pricing-engine/legacy/ -- 1:1 portovaný kód, ne re-implementace.

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse';
import Decimal from 'decimal.js';
import { EngineBuilder } from '../../../connectors/pricing-engine/legacy/core/EngineBuilder.js';
import { ValidationEngine } from '../../../connectors/pricing-engine/legacy/core/ValidationEngine.js';
import { writeProductsCsv } from '../../../connectors/pricing-engine/legacy/csv/writer.js';
import { PricingInput } from '../../../connectors/pricing-engine/legacy/core/interfaces.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('Golden Dataset Regression — legacy Pricing Engine (portováno z okfish)', () => {
    const configPath = path.join(__dirname, '../../../connectors/pricing-engine/legacy/config/policies/policy-v1.json');
    const engine = EngineBuilder.fromConfig(configPath).build();
    const validationEngine = new ValidationEngine();
    const tiers = ["ZR4", "ZR6", "ZR8", "ZR10", "ZR12", "ZR14", "ZR16", "ZR18", "ZR20", "ZR25"] as const;
    const fixturesDir = path.join(__dirname, 'fixtures');
    const expectedDir = path.join(fixturesDir, 'expected');

    const files = fs.readdirSync(fixturesDir).filter(f => f.endsWith('.csv'));

    for (const file of files) {
        const fixtureName = path.basename(file, '.csv');

        it(`Should match expected output for ${fixtureName}`, async () => {
            const tempDir = fs.mkdtempSync(path.join(fixturesDir, `temp-${fixtureName}-`));
            const products: PricingInput[] = [];

            const parser = fs.createReadStream(path.join(fixturesDir, file)).pipe(parse({
                delimiter: ';',
                columns: true,
                skip_empty_lines: true
            }));

            for await (const row of parser) {
                products.push({
                    sku: row.code,
                    basePrice: new Decimal(row.price),
                    salePrice: row.actionPrice ? new Decimal(row.actionPrice) : undefined,
                    productMaxDiscount: row.maxDiscount ? new Decimal(row.maxDiscount) : undefined,
                    manufacturer: row.manufacturer,
                    category: row.categoryText,
                    allowLoyaltyDiscount: true
                });
            }

            try {
                for (const tier of tiers) {
                    const results = [];
                    for (const product of products) {
                        try {
                            const p = { ...product, customerTier: tier };
                            if (!validationEngine.validateInput(p).valid) continue;
                            const res = engine.calculatePrice(p);
                            if (!validationEngine.validateResult(res).valid) continue;
                            if (!res.rejected) {
                                results.push(res);
                            }
                        } catch (err) {
                            // Ignore throws — parity se stejným chováním jako legacy test
                        }
                    }

                    const tempFile = path.join(tempDir, `${tier}.csv`);
                    await writeProductsCsv(tempFile, results);

                    const expectedFile = path.join(expectedDir, fixtureName, `${tier}.csv`);
                    const tempContent = fs.readFileSync(tempFile, 'utf8');
                    const expectedContent = fs.readFileSync(expectedFile, 'utf8');

                    expect(tempContent).toBe(expectedContent);
                }
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });
    }
});
