import { Decimal } from 'decimal.js';
import { AbstractValidationGate, ValidationGate } from '../../shoptet/legacy/validation/ValidationPipeline.js';
import { ValidationResult, createResult, addError, addWarning } from '../../shoptet/legacy/validation/types.js';
import { CanonicalAccountingDocument } from './core/CanonicalAccountingDocument.js';
import { OmegaImportPayload } from './OmegaPayload.js';

export interface OmegaOutputGatePayload {
  sourceDocuments: CanonicalAccountingDocument[];
  generatedPayload: OmegaImportPayload;
}

export class OmegaOutputValidationGate extends AbstractValidationGate<OmegaOutputGatePayload> {
  constructor() {
    super(ValidationGate.OUTPUT);
  }

  validate(payload: OmegaOutputGatePayload): ValidationResult {
    const result = createResult();

    const lines = payload.generatedPayload.content.split('\r\n').filter(l => l.trim() !== '');

    let parsedDocCount = 0;
    let parsedItemCount = 0;
    const documentTotalMap = new Map<string, Decimal>();

    for (const line of lines) {
      const parts = line.split('\t');
      if (parts[0] === 'R01') {
        parsedDocCount++;
        // parts[1] může být undefined (řádek s méně sloupci než R01 formát
        // předpokládá) -- legacy fallback na '' jako klíč mapy, ZACHOVÁNO
        // beze změny (noUncheckedIndexedAccess Nexus tsconfig striktnost,
        // ne behaviorální oprava): !docId check přidá error, ale POKRAČUJE
        // dál se stejným (prázdným) klíčem, přesně jak originál dělal
        // implicitně přes `undefined` jako Map klíč.
        const docId = parts[1] ?? '';
        if (!docId) {
          addError(result, 'R01_MISSING_ID', 'R01', 'R01 row is missing document ID');
        }
        documentTotalMap.set(docId, new Decimal(0));
      } else if (parts[0] === 'R02') {
        parsedItemCount++;
        const docId = parts[1] ?? '';
        if (!docId) {
          addError(result, 'R02_MISSING_ID', 'R02', 'R02 row is missing document ID');
        }

        // Parts[7] should be totalWithTax based on our mapper spec
        const amountStr = parts[7];
        if (amountStr) {
          try {
            const amount = new Decimal(amountStr.replace(',', '.'));
            if (documentTotalMap.has(docId)) {
              documentTotalMap.set(docId, documentTotalMap.get(docId)!.plus(amount));
            }
          } catch (e) {
            addError(result, 'R02_INVALID_DECIMAL', 'R02[7]', `Invalid decimal format: ${amountStr}`);
          }
        } else {
          addError(result, 'R02_MISSING_AMOUNT', 'R02[7]', 'Total amount missing on item line');
        }
      }
    }

    // 1. Structural count reconciliation
    if (parsedDocCount !== payload.sourceDocuments.length) {
      addError(result, 'OUTPUT_DOC_COUNT_MISMATCH', '', `Expected ${payload.sourceDocuments.length} docs, but generated payload has ${parsedDocCount}`);
    }
    
    let expectedItemsCount = 0;
    for (const doc of payload.sourceDocuments) {
      expectedItemsCount += doc.lines.length;
    }

    if (parsedItemCount !== expectedItemsCount) {
      addError(result, 'OUTPUT_ITEM_COUNT_MISMATCH', '', `Expected ${expectedItemsCount} items, but generated payload has ${parsedItemCount}`);
    }

    // 2. Financial reconciliation (Output payload vs Canonical Source)
    for (const doc of payload.sourceDocuments) {
      const parsedTotal = documentTotalMap.get(doc.sourceDocumentId);
      if (parsedTotal === undefined) {
        addError(result, 'OUTPUT_MISSING_DOCUMENT', doc.sourceDocumentId, 'Document missing in generated payload');
        continue;
      }

      if (!parsedTotal.equals(doc.summary.totalWithTax)) {
        addError(result, 'OUTPUT_TOTAL_MISMATCH', doc.sourceDocumentId, `Source total (${doc.summary.totalWithTax}) != Generated payload total (${parsedTotal})`);
      }
    }

    return result;
  }
}
