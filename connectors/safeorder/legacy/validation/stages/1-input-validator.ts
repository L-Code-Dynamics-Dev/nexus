import { CheckoutEvaluationRequest, CheckoutEvaluationRequestSchema } from '../../core/types.js';
import { StageValidationResult, ValidationStage } from './types.js';

/**
 * Stage 1: Input Validation (Input Guard)
 *
 * Verifies payload schema, datatypes, positive total, non-empty checkout session,
 * explicit payment method, and uppercase currency.
 */
export function validateInputStage(rawPayload: unknown): StageValidationResult<CheckoutEvaluationRequest> {
  const start = performance.now();

  if (!rawPayload || typeof rawPayload !== 'object') {
    return {
      stage: ValidationStage.INPUT,
      passed: false,
      code: 'INPUT_INVALID_PAYLOAD_TYPE',
      error: 'Payload must be a non-null JSON object.',
      durationMs: Math.round((performance.now() - start) * 100) / 100
    };
  }

  const parseResult = CheckoutEvaluationRequestSchema.safeParse(rawPayload);

  if (!parseResult.success) {
    const issue = parseResult.error.issues[0];
    return {
      stage: ValidationStage.INPUT,
      passed: false,
      code: 'INPUT_SCHEMA_VALIDATION_FAILED',
      error: issue ? `${issue.path.join('.')}: ${issue.message}` : 'Schema validation failed.',
      details: { issues: parseResult.error.issues },
      durationMs: Math.round((performance.now() - start) * 100) / 100
    };
  }

  return {
    stage: ValidationStage.INPUT,
    passed: true,
    code: 'INPUT_VALID',
    data: parseResult.data,
    durationMs: Math.round((performance.now() - start) * 100) / 100
  };
}
