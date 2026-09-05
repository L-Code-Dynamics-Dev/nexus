import {
  createRawRiskScore,
  FraudSignalRecord,
  NetworkSignalRecord,
  RawRiskScore,
  RiskConfidence,
  SignalType
} from '../core/types.js';
import { computeEvidentiaryConfidence } from '../calibration/calibration-engine.js';

/**
 * Pure Deterministic Risk Engine
 *
 * Computes raw heuristic risk scores by aggregating active fraud signals
 * with exponential time-decay weighting and false-positive compensations.
 */

export interface RiskEvaluationInput {
  privateSignals: FraudSignalRecord[];
  networkSignals?: NetworkSignalRecord[];
  historicalOrders?: number;
  successfulDeliveries?: number;
  rtoCount?: number;
  returnCount?: number;
  now?: number; // timestamp in ms
  decayHalfLifeDays?: number; // defaults to 45 days
  dataCompleteness?: number;
}

export interface RiskEvaluationResult {
  rawScore: RawRiskScore;
  confidence: RiskConfidence;
  reasonCodes: string[];
  activeSignalCount: number;
  averageFreshness: number;
}

const SIGNAL_WEIGHTS: Record<SignalType, number> = {
  UNCOLLECTED_SHIPMENT: 1.5,
  REPEATED_RETURN: 0.8,
  MANUAL_FLAG: 1.2,
  MERCHANT_OVERRIDE: 0.0,
  FALSE_POSITIVE: -2.5 // strong negative compensation for false positives
};

function calculateDecayFactor(createdAtMs: number, nowMs: number, halfLifeDays: number): number {
  const ageDays = Math.max(0, (nowMs - createdAtMs) / (1000 * 60 * 60 * 24));
  const lambda = Math.LN2 / halfLifeDays;
  return Math.exp(-lambda * ageDays);
}

export function evaluateRisk(input: RiskEvaluationInput): RiskEvaluationResult {
  const now = input.now ?? Date.now();
  const halfLife = input.decayHalfLifeDays ?? 45;

  let totalScore = 0;
  let totalDecaySum = 0;
  let validSignalCount = 0;
  const reasonCodes = new Set<string>();

  // 1. Process Private Signals (highest priority and confidence)
  for (const signal of input.privateSignals) {
    if (signal.expires_at < now) continue;

    const baseWeight = SIGNAL_WEIGHTS[signal.signal_type] ?? 0.5;
    const decay = calculateDecayFactor(signal.created_at, now, halfLife);
    const signalConfidence = Math.max(0.1, Math.min(1.0, signal.confidence));

    const effectiveWeight = baseWeight * decay * signalConfidence;
    totalScore += effectiveWeight;
    totalDecaySum += decay;
    validSignalCount++;

    if (signal.signal_type === 'UNCOLLECTED_SHIPMENT') {
      reasonCodes.add('UNCOLLECTED_SHIPMENT_DETECTED');
    } else if (signal.signal_type === 'REPEATED_RETURN') {
      reasonCodes.add('REPEATED_RETURN_HISTORY');
    } else if (signal.signal_type === 'MANUAL_FLAG') {
      reasonCodes.add('MERCHANT_MANUAL_FLAG');
    } else if (signal.signal_type === 'FALSE_POSITIVE') {
      reasonCodes.add('PREVIOUS_FALSE_POSITIVE_ADJUSTMENT');
    }
  }

  // 2. Process Network Signals (if provided and active)
  if (input.networkSignals && input.networkSignals.length > 0) {
    for (const netSignal of input.networkSignals) {
      if (netSignal.expires_at < now) continue;

      const netDecay = calculateDecayFactor(netSignal.created_at, now, halfLife);
      const netWeight = Math.min(0.5, netSignal.weight) * netDecay;
      totalScore += netWeight;
      totalDecaySum += netDecay;
      validSignalCount++;

      reasonCodes.add('NETWORK_REPUTATION_FLAG');
    }
  }

  const rawScore = createRawRiskScore(Math.max(0, totalScore));
  const avgFreshness = validSignalCount > 0 ? totalDecaySum / validSignalCount : 1.0;

  // Evidentiary Confidence: Combines verified historical orders with active signals and completeness
  const confidence = computeEvidentiaryConfidence({
    signalCount: validSignalCount,
    totalHistoricalOrders: input.historicalOrders ?? 0,
    successfulDeliveries: input.successfulDeliveries ?? 0,
    rtoCount: input.rtoCount ?? 0,
    returnCount: input.returnCount ?? 0,
    dataCompletenessScore: input.dataCompleteness ?? 0.8,
    averageSignalFreshnessDecay: avgFreshness
  });

  return {
    rawScore,
    confidence,
    reasonCodes: Array.from(reasonCodes),
    activeSignalCount: validSignalCount,
    averageFreshness: avgFreshness
  };
}
