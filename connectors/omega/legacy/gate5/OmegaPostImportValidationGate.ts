import { AbstractValidationGate, ValidationGate } from '../../../shoptet/legacy/validation/ValidationPipeline.js';
import { ValidationResult, createResult, addError } from '../../../shoptet/legacy/validation/types.js';
import { AgentEvidence } from '../agent/AgentEvidence.js';
import { OmegaImportLogParser } from './OmegaImportLogParser.js';

export interface Gate5Payload {
  expectedDocumentIds: string[];
  evidence: AgentEvidence;
}

export interface Gate5Result extends ValidationResult {
  finalStatus: 'COMPLETED' | 'POST_IMPORT_VALIDATION_FAILED' | 'TARGET_RESULT_UNKNOWN' | 'QUARANTINED';
}

export class OmegaPostImportValidationGate extends AbstractValidationGate<Gate5Payload> {
  private parser = new OmegaImportLogParser();

  constructor() {
    super(ValidationGate.POST_IMPORT);
  }

  validate(payload: Gate5Payload): Gate5Result {
    const result: Gate5Result = {
      ...createResult(),
      finalStatus: 'TARGET_RESULT_UNKNOWN'
    };

    const evidence = payload.evidence;

    // 1. EXECUTION VALIDATION
    if (!evidence.payloadHashVerified) {
      addError(result, 'PAYLOAD_INTEGRITY_FAILED', '', 'Payload hash was not verified by agent');
      result.finalStatus = 'QUARANTINED';
      return result;
    }

    if (!evidence.executorResult) {
      addError(result, 'MISSING_EXECUTION_EVIDENCE', '', 'Agent provided no execution result');
      result.finalStatus = 'TARGET_RESULT_UNKNOWN'; // We don't know what happened
      return result;
    }

    if (evidence.executorResult.exitCode !== 0) {
      addError(result, 'NON_ZERO_EXIT_CODE', '', `Process exited with code ${evidence.executorResult.exitCode}`);
      result.finalStatus = 'TARGET_RESULT_UNKNOWN';
      return result;
    }

    // 2. LOG VALIDATION
    const logParseResult = this.parser.parse(evidence.executorResult.logContent);
    
    if (logParseResult.errors.includes('LOG_MISSING')) {
      addError(result, 'LOG_MISSING', '', 'Omega import log is missing despite successful exit code');
      result.finalStatus = 'TARGET_RESULT_UNKNOWN';
      return result;
    }

    if (logParseResult.errors.length > 0) {
      addError(result, 'LOG_CONTAINS_ERRORS', '', `Omega log reported errors: ${logParseResult.errors.join(', ')}`);
      result.finalStatus = 'POST_IMPORT_VALIDATION_FAILED';
      return result;
    }

    // 3 & 4 & 5. COUNT & DOCUMENT IDENTITY RECONCILIATION
    const importedIds = logParseResult.importedDocumentIds;
    
    if (importedIds.length !== payload.expectedDocumentIds.length) {
      addError(result, 'IMPORT_COUNT_MISMATCH', '', `Expected ${payload.expectedDocumentIds.length} docs, but log confirms ${importedIds.length}`);
      result.finalStatus = 'POST_IMPORT_VALIDATION_FAILED';
      return result;
    }

    for (const expectedId of payload.expectedDocumentIds) {
      if (!importedIds.includes(expectedId)) {
        addError(result, 'DOCUMENT_NOT_CONFIRMED', expectedId, `Document ${expectedId} is missing from success log`);
        result.finalStatus = 'POST_IMPORT_VALIDATION_FAILED';
      }
    }

    if (!result.valid) {
      return result;
    }

    result.finalStatus = 'COMPLETED';
    return result;
  }
}
