import { ValidationResult } from '../../shoptet/legacy/validation/types.js';

export interface TargetPayload {
  content: string;
  encoding: string;
  payloadHash: string;
  documentCount: number;
  itemCount: number;
  correlationId: string;
}

export interface TargetAdapterResult<TPayload extends TargetPayload> {
  status: 'READY_FOR_DELIVERY' | 'OUTPUT_VALIDATION_FAILED' | 'SYSTEM_ERROR';
  payload?: TPayload;
  documentCount: number;
  itemCount: number;
  mappingVersion: string;
  validationResult: ValidationResult;
  errors: string[];
}

export interface ITargetAdapter<TDocument, TPayload extends TargetPayload> {
  mappingVersion: string;
  process(documents: TDocument[], correlationId: string): Promise<TargetAdapterResult<TPayload>>;
}
