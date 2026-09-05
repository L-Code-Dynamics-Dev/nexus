import { describe, it, expect } from 'vitest';
import { MetricSetRule, RocAucRule, BrierScoreRule } from '../../../domains/safeorder/BacktestRule.js';
import { calculateMetricSet, calculateRocAuc, calculateBrierScore, type EvaluationRecord } from '../../../connectors/safeorder/legacy/backtest/metrics.js';

const ctx = { tenantId: 'ten_1', ruleVersion: '1' };

function makeEval(overrides?: Partial<EvaluationRecord>): EvaluationRecord {
    return {
        orderId: 'o1', date: '2026-09-01', timestamp: 0, customerName: 'x', phone: '', email: '',
        paymentMethod: 'COD', orderTotal: 100, currency: 'CZK', rawScore: 1, calibratedProbability: 0.5,
        confidence: 0.7, decision: 'ALLOW', action: 'ALLOW', reasons: [], isActualRto: false,
        historyOrdersBefore: 0, historyRtoBefore: 0, historyDeliveriesBefore: 0,
        ...overrides,
    };
}

describe('MetricSetRule parity vs legacy calculateMetricSet', () => {
    const rule = new MetricSetRule({ ...ctx, ruleId: 'metric-set-v1' });

    const scenarios: { name: string; evals: EvaluationRecord[]; isPositiveFn: (e: EvaluationRecord) => boolean }[] = [
        { name: 'empty evaluations', evals: [], isPositiveFn: (e) => e.decision === 'RESTRICT' },
        {
            name: 'mixed TP/FP/TN/FN',
            evals: [
                makeEval({ decision: 'RESTRICT', isActualRto: true }), // TP
                makeEval({ decision: 'RESTRICT', isActualRto: false }), // FP
                makeEval({ decision: 'ALLOW', isActualRto: false }), // TN
                makeEval({ decision: 'ALLOW', isActualRto: true }), // FN
            ],
            isPositiveFn: (e) => e.decision === 'RESTRICT',
        },
        {
            name: 'all true positives',
            evals: [makeEval({ decision: 'RESTRICT', isActualRto: true }), makeEval({ decision: 'RESTRICT', isActualRto: true })],
            isPositiveFn: (e) => e.decision === 'RESTRICT',
        },
        {
            name: 'threshold-based positive fn',
            evals: [makeEval({ calibratedProbability: 0.9, isActualRto: true }), makeEval({ calibratedProbability: 0.1, isActualRto: false })],
            isPositiveFn: (e) => e.calibratedProbability >= 0.5,
        },
    ];

    for (const s of scenarios) {
        it(`matches legacy for scenario: ${s.name}`, () => {
            const legacy = calculateMetricSet(s.evals, s.isPositiveFn);
            const nexus = rule.evaluate({ evals: s.evals, isPositiveFn: s.isPositiveFn });
            expect(nexus).toEqual(legacy);
        });
    }
});

describe('RocAucRule parity vs legacy calculateRocAuc', () => {
    const rule = new RocAucRule({ ...ctx, ruleId: 'roc-auc-v1' });

    it('matches legacy for empty evaluations (returns 0.5)', () => {
        expect(rule.evaluate([])).toBe(calculateRocAuc([]));
    });

    it('matches legacy for all-positive evaluations (no negatives -> 0.5)', () => {
        const evals = [makeEval({ isActualRto: true }), makeEval({ isActualRto: true })];
        expect(rule.evaluate(evals)).toBe(calculateRocAuc(evals));
    });

    it('matches legacy for perfect separation', () => {
        const evals = [
            makeEval({ calibratedProbability: 0.9, isActualRto: true }),
            makeEval({ calibratedProbability: 0.1, isActualRto: false }),
        ];
        expect(rule.evaluate(evals)).toBe(calculateRocAuc(evals));
    });
});

describe('BrierScoreRule parity vs legacy calculateBrierScore', () => {
    const rule = new BrierScoreRule({ ...ctx, ruleId: 'brier-score-v1' });

    it('matches legacy for empty evaluations (returns 0)', () => {
        expect(rule.evaluate([])).toBe(calculateBrierScore([]));
    });

    it('matches legacy for perfect calibration', () => {
        const evals = [makeEval({ calibratedProbability: 1.0, isActualRto: true }), makeEval({ calibratedProbability: 0.0, isActualRto: false })];
        expect(rule.evaluate(evals)).toBe(calculateBrierScore(evals));
    });

    it('matches legacy for imperfect calibration', () => {
        const evals = [makeEval({ calibratedProbability: 0.3, isActualRto: true }), makeEval({ calibratedProbability: 0.7, isActualRto: false })];
        expect(rule.evaluate(evals)).toBe(calculateBrierScore(evals));
    });
});
