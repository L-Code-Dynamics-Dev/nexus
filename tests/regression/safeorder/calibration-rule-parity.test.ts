import { describe, it, expect } from 'vitest';
import { CalibrationRule, EvidentiaryConfidenceRule } from '../../../domains/safeorder/CalibrationRule.js';
import { calibrateRiskProbability, computeEvidentiaryConfidence } from '../../../connectors/safeorder/legacy/calibration/calibration-engine.js';
import { createRawRiskScore } from '../../../connectors/safeorder/legacy/core/types.js';

describe('CalibrationRule parity vs legacy calibrateRiskProbability', () => {
    const rule = new CalibrationRule({ tenantId: 'ten_1', ruleId: 'calibration-v1', ruleVersion: '1' });

    const scores = [0, 0.3, 0.8, 1.5, 2.5, 4.0];
    const versions = ['calib-v1-logistic', 'calib-v1-piecewise'];

    for (const version of versions) {
        for (const rawScoreValue of scores) {
            it(`matches legacy for rawScore=${rawScoreValue}, version=${version}`, () => {
                const rawScore = createRawRiskScore(rawScoreValue);
                const legacy = calibrateRiskProbability(rawScore, version);
                const nexus = rule.evaluate({ rawScore, calibrationVersion: version });

                expect(nexus.probability).toBe(legacy.probability);
                expect(nexus.calibrationVersion).toBe(legacy.calibrationVersion);
            });
        }
    }

    it('unknown version falls back to logistic, same as legacy', () => {
        const rawScore = createRawRiskScore(2.0);
        const legacy = calibrateRiskProbability(rawScore, 'not-a-real-version');
        const nexus = rule.evaluate({ rawScore, calibrationVersion: 'not-a-real-version' });
        expect(nexus.calibrationVersion).toBe(legacy.calibrationVersion);
        expect(nexus.calibrationVersion).toBe('calib-v1-logistic');
    });
});

describe('EvidentiaryConfidenceRule parity vs legacy computeEvidentiaryConfidence', () => {
    const rule = new EvidentiaryConfidenceRule({ tenantId: 'ten_1', ruleId: 'confidence-v1', ruleVersion: '1' });

    it('zero signals + zero history -> matches legacy low-confidence baseline', () => {
        const input = {
            signalCount: 0,
            totalHistoricalOrders: 0,
            successfulDeliveries: 0,
            rtoCount: 0,
            returnCount: 0,
            dataCompletenessScore: 0.8,
            averageSignalFreshnessDecay: 0,
        };
        expect(rule.evaluate(input)).toBe(computeEvidentiaryConfidence(input));
    });

    it('established customer with strong track record -> matches legacy', () => {
        const input = {
            signalCount: 2,
            totalHistoricalOrders: 10,
            successfulDeliveries: 9,
            rtoCount: 1,
            returnCount: 0,
            dataCompletenessScore: 1.0,
            averageSignalFreshnessDecay: 0.9,
        };
        expect(rule.evaluate(input)).toBe(computeEvidentiaryConfidence(input));
    });
});
