// PolicyRule -- migrace legacy policies.ts (connectors/safeorder/legacy/
// policy-engine/policies.ts) pod Nexus Rule contract. Fáze 2
// (docs/MIGRATION_PLAN.md).
//
// Zachováno 1:1: confidence gating (trusted repeat buyer bypass prahů,
// unknown/first-time customer není penalizován za typické chování jen
// kvůli nízké confidence), economics-driven arbitrace, tenant-specific
// review/restrict thresholdy s hardcoded fallbackem (0.8/1.8) když
// tenantPolicy chybí. Invariant z hlavičky legacy souboru: RISK ESTIMATION
// != ECONOMIC DECISION != POLICY ARBITRATION != PLATFORM EXECUTION --
// PolicyRule je jen arbitrace vrstva, nepočítá kalibraci ani economics
// sama (ty přichází jako hotový vstup, viz CalibrationRule/EconomicsRule).

import { evaluatePolicy, type PolicyEvaluationInput } from '../../connectors/safeorder/legacy/policy-engine/policies.js';
import { optimizePolicyThresholds, type PolicyOptimizationInput, type PolicyRecommendation } from '../../connectors/safeorder/legacy/policy-engine/adaptive-optimizer.js';
import type { RiskDecision, TenantPolicyRecord } from '../../connectors/safeorder/legacy/core/types.js';
import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';

export interface PolicyRuleInput {
    readonly evaluation: PolicyEvaluationInput;
    readonly tenantPolicy?: TenantPolicyRecord;
}

export class PolicyRule implements Rule<PolicyRuleInput, RiskDecision> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: PolicyRuleInput): RiskDecision {
        return evaluatePolicy(input.evaluation, input.tenantPolicy);
    }
}

export class PolicyOptimizationRule implements Rule<PolicyOptimizationInput, PolicyRecommendation> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: PolicyOptimizationInput): PolicyRecommendation {
        return optimizePolicyThresholds(input);
    }
}
