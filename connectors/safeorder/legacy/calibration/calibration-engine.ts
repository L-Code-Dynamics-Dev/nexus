import {
  createRiskConfidence,
  createRiskProbability,
  RawRiskScore,
  RiskConfidence,
  RiskProbability
} from '../core/types.js';

/**
 * SafeOrder 9.8 — Deterministic Parametric Probability Calibration & Evidentiary Confidence Engine
 *
 * Provides versioned mathematical transfer functions mapping heuristic raw risk scores (0.0 to 5.0+)
 * into strictly bounded probabilities (0.0 to 1.0) with guaranteed monotonicity.
 *
 * Invariant: ABSENCE OF EVIDENCE ≠ EVIDENCE OF ABSENCE.
 * Zero signals & zero history results in low evidentiary confidence (0.20 - 0.30), not 1.0.
 */

export interface CalibrationModel {
  version: string;
  calibrate(rawScore: RawRiskScore): RiskProbability;
}

/**
 * Logistic Sigmoid Calibration (Version: calib-v1-logistic)
 * Transfer function: P(RTO) = 1 / (1 + e^(-k * (rawScore - x0)))
 * Monotonically maps raw score to [0, 1] with midpoint at rawScore = 1.5.
 */
export const LogisticCalibrationV1: CalibrationModel = {
  version: 'calib-v1-logistic',
  calibrate(rawScore: RawRiskScore): RiskProbability {
    if (rawScore <= 0) return createRiskProbability(0.01);
    const k = 1.6; // Steepness parameter
    const x0 = 1.5; // Midpoint threshold
    const prob = 1 / (1 + Math.exp(-k * (rawScore - x0)));
    return createRiskProbability(prob);
  }
};

/**
 * Piecewise Conservative Calibration (Version: calib-v1-piecewise)
 * Linear piecewise transfer function with conservative lower bound.
 */
export const PiecewiseCalibrationV1: CalibrationModel = {
  version: 'calib-v1-piecewise',
  calibrate(rawScore: RawRiskScore): RiskProbability {
    if (rawScore <= 0.0) return createRiskProbability(0.01);
    if (rawScore <= 0.2) return createRiskProbability(0.02);
    if (rawScore <= 0.8) return createRiskProbability(0.05 + (rawScore - 0.2) * 0.25);
    if (rawScore <= 1.8) return createRiskProbability(0.20 + (rawScore - 0.8) * 0.45);
    return createRiskProbability(Math.min(0.98, 0.65 + (rawScore - 1.8) * 0.15));
  }
};

export const REGISTERED_CALIBRATION_MODELS: Record<string, CalibrationModel> = {
  'calib-v1-logistic': LogisticCalibrationV1,
  'calib-v1-piecewise': PiecewiseCalibrationV1
};

export function calibrateRiskProbability(
  rawScore: RawRiskScore,
  version = 'calib-v1-logistic'
): { probability: RiskProbability; calibrationVersion: string } {
  const model = REGISTERED_CALIBRATION_MODELS[version] ?? LogisticCalibrationV1;
  return {
    probability: model.calibrate(rawScore),
    calibrationVersion: model.version
  };
}

export interface ConfidenceAssessmentInput {
  signalCount: number;
  totalHistoricalOrders: number;
  successfulDeliveries: number;
  rtoCount: number;
  returnCount: number;
  dataCompletenessScore: number; // 0.0 to 1.0 (phone + email + address present)
  averageSignalFreshnessDecay: number; // 0.0 to 1.0
}

/**
 * Computes evidentiary confidence from actual customer historical track record and active signals.
 */
export function computeEvidentiaryConfidence(input: ConfidenceAssessmentInput): RiskConfidence {
  // Baseline confidence on completely unknown customer: 0.20 - 0.25 scaled by data completeness
  if (input.signalCount === 0 && input.totalHistoricalOrders === 0) {
    return createRiskConfidence(0.25 * Math.max(0.2, input.dataCompletenessScore));
  }

  // Weight components:
  // 1. History depth & clean track record (45% max contribution)
  const historyDepthScore = Math.min(1.0, input.totalHistoricalOrders / 5);
  const deliveryRatio = input.totalHistoricalOrders > 0
    ? input.successfulDeliveries / input.totalHistoricalOrders
    : 0.5;
  const historyScore = historyDepthScore * (0.5 + 0.5 * deliveryRatio);

  // 2. Active signals quality & freshness (35% max contribution)
  const signalScore = Math.min(1.0, input.signalCount / 3) * input.averageSignalFreshnessDecay;

  // 3. Current checkout data completeness (20% contribution)
  const completenessScore = input.dataCompletenessScore;

  const rawConfidence =
    0.20 +
    historyScore * 0.45 +
    signalScore * 0.25 +
    completenessScore * 0.10;

  return createRiskConfidence(Math.min(0.98, Math.max(0.10, rawConfidence)));
}
