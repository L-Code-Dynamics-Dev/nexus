import { describe, it, expect } from 'vitest';
import { ShoptetRowParserRule } from '../../../domains/shoptet/ShoptetRowParserRule.js';
import { CsvParserGateRule } from '../../../domains/shoptet/CsvParserGateRule.js';
import { parseRow } from '../../../connectors/shoptet/legacy/csv/ShoptetRowParser.js';
import { CsvParserGate2 } from '../../../connectors/shoptet/legacy/csv/CsvParserGate2.js';
import { ShoptetOrderExportSchemaV1 } from '../../../connectors/shoptet/legacy/csv/ShoptetExportSchema.js';
import type { ValidatedCsvRow } from '../../../connectors/shoptet/legacy/csv/CsvInputValidationGate.js';

describe('ShoptetRowParserRule parity vs legacy parseRow', () => {
    const rule = new ShoptetRowParserRule({ tenantId: 'ten_1', ruleId: 'shoptet-row-parser-v1', ruleVersion: '1' });

    it('matches legacy for a fully valid row', () => {
        const row: ValidatedCsvRow = {
            rowNumber: 2,
            rawColumns: {
                Kód: 'ORD-1', Email: 'Test@Example.com', Jméno: 'Jan Novak',
                'Celková cena': '1234,56', Měna: 'czk', 'Název položky': 'Widget',
                Množství: '2', 'Cena za ks': '500',
            },
        };
        const legacy = parseRow(row, ShoptetOrderExportSchemaV1);
        const nexus = rule.evaluate({ row, schema: ShoptetOrderExportSchemaV1 });
        expect(nexus).toEqual(legacy);
    });

    it('matches legacy for a row missing a required column', () => {
        const row: ValidatedCsvRow = { rowNumber: 3, rawColumns: { Kód: 'ORD-2', Jméno: 'Jan Novak' } };
        const legacy = parseRow(row, ShoptetOrderExportSchemaV1);
        const nexus = rule.evaluate({ row, schema: ShoptetOrderExportSchemaV1 });
        expect(nexus).toEqual(legacy);
        expect(nexus.errors.length).toBeGreaterThan(0);
    });
});

describe('CsvParserGateRule parity vs legacy CsvParserGate2', () => {
    const rule = new CsvParserGateRule({ tenantId: 'ten_1', ruleId: 'csv-parser-gate-v1', ruleVersion: '1' });
    const legacyGate = new CsvParserGate2();

    it('matches legacy for a valid batch', () => {
        const parsedRows = [{ rowNumber: 2, fields: { orderNumber: { value: 'ORD-1', raw: 'ORD-1', sourceColumn: 'Kód' } }, errors: [] }];
        const input = { inputRowsCount: 1, parsedRows };
        expect(rule.evaluate(input)).toEqual(legacyGate.validate(input));
    });

    it('matches legacy for row loss detection', () => {
        const input = { inputRowsCount: 5, parsedRows: [] };
        expect(rule.evaluate(input)).toEqual(legacyGate.validate(input));
    });

    it('matches legacy for missing identity', () => {
        const parsedRows = [{ rowNumber: 2, fields: {}, errors: [] }];
        const input = { inputRowsCount: 1, parsedRows };
        expect(rule.evaluate(input)).toEqual(legacyGate.validate(input));
    });
});
