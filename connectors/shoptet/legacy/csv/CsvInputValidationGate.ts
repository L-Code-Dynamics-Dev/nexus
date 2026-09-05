import * as fs from 'fs';
import Papa from 'papaparse';
import { ValidationGate, AbstractValidationGate } from '../validation/ValidationPipeline.js';
import { ValidationResult, createResult, addError, addWarning } from '../validation/types.js';
import { ShoptetExportSchema } from './ShoptetExportSchema.js';

export interface CsvInputPayload {
  filePath: string;
  expectedSchema: ShoptetExportSchema;
}

export interface ValidatedCsvRow {
  rowNumber: number;
  rawColumns: Record<string, string>;
}

export interface CsvInputValidationResult extends ValidationResult {
  detectedDelimiter?: string;
  headers?: string[];
  validRows: ValidatedCsvRow[];
  rejectedRowsCount: number;
}

export class CsvInputValidationGate extends AbstractValidationGate<CsvInputPayload> {
  constructor() {
    super(ValidationGate.INPUT);
  }

  validate(payload: CsvInputPayload): CsvInputValidationResult {
    const result: CsvInputValidationResult = {
      ...createResult(),
      validRows: [],
      rejectedRowsCount: 0
    };

    if (!fs.existsSync(payload.filePath)) {
      addError(result, 'FILE_NOT_FOUND', 'filePath', 'The specified file does not exist');
      return result;
    }

    let fileContent: string;
    try {
      fileContent = fs.readFileSync(payload.filePath, 'utf8');
      // Very basic encoding check: if it contains Replacement Character, it might be wrong encoding
      if (fileContent.includes('\uFFFD')) {
        addError(result, 'FILE_ENCODING_INVALID', 'encoding', 'File contains invalid characters, expected UTF-8');
        return result;
      }
    } catch (e: any) {
      addError(result, 'FILE_READ_ERROR', 'filePath', `Could not read file: ${e.message}`);
      return result;
    }

    const parseOptions: Papa.ParseConfig = {
      header: true,
      skipEmptyLines: true,
    };

    const parsed = Papa.parse<Record<string, string>>(fileContent, parseOptions);

    if (parsed.errors.length > 0) {
      // Analyze PapaParse errors
      for (const err of parsed.errors) {
        if (err.type === 'Delimiter') {
          addError(result, 'DELIMITER_DETECTION_FAILED', 'format', err.message);
        } else {
          addWarning(result, 'MALFORMED_ROW', `row_${err.row}`, err.message);
          result.rejectedRowsCount++;
        }
      }
    }

    if (!parsed.meta.fields || parsed.meta.fields.length === 0) {
      addError(result, 'HEADERS_MISSING', 'header', 'No CSV headers found');
      return result;
    }

    const headers = parsed.meta.fields;
    result.headers = headers;
    result.detectedDelimiter = parsed.meta.delimiter;

    // Check for duplicate headers
    const uniqueHeaders = new Set(headers);
    if (uniqueHeaders.size !== headers.length) {
      addError(result, 'DUPLICATE_HEADERS', 'header', 'CSV contains duplicate column headers');
    }

    // Verify required schema columns exist in the header
    const schema = payload.expectedSchema;
    for (const columnDef of schema.columns) {
      if (columnDef.required) {
        const found = columnDef.acceptedSourceNames.some(acceptedName => headers.includes(acceptedName));
        if (!found) {
          addError(result, 'REQUIRED_COLUMN_MISSING', 'header', `Required column missing. Expected one of: ${columnDef.acceptedSourceNames.join(', ')}`);
        }
      }
    }

    if (!result.valid) {
      return result;
    }

    // Process rows
    let rowNum = 2; // Usually row 1 is header
    for (const row of parsed.data) {
      // PapaParse returns an object map when header: true
      const hasData = Object.values(row).some(v => v !== null && v !== undefined && v !== '');
      if (!hasData) {
        continue;
      }
      
      // If row has fewer keys than headers, PapaParse handles it but we want strict structural checks
      const rowKeys = Object.keys(row);
      if (rowKeys.length !== headers.length) {
        addWarning(result, 'ROW_COLUMN_COUNT_MISMATCH', `row_${rowNum}`, `Row has ${rowKeys.length} columns, expected ${headers.length}`);
        result.rejectedRowsCount++;
      } else {
        result.validRows.push({
          rowNumber: rowNum,
          rawColumns: row
        });
      }
      rowNum++;
    }

    if (result.validRows.length === 0) {
      addError(result, 'NO_DATA_ROWS', 'content', 'CSV contains no valid data rows');
    }

    return result;
  }
}
