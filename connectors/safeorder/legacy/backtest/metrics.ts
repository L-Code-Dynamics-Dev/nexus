// 1:1 port ze ~/safeorder-3.0/src/backtest/point-in-time-backtest.ts
// (calculateMetricSet, calculateRocAuc, calculateBrierScore -- řádky 394-473).
// Zbytek souboru (PointInTimeD1Database mock, PointInTimeBacktestEngine.runBacktest,
// parseOkfishXml, parseGuaranaPlusCsv) NENÍ portován -- viz domains/safeorder/
// NOT_MIGRATED.md pro zdůvodnění.

export interface EvaluationRecord {
  orderId: string;
  date: string;
  timestamp: number;
  customerName: string;
  phone: string;
  email: string;
  paymentMethod: string;
  orderTotal: number;
  currency: string;
  rawScore: number;
  calibratedProbability: number;
  confidence: number;
  decision: string;
  action: string;
  reasons: string[];
  isActualRto: boolean;
  historyOrdersBefore: number;
  historyRtoBefore: number;
  historyDeliveriesBefore: number;
}

export interface MetricSet {
  totalEvaluated: number;
  actualRtoCount: number;
  actualDeliveredCount: number;
  baseRtoRate: number;
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1Score: number;
  accuracy: number;
  falsePositiveRate: number;
  specificity: number;
}

export function calculateMetricSet(evals: EvaluationRecord[], isPositiveFn: (e: EvaluationRecord) => boolean): MetricSet {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  let actualRto = 0;
  let actualDelivered = 0;

  for (const e of evals) {
    if (e.isActualRto) actualRto++;
    else actualDelivered++;

    const predPositive = isPositiveFn(e);
    if (predPositive && e.isActualRto) tp++;
    else if (predPositive && !e.isActualRto) fp++;
    else if (!predPositive && !e.isActualRto) tn++;
    else fn++;
  }

  const total = evals.length;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1Score = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const accuracy = total > 0 ? (tp + tn) / total : 0;
  const fpr = fp + tn > 0 ? fp / (fp + tn) : 0;
  const specificity = fp + tn > 0 ? tn / (fp + tn) : 0;

  return {
    totalEvaluated: total,
    actualRtoCount: actualRto,
    actualDeliveredCount: actualDelivered,
    baseRtoRate: total > 0 ? actualRto / total : 0,
    truePositives: tp,
    falsePositives: fp,
    trueNegatives: tn,
    falseNegatives: fn,
    precision: Math.round(precision * 1000) / 1000,
    recall: Math.round(recall * 1000) / 1000,
    f1Score: Math.round(f1Score * 1000) / 1000,
    accuracy: Math.round(accuracy * 1000) / 1000,
    falsePositiveRate: Math.round(fpr * 1000) / 1000,
    specificity: Math.round(specificity * 1000) / 1000
  };
}

export function calculateRocAuc(evals: EvaluationRecord[]): number {
  const sorted = [...evals].sort((a, b) => b.calibratedProbability - a.calibratedProbability);
  let positives = 0;
  let negatives = 0;

  for (const e of sorted) {
    if (e.isActualRto) positives++;
    else negatives++;
  }

  if (positives === 0 || negatives === 0) return 0.5;

  let auc = 0;
  let cumulativePositives = 0;

  for (const e of sorted) {
    if (e.isActualRto) {
      cumulativePositives++;
    } else {
      auc += cumulativePositives;
    }
  }

  return Math.round((auc / (positives * negatives)) * 1000) / 1000;
}

export function calculateBrierScore(evals: EvaluationRecord[]): number {
  if (evals.length === 0) return 0;
  let sum = 0;
  for (const e of evals) {
    const actual = e.isActualRto ? 1 : 0;
    sum += Math.pow(e.calibratedProbability - actual, 2);
  }
  return Math.round((sum / evals.length) * 10000) / 10000;
}
