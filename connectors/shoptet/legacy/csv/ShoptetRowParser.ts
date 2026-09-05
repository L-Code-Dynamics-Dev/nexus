import { ShoptetExportSchema, ShoptetColumnDefinition } from './ShoptetExportSchema.js';
import { ValidatedCsvRow } from './CsvInputValidationGate.js';

export interface ParsedField {
  value: any;
  raw: string;
  sourceColumn: string;
}

export interface ShoptetParsedRow {
  rowNumber: number;
  fields: Record<string, ParsedField>; // key is canonicalField path
  errors: Array<{ field: string; message: string }>;
}

export const parseRow = (row: ValidatedCsvRow, schema: ShoptetExportSchema): ShoptetParsedRow => {
  const parsedRow: ShoptetParsedRow = {
    rowNumber: row.rowNumber,
    fields: {},
    errors: []
  };

  for (const colDef of schema.columns) {
    // Find the matching source column
    const sourceCol = colDef.acceptedSourceNames.find(name => row.rawColumns[name] !== undefined);
    
    if (sourceCol === undefined) {
      if (colDef.required) {
        parsedRow.errors.push({ field: colDef.canonicalField, message: 'Required column not found in row' });
      }
      continue;
    }

    // sourceCol byl nalezen přes .find() na stejném objektu (řádek výše),
    // takže rawColumns[sourceCol] existuje -- fallback na '' jen kvůli
    // noUncheckedIndexedAccess striktnosti Nexus tsconfig, ne legacy zmena chovani.
    const rawValue = row.rawColumns[sourceCol] ?? '';
    
    let parsedValue: any;
    try {
      parsedValue = colDef.parser(rawValue);
    } catch (e: any) {
      parsedRow.errors.push({ field: colDef.canonicalField, message: `Parser failed: ${e.message}` });
      continue;
    }

    // Normalization
    if (parsedValue !== undefined && parsedValue !== null && parsedValue !== '' && colDef.normalizationRules) {
      for (const rule of colDef.normalizationRules) {
        parsedValue = rule(parsedValue);
      }
    }

    // Validation post-parse
    if (colDef.validationRules) {
      for (const rule of colDef.validationRules) {
        const err = rule(parsedValue);
        if (err) {
          parsedRow.errors.push({ field: colDef.canonicalField, message: err });
        }
      }
    }

    if (colDef.required && (parsedValue === undefined || parsedValue === null || parsedValue === '')) {
      parsedRow.errors.push({ field: colDef.canonicalField, message: 'Required field resolved to empty value' });
    }

    parsedRow.fields[colDef.canonicalField] = {
      value: parsedValue,
      raw: rawValue,
      sourceColumn: sourceCol
    };
  }

  return parsedRow;
};
