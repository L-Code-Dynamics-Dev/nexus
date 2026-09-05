import { CanonicalAccountingDocument } from './core/CanonicalAccountingDocument.js';
import { ITargetAdapter, TargetAdapterResult } from './TargetAdapter.js';
import { OmegaImportPayload } from './OmegaPayload.js';
import { OmegaMapper } from './OmegaMapper.js';
import { OmegaOutputValidationGate } from './OmegaOutputValidationGate.js';

export class OmegaAdapter implements ITargetAdapter<CanonicalAccountingDocument, OmegaImportPayload> {
  mappingVersion = 'OMEGA-MAPPING-V1';
  
  private mapper: OmegaMapper;
  private gate: OmegaOutputValidationGate;

  constructor() {
    this.mapper = new OmegaMapper();
    this.gate = new OmegaOutputValidationGate();
  }

  async process(documents: CanonicalAccountingDocument[], correlationId: string): Promise<TargetAdapterResult<OmegaImportPayload>> {
    try {
      // 1. Map without business logic
      const payload = this.mapper.map(documents, correlationId);

      // 2. Output Validation & Reconciliation (GATE 4)
      const validationResult = this.gate.validate({
        sourceDocuments: documents,
        generatedPayload: payload
      });

      if (!validationResult.valid) {
        return {
          status: 'OUTPUT_VALIDATION_FAILED',
          documentCount: payload.documentCount,
          itemCount: payload.itemCount,
          mappingVersion: this.mappingVersion,
          validationResult,
          errors: validationResult.errors.map(e => `${e.code}: ${e.message}`)
        };
      }

      return {
        status: 'READY_FOR_DELIVERY',
        payload,
        documentCount: payload.documentCount,
        itemCount: payload.itemCount,
        mappingVersion: this.mappingVersion,
        validationResult,
        errors: []
      };

    } catch (e: any) {
      return {
        status: 'SYSTEM_ERROR',
        documentCount: 0,
        itemCount: 0,
        mappingVersion: this.mappingVersion,
        validationResult: { valid: false, errors: [], warnings: [] },
        errors: [`Unhandled adapter exception: ${e.message}`]
      };
    }
  }
}
