// RiskEngineRule -- migrace legacy risk-engine/engine.ts (connectors/
// safeorder/legacy/risk-engine/engine.ts) pod Nexus Rule contract.
// Fáze 2 (docs/MIGRATION_PLAN.md), dodatečně objevené jádro -- toto je
// funkce, co spočítá rawScore vstupující do CalibrationRule (evaluateRisk
// -> calibrateRiskProbability -> evaluatePolicy, celý řetězec).
//
// Zachováno 1:1: SIGNAL_WEIGHTS (UNCOLLECTED_SHIPMENT 1.5, REPEATED_RETURN
// 0.8, MANUAL_FLAG 1.2, MERCHANT_OVERRIDE 0.0, FALSE_POSITIVE -2.5 --
// silná negativní kompenzace), exponenciální time-decay s 45denním
// poločasem (výchozí), private signály zpracované první (nejvyšší
// priorita/confidence), network signály capped na max 0.5 váhy před
// decay. Expirované signály (expires_at < now) ignorovány beze zápisu
// do reasonCodes.

import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import { evaluateRisk, type RiskEvaluationInput, type RiskEvaluationResult } from '../../connectors/safeorder/legacy/risk-engine/engine.js';

export class RiskEngineRule implements Rule<RiskEvaluationInput, RiskEvaluationResult> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: RiskEvaluationInput): RiskEvaluationResult {
        return evaluateRisk(input);
    }
}
