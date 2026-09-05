import {
  RawRiskScore,
  RiskConfidence,
  RiskDecision,
  RiskDecisionType,
  TenantPolicyRecord
} from '../core/types.js';
import { calibrateRiskProbability } from '../calibration/calibration-engine.js';

/**
 * SafeOrder 9.8 — Versioned Policy Engine
 *
 * Combines calibrated fraud probability, comparative economic optimization,
 * evidentiary confidence constraints, and merchant policy thresholds.
 *
 * Invariant:
 * RISK ESTIMATION ≠ ECONOMIC DECISION ≠ POLICY ARBITRATION ≠ PLATFORM EXECUTION
 */

export interface PolicyEvaluationInput {
  rawScore: RawRiskScore;
  confidence: RiskConfidence;
  reasonCodes: string[];
  activeSignalCount: number;
  economicRecommendedAction?: string;
}

export function evaluatePolicy(
  input: PolicyEvaluationInput,
  tenantPolicy?: TenantPolicyRecord
): RiskDecision {
  const version = tenantPolicy?.policy_version ?? 'policy-v1';
  const reviewThresh = tenantPolicy?.review_threshold ?? 0.8;
  const restrictThresh = tenantPolicy?.restrict_threshold ?? 1.8;

  // 1. Deterministic Parametric Probability Calibration
  const { probability, calibrationVersion } = calibrateRiskProbability(input.rawScore, 'calib-v1-logistic');

  let decision: RiskDecisionType = 'ALLOW';

  // 2. Classify Confidence Profile (Confidence Gating)
  const isTrustedCustomer = input.confidence >= 0.85 && input.reasonCodes.includes('TRUSTED_REPEAT_BUYER');
  const isUnknownCustomer = input.confidence < 0.45 && input.reasonCodes.includes('FIRST_TIME_BUYER');
  const isHighConfidenceRisk = input.confidence >= 0.65;

  // 3. Evaluate Economic Recommendations
  const isEconomicRestrict = input.economicRecommendedAction === 'RESTRICT_COD';
  const isEconomicPrepayment = input.economicRecommendedAction === 'REQUIRE_PREPAYMENT';
  const isEconomicReview = input.economicRecommendedAction === 'REVIEW';

  // 4. Policy Arbitration
  if (isTrustedCustomer) {
    // Trusted customers bypass thresholds unless economics strictly dictate RESTRICT (unlikely with low probability)
    decision = isEconomicRestrict ? 'RESTRICT' : 'ALLOW';
  } else if (isUnknownCustomer) {
    // LOW CONFIDENCE / UNKNOWN CUSTOMER
    // Do not penalize typical behavior (COD + normal basket). Rely heavily on economics.
    // If raw score crosses restrict threshold, downgrade to REVIEW unless economically justified.
    if (input.rawScore >= restrictThresh * 2.0) {
       decision = 'RESTRICT';
    } else if (isEconomicRestrict || input.rawScore >= reviewThresh * 1.5) {
       decision = 'REVIEW';
    } else {
       decision = 'ALLOW';
    }
  } else {
    // ESTABLISHED / STANDARD CONFIDENCE
    const isHighRiskScore = input.rawScore >= restrictThresh;
    const isElevatedRiskScore = input.rawScore >= reviewThresh;

    if (isHighRiskScore || isEconomicRestrict) {
      // Guard against RESTRICT if confidence is low, though caught by isUnknownCustomer mostly
      if (input.confidence < 0.25 && input.rawScore < 2.5) {
        decision = 'REVIEW';
      } else {
        decision = 'RESTRICT';
      }
    } else if (isElevatedRiskScore || isEconomicPrepayment || isEconomicReview) {
      decision = 'REVIEW';
    } else {
      decision = 'ALLOW';
    }
  }

  return {
    decision,
    rawScore: input.rawScore,
    calibratedProbability: probability,
    confidence: input.confidence,
    reasonCodes: input.reasonCodes.length > 0 ? input.reasonCodes : ['NO_ADVERSE_SIGNALS'],
    policyVersion: version,
    calibrationVersion
  };
}
