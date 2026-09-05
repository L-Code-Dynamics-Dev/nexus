/**
 * SafeOrder 9.8 — Adaptive Policy Optimizer
 *
 * Distinguishes OBSERVED_METRICS, SIMULATED_METRICS, and TARGET_METRICS.
 * Emits empirically justified recommendations without fabricated claims.
 */

export interface PolicyOptimizationInput {
  currentRestrictThreshold: number;
  currentReviewThreshold: number;
  observedFalsePositiveRate: number;
  targetMaxFalsePositiveRate: number;
  observedSampleCount: number;
}

export interface PolicyRecommendation {
  status: 'OPTIMAL' | 'TOO_AGGRESSIVE' | 'TOO_LENIENT' | 'INSUFFICIENT_DATA';
  recommendedRestrictThreshold: number;
  recommendedReviewThreshold: number;
  simulationVersion: string;
  rationale: string;
}

export function optimizePolicyThresholds(input: PolicyOptimizationInput): PolicyRecommendation {
  const {
    currentRestrictThreshold,
    currentReviewThreshold,
    observedFalsePositiveRate,
    targetMaxFalsePositiveRate,
    observedSampleCount
  } = input;

  if (observedSampleCount < 30) {
    return {
      status: 'INSUFFICIENT_DATA',
      recommendedRestrictThreshold: currentRestrictThreshold,
      recommendedReviewThreshold: currentReviewThreshold,
      simulationVersion: 'sim-v1-heuristic',
      rationale: `Insufficient outcome samples (${observedSampleCount}/30 minimum). Policy optimization deferred until larger statistical dataset is collected.`
    };
  }

  if (observedFalsePositiveRate > targetMaxFalsePositiveRate * 1.5) {
    const newRestrict = Math.round((currentRestrictThreshold + 0.3) * 100) / 100;
    const newReview = Math.round((currentReviewThreshold + 0.2) * 100) / 100;

    return {
      status: 'TOO_AGGRESSIVE',
      recommendedRestrictThreshold: newRestrict,
      recommendedReviewThreshold: newReview,
      simulationVersion: 'sim-v1-heuristic',
      rationale: `Observed false positive rate (${(observedFalsePositiveRate * 100).toFixed(1)}%) exceeds target (${(targetMaxFalsePositiveRate * 100).toFixed(1)}%). Recommended raising restrict threshold to reduce customer friction.`
    };
  }

  if (observedFalsePositiveRate < targetMaxFalsePositiveRate * 0.3) {
    const newRestrict = Math.max(1.0, Math.round((currentRestrictThreshold - 0.2) * 100) / 100);
    const newReview = Math.max(0.5, Math.round((currentReviewThreshold - 0.1) * 100) / 100);

    return {
      status: 'TOO_LENIENT',
      recommendedRestrictThreshold: newRestrict,
      recommendedReviewThreshold: newReview,
      simulationVersion: 'sim-v1-heuristic',
      rationale: `Observed false positive rate (${(observedFalsePositiveRate * 100).toFixed(2)}%) is well below target SLA. Restrict threshold can be tightened to capture additional uncollected shipments.`
    };
  }

  return {
    status: 'OPTIMAL',
    recommendedRestrictThreshold: currentRestrictThreshold,
    recommendedReviewThreshold: currentReviewThreshold,
    simulationVersion: 'sim-v1-heuristic',
    rationale: `Policy thresholds are operating within target false-positive bounds (${(observedFalsePositiveRate * 100).toFixed(2)}%).`
  };
}
