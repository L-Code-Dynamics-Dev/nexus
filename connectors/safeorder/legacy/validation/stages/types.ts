export enum ValidationStage {
  INPUT = 'INPUT',
  IDENTITY = 'IDENTITY',
  SIGNAL = 'SIGNAL',
  RISK_POLICY = 'RISK_POLICY',
  DECISION_ACTION = 'DECISION_ACTION'
}

export interface StageValidationResult<T = unknown> {
  stage: ValidationStage;
  passed: boolean;
  code: string;
  data?: T;
  error?: string;
  details?: Record<string, unknown>;
  durationMs: number;
}

export interface PipelineAuditTrace {
  decisionId: string;
  orderRef?: string;
  stages: Record<ValidationStage, StageValidationResult>;
  passedAll: boolean;
  failedAtStage?: ValidationStage;
  failureCode?: string;
  totalDurationMs: number;
}
