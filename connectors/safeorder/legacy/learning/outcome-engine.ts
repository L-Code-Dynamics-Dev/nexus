import { OrderOutcomeType } from '../core/types.js';

/**
 * SafeOrder 9.8 — Closed-Loop Outcome Learning Engine with Counterfactual Awareness
 *
 * Invariant: RESTRICTED ≠ BAD CUSTOMER.
 * Unobserved counterfactuals (UNKNOWN_COUNTERFACTUAL) are excluded from ground-truth training datasets.
 */

export interface OutcomeRecord {
  orderRef: string;
  blindToken: string;
  predictedRiskScore: number;
  initialDecision: 'ALLOW' | 'REVIEW' | 'RESTRICT';
  finalOutcome: OrderOutcomeType;
  orderTotal: number;
  rtoLossAmount?: number;
  timestamp: number;
}

export interface LearningWeights {
  uncollectedWeightMultiplier: number;
  falsePositiveSuppressionFactor: number;
  highValueCodSensitivity: number;
}

export function computeAdaptiveWeights(
  outcomes: OutcomeRecord[],
  baseWeights: LearningWeights = {
    uncollectedWeightMultiplier: 1.0,
    falsePositiveSuppressionFactor: 1.0,
    highValueCodSensitivity: 1.0
  }
): {
  updatedWeights: LearningWeights;
  falsePositiveRate: number;
  rtoCatchRate: number;
  learningSignalsProcessed: number;
  counterfactualsExcludedCount: number;
} {
  if (outcomes.length === 0) {
    return {
      updatedWeights: baseWeights,
      falsePositiveRate: 0.0,
      rtoCatchRate: 1.0,
      learningSignalsProcessed: 0,
      counterfactualsExcludedCount: 0
    };
  }

  let totalRestrictedOrReviewed = 0;
  let falsePositiveCount = 0;
  let totalActualRto = 0;
  let preventedRtoCount = 0;
  let counterfactualsExcluded = 0;

  for (const out of outcomes) {
    // Exclude unobserved counterfactuals from supervised feedback
    if (out.finalOutcome === 'UNKNOWN_COUNTERFACTUAL') {
      counterfactualsExcluded++;
      continue;
    }

    if (out.initialDecision === 'RESTRICT' || out.initialDecision === 'REVIEW') {
      totalRestrictedOrReviewed++;
      // If restricted order was overridden by merchant and successfully delivered -> verified False Positive!
      if (out.finalOutcome === 'MERCHANT_OVERRIDE_SUCCESS' || out.finalOutcome === 'DELIVERED_SUCCESS') {
        falsePositiveCount++;
      }
    }

    if (out.finalOutcome === 'RTO_UNCOLLECTED' || out.finalOutcome === 'MERCHANT_OVERRIDE_FAILED') {
      totalActualRto++;
      if (out.initialDecision === 'RESTRICT') {
        preventedRtoCount++;
      }
    }
  }

  const falsePositiveRate = totalRestrictedOrReviewed > 0
    ? Math.round((falsePositiveCount / totalRestrictedOrReviewed) * 1000) / 1000
    : 0.0;

  const rtoCatchRate = totalActualRto > 0
    ? Math.round((preventedRtoCount / totalActualRto) * 1000) / 1000
    : 1.0;

  let uncollectedMultiplier = baseWeights.uncollectedWeightMultiplier;
  let suppressionFactor = baseWeights.falsePositiveSuppressionFactor;

  if (falsePositiveRate > 0.015) {
    uncollectedMultiplier = Math.max(0.7, uncollectedMultiplier * 0.9);
    suppressionFactor = Math.min(1.5, suppressionFactor * 1.15);
  } else if (falsePositiveRate < 0.003 && rtoCatchRate < 0.9) {
    uncollectedMultiplier = Math.min(1.3, uncollectedMultiplier * 1.05);
  }

  return {
    updatedWeights: {
      uncollectedWeightMultiplier: Math.round(uncollectedMultiplier * 100) / 100,
      falsePositiveSuppressionFactor: Math.round(suppressionFactor * 100) / 100,
      highValueCodSensitivity: baseWeights.highValueCodSensitivity
    },
    falsePositiveRate,
    rtoCatchRate,
    learningSignalsProcessed: outcomes.length - counterfactualsExcluded,
    counterfactualsExcludedCount: counterfactualsExcluded
  };
}
