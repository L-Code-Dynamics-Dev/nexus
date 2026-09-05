// BacktestRule -- migrace čistých metrik z legacy backtest/point-in-time-backtest.ts
// (connectors/safeorder/legacy/backtest/metrics.ts) pod Nexus Rule contract.
// Fáze 2 (docs/MIGRATION_PLAN.md), dodatečně objevené jádro.
//
// Migrovány jen ČISTÉ (synchronní, I/O-free) klasifikační metriky:
// calculateMetricSet (precision/recall/F1/accuracy/FPR/specificity),
// calculateRocAuc (Mann-Whitney U formulace ROC-AUC), calculateBrierScore
// (kalibrační přesnost). PointInTimeBacktestEngine.runBacktest samotný
// NENÍ migrován -- async orchestrace s mock D1 databází, FiveStagePipeline,
// generateBlindToken; parseOkfishXml/parseGuaranaPlusCsv jsou vázané na
// konkrétní legacy export formáty (OKfish/GuaranaPlus), ne SafeOrder
// doménová logika -- viz domains/safeorder/NOT_MIGRATED.md.

import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import { calculateMetricSet, calculateRocAuc, calculateBrierScore, type EvaluationRecord, type MetricSet } from '../../connectors/safeorder/legacy/backtest/metrics.js';

export interface MetricSetRuleInput {
    readonly evals: EvaluationRecord[];
    readonly isPositiveFn: (e: EvaluationRecord) => boolean;
}

export class MetricSetRule implements Rule<MetricSetRuleInput, MetricSet> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: MetricSetRuleInput): MetricSet {
        return calculateMetricSet(input.evals, input.isPositiveFn);
    }
}

export class RocAucRule implements Rule<EvaluationRecord[], number> {
    constructor(public readonly context: RuleContext) {}

    evaluate(evals: EvaluationRecord[]): number {
        return calculateRocAuc(evals);
    }
}

export class BrierScoreRule implements Rule<EvaluationRecord[], number> {
    constructor(public readonly context: RuleContext) {}

    evaluate(evals: EvaluationRecord[]): number {
        return calculateBrierScore(evals);
    }
}
