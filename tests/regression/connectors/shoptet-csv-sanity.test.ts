// Sanity test proti skutečně portovanému Shoptet CSV parsing pipeline
// (connectors/shoptet/legacy/csv/), 1:1 kopie z ~/omega-bridge/src/adapters/
// shoptet-file/ (bez OrderReconstructor -- viz commit message pro důvod).
// Pipeline: CsvInputValidationGate (INPUT stage) -> ShoptetRowParser (per-row)
// -> CsvParserGate2 (PARSER stage). Ověřuje, že portovaný kód funguje, než
// se začne migrovat pod Nexus Rule contract.

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CsvInputValidationGate } from '../../../connectors/shoptet/legacy/csv/CsvInputValidationGate.js';
import { parseRow } from '../../../connectors/shoptet/legacy/csv/ShoptetRowParser.js';
import { CsvParserGate2 } from '../../../connectors/shoptet/legacy/csv/CsvParserGate2.js';
import { ShoptetOrderExportSchemaV1 } from '../../../connectors/shoptet/legacy/csv/ShoptetExportSchema.js';

function writeTempCsv(content: string): string {
    const filePath = path.join(os.tmpdir(), `shoptet-sanity-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`);
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
}

describe('Shoptet CSV pipeline sanity — INPUT gate', () => {
    it('valid CSV with all required columns passes and produces validRows', () => {
        const csv = 'Kód;Email;Jméno;Celková cena;Měna;Název položky;Množství;Cena za ks\n' +
            'ORD-1;test@example.com;Jan Novak;1000;CZK;Widget;2;500\n';
        const filePath = writeTempCsv(csv);

        const gate = new CsvInputValidationGate();
        const result = gate.validate({ filePath, expectedSchema: ShoptetOrderExportSchemaV1 });

        expect(result.valid).toBe(true);
        expect(result.validRows).toHaveLength(1);
        fs.unlinkSync(filePath);
    });

    it('missing required column fails validation', () => {
        const csv = 'Kód;Jméno\nORD-1;Jan Novak\n'; // missing Email, required
        const filePath = writeTempCsv(csv);

        const gate = new CsvInputValidationGate();
        const result = gate.validate({ filePath, expectedSchema: ShoptetOrderExportSchemaV1 });

        expect(result.valid).toBe(false);
        fs.unlinkSync(filePath);
    });

    it('nonexistent file fails with FILE_NOT_FOUND', () => {
        const gate = new CsvInputValidationGate();
        const result = gate.validate({ filePath: '/nonexistent/path.csv', expectedSchema: ShoptetOrderExportSchemaV1 });

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.code === 'FILE_NOT_FOUND')).toBe(true);
    });
});

describe('Shoptet CSV pipeline sanity — row parsing + PARSER gate', () => {
    it('accepted names variation (Kod vs Kód) still resolves to canonical field', () => {
        const csv = 'Kod;Email;Jméno;Celková cena;Měna;Název položky;Množství;Cena za ks\n' +
            'ORD-2;test@example.com;Jan Novak;1000;CZK;Widget;2;500\n';
        const filePath = writeTempCsv(csv);

        const inputGate = new CsvInputValidationGate();
        const inputResult = inputGate.validate({ filePath, expectedSchema: ShoptetOrderExportSchemaV1 });
        expect(inputResult.valid).toBe(true);

        const parsedRows = inputResult.validRows.map((row) => parseRow(row, ShoptetOrderExportSchemaV1));
        expect(parsedRows[0]?.fields['orderNumber']?.value).toBe('ORD-2');

        const parserGate = new CsvParserGate2();
        const parserResult = parserGate.validate({ inputRowsCount: inputResult.validRows.length, parsedRows });
        expect(parserResult.valid).toBe(true);
        expect(parserResult.acceptedRows).toHaveLength(1);

        fs.unlinkSync(filePath);
    });

    it('row missing orderNumber identity is rejected by PARSER gate', () => {
        const parsedRows = [
            { rowNumber: 2, fields: {}, errors: [] },
        ];
        const parserGate = new CsvParserGate2();
        const result = parserGate.validate({ inputRowsCount: 1, parsedRows });

        expect(result.valid).toBe(false);
        expect(result.rejectedRowsCount).toBe(1);
    });

    it('decimal comma normalization (1234,56 -> 1234.56)', () => {
        const csv = 'Kód;Email;Jméno;Celková cena;Měna;Název položky;Množství;Cena za ks\n' +
            'ORD-3;test@example.com;Jan Novak;"1234,56";CZK;Widget;2;500\n';
        const filePath = writeTempCsv(csv);

        const inputGate = new CsvInputValidationGate();
        const inputResult = inputGate.validate({ filePath, expectedSchema: ShoptetOrderExportSchemaV1 });
        const parsedRows = inputResult.validRows.map((row) => parseRow(row, ShoptetOrderExportSchemaV1));

        expect(parsedRows[0]?.fields['totalAmount.amount']?.value).toBe('1234.56');
        fs.unlinkSync(filePath);
    });
});
