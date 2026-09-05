import { ValidationGate, AbstractValidationGate } from '../validation/ValidationPipeline.js';
import { ValidationResult, createResult, addError, addWarning } from '../validation/types.js';
import { ShoptetParsedRow } from './ShoptetRowParser.js';

export interface ParserGate2Payload {
  inputRowsCount: number;
  parsedRows: ShoptetParsedRow[];
}

export interface ParserValidationResult extends ValidationResult {
  acceptedRows: ShoptetParsedRow[];
  rejectedRowsCount: number;
}

export class CsvParserGate2 extends AbstractValidationGate<ParserGate2Payload> {
  constructor() {
    super(ValidationGate.PARSER);
  }

  validate(payload: ParserGate2Payload): ParserValidationResult {
    const result: ParserValidationResult = {
      ...createResult(),
      acceptedRows: [],
      rejectedRowsCount: 0
    };

    if (payload.inputRowsCount === 0) {
      addError(result, 'ZERO_INPUT_ROWS', '', 'No input rows provided to Gate 2');
      return result;
    }

    if (payload.parsedRows.length !== payload.inputRowsCount) {
      addError(result, 'ROW_LOSS_DETECTED', '', `Input rows (${payload.inputRowsCount}) does not match parsed rows (${payload.parsedRows.length})`);
      // We do not return immediately, we want to process the rest to gather errors
    }

    const orderNumberSet = new Set<string>();

    for (const row of payload.parsedRows) {
      if (row.errors.length > 0) {
        // Row has parsing errors
        for (const err of row.errors) {
          addError(result, 'ROW_PARSE_ERROR', `row_${row.rowNumber}.${err.field}`, err.message);
        }
        result.rejectedRowsCount++;
        continue;
      }

      // Check required identity for clustering
      const orderNumField = row.fields['orderNumber'];
      if (!orderNumField || !orderNumField.value) {
        addError(result, 'ROW_MISSING_IDENTITY', `row_${row.rowNumber}`, 'Cannot identify orderNumber for this row');
        result.rejectedRowsCount++;
        continue;
      }

      orderNumberSet.add(orderNumField.value);
      result.acceptedRows.push(row);
    }

    if (result.rejectedRowsCount > 0) {
      // The requirement says "Any blocking validation failure must stop the pipeline."
      // So if any row is rejected, we consider the whole batch INVALID to avoid partial success
      // unless partial success is explicitly requested by the business. 
      // The prompt says "pipeline must according to severity stop or create explicit rejection".
      // We set valid = false because errors were added via addError.
    }

    // Duplicate detection (not order duplicates, but row duplicates if exact match)
    // Could be implemented here if required.

    return result;
  }
}
