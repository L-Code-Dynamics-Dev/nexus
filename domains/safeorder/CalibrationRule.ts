// CalibrationRule -- migrace legacy calibration-engine.ts (connectors/
// safeorder/legacy/calibration/calibration-engine.ts) pod Nexus Rule
// contract. Fáze 2 (docs/MIGRATION_PLAN.md).
//
// Zachováno 1:1: logistic sigmoid (P(RTO) = 1/(1+e^(-k*(rawScore-x0))),
// k=1.6, x0=1.5) i piecewise conservative transfer funkce, oba
// registrované modely, evidentiary confidence scoring vč. tvrdého
// invariantu "absence of evidence != evidence of absence" (nula signálů
// + nula historie -> confidence 0.20-0.30, NIKDY 1.0).
//
// Legacy branded types (RawRiskScore/RiskProbability/RiskConfidence)
// zůstávají -- adaptér je nekonvertuje na obecné number, protože
// runtime-clamping v create*() funkcích (Math.max/min) je součástí
// byznys invariantu (probability/confidence jsou VŽDY v [0,1]).

import {
    calibrateRiskProbability,
    computeEvidentiaryConfidence,
    type ConfidenceAssessmentInput,
} from '../../connectors/safeorder/legacy/calibration/calibration-engine.js';
import type { RawRiskScore, RiskProbability, RiskConfidence } from '../../connectors/safeorder/legacy/core/types.js';
import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';

export interface CalibrationRuleInput {
    readonly rawScore: RawRiskScore;
    readonly calibrationVersion?: string;
}

export interface CalibrationRuleResult {
    readonly probability: RiskProbability;
    readonly calibrationVersion: string;
}

export class CalibrationRule implements Rule<CalibrationRuleInput, CalibrationRuleResult> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: CalibrationRuleInput): CalibrationRuleResult {
        return calibrateRiskProbability(input.rawScore, input.calibrationVersion);
    }
}

export class EvidentiaryConfidenceRule implements Rule<ConfidenceAssessmentInput, RiskConfidence> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: ConfidenceAssessmentInput): RiskConfidence {
        return computeEvidentiaryConfidence(input);
    }
}
