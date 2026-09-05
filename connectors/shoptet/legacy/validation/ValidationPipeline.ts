import { ValidationResult } from './types.js';

export enum ValidationGate {
  INPUT = 'INPUT_VALIDATION',
  PARSER = 'PARSER_VALIDATION',
  CORE = 'CORE_DOMAIN_VALIDATION',
  OUTPUT = 'OUTPUT_TARGET_VALIDATION',
  POST_IMPORT = 'POST_IMPORT_VALIDATION'
}

export interface IValidationGate<TInput> {
  gateType: ValidationGate;
  validate(payload: TInput): ValidationResult;
}

/**
 * Ensures that validation logic is not scattered as if-statements,
 * but formally implemented as explicit, testable gates.
 */
export abstract class AbstractValidationGate<TInput> implements IValidationGate<TInput> {
  constructor(public readonly gateType: ValidationGate) {}
  
  abstract validate(payload: TInput): ValidationResult;
}
