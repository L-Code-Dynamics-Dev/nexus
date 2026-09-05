import { DecisionAuditRecord, Platform, RiskDecision } from '../core/types.js';

export interface CreateAuditInput {
  decisionId: string;
  tenantId: string;
  platform: Platform;
  checkoutSessionId?: string;
  orderRef?: string;
  blindToken: string;
  decision: RiskDecision;
  signalCount: number;
  failOpen?: boolean;
  failOpenReason?: string;
}

export function buildAuditRecord(input: CreateAuditInput): DecisionAuditRecord {
  return {
    decision_id: input.decisionId,
    tenant_id: input.tenantId,
    platform: input.platform,
    checkout_session_id: input.checkoutSessionId ?? null,
    order_ref: input.orderRef ?? null,
    blind_token: input.blindToken,
    decision: input.decision.decision,
    raw_score: input.decision.rawScore,
    calibrated_probability: input.decision.calibratedProbability,
    confidence: input.decision.confidence,
    reason_codes: input.decision.reasonCodes.join(','),
    signal_count: input.signalCount,
    policy_version: input.decision.policyVersion,
    calibration_version: input.decision.calibrationVersion,
    economic_model_version: 'eco-v1-comparative',
    fail_open: input.failOpen ? 1 : 0,
    fail_open_reason: input.failOpenReason ?? null,
    created_at: Date.now()
  };
}
