// ValidationStageRules -- migrace legacy 5-stage validation pipeline
// (connectors/safeorder/legacy/validation/stages/) pod Nexus Rule contract.
// Fáze 2 pokračování (docs/MIGRATION_PLAN.md).
//
// POZOR K NÁZVU/VZTAHU: SafeOrder má VLASTNÍ 5-stage pipeline
// (INPUT/IDENTITY/SIGNAL/RISK_POLICY/DECISION_ACTION), nezávislou na
// Omega 5-stage Validation Framework (connectors/shoptet/legacy/
// validation/, INPUT/PARSER/CORE/OUTPUT/POST_IMPORT) a na Nexus vlastním
// core/validation/ frameworku -- TŘI nezávislé implementace stejného
// vzoru, stejnojmenné shodou okolností. NEDUPLIKOVÁNO, NESJEDNOCENO --
// migrováno jako samostatná doména, stejný princip jako u ostatních
// legacy portů v tomto repu.
//
// Migrovány jen ČISTÉ (synchronní, I/O-free) stage validátory:
//   Stage 1 (INPUT), Stage 3 (SIGNAL), Stage 4 (RISK_POLICY),
//   Stage 5 (DECISION_ACTION)
// Stage 2 (IDENTITY) NENÍ migrována jako Rule<> -- volá async
// generateBlindToken (Web Crypto), stejná výjimka jako BlindToken.ts.
// FiveStagePipeline orchestrátor (pipeline.ts) NENÍ migrován vůbec --
// těžké I/O (DatabaseClient, SignalRepository), zůstává v legacy/ jako
// budoucí konzument těchto Rules, ne něco k migraci.
//
// POZNÁMKA K TESTŮM: `durationMs` pole je `performance.now()`-based,
// nedeterministické -- parity testy ho musí ignorovat (porovnávat
// zbytek StageValidationResult, ne durationMs samo).

import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import { validateInputStage } from '../../connectors/safeorder/legacy/validation/stages/1-input-validator.js';
import { validateSignalsStage } from '../../connectors/safeorder/legacy/validation/stages/3-signal-validator.js';
import { validateRiskPolicyStage } from '../../connectors/safeorder/legacy/validation/stages/4-risk-policy-validator.js';
import { validateDecisionActionStage } from '../../connectors/safeorder/legacy/validation/stages/5-decision-action-validator.js';
import type { StageValidationResult } from '../../connectors/safeorder/legacy/validation/stages/types.js';
import type { CheckoutEvaluationRequest, FraudSignalRecord, NetworkSignalRecord, PaymentMethodType, MerchantEconomicProfile, TenantPolicyRecord, TenantRecord } from '../../connectors/safeorder/legacy/core/types.js';
import type { ValidatedSignalSet } from '../../connectors/safeorder/legacy/validation/stages/3-signal-validator.js';
import type { GraphNode } from '../../connectors/safeorder/legacy/risk-graph/graph.js';
import type { ValidatedRiskPolicyData } from '../../connectors/safeorder/legacy/validation/stages/4-risk-policy-validator.js';

export class InputValidationStageRule implements Rule<unknown, StageValidationResult<CheckoutEvaluationRequest>> {
    constructor(public readonly context: RuleContext) {}

    evaluate(rawPayload: unknown): StageValidationResult<CheckoutEvaluationRequest> {
        return validateInputStage(rawPayload);
    }
}

export interface SignalValidationStageRuleInput {
    readonly tenantId: string;
    readonly rawPrivateSignals: FraudSignalRecord[];
    readonly rawNetworkSignals?: NetworkSignalRecord[];
    readonly now?: number;
}

export class SignalValidationStageRule implements Rule<SignalValidationStageRuleInput, StageValidationResult<ValidatedSignalSet>> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: SignalValidationStageRuleInput): StageValidationResult<ValidatedSignalSet> {
        return validateSignalsStage(input.tenantId, input.rawPrivateSignals, input.rawNetworkSignals, input.now);
    }
}

export interface RiskPolicyStageRuleInput {
    readonly signals: ValidatedSignalSet;
    readonly entityNode: GraphNode | null;
    readonly orderParams: { orderTotal: number; paymentMethod: PaymentMethodType; currency: string; dataCompleteness?: number };
    readonly tenantPolicy?: TenantPolicyRecord | null;
    readonly economicProfile?: MerchantEconomicProfile | null;
}

export class RiskPolicyStageRule implements Rule<RiskPolicyStageRuleInput, StageValidationResult<ValidatedRiskPolicyData>> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: RiskPolicyStageRuleInput): StageValidationResult<ValidatedRiskPolicyData> {
        return validateRiskPolicyStage(input.signals, input.entityNode, input.orderParams, input.tenantPolicy, input.economicProfile);
    }
}

export interface DecisionActionStageRuleInput {
    readonly riskPolicyData: ValidatedRiskPolicyData;
    readonly tenant: TenantRecord;
    readonly tenantPolicy?: TenantPolicyRecord | null;
    readonly activeOverrideDecision?: 'ALLOW' | 'RESTRICT' | 'FALSE_POSITIVE' | null;
}

export class DecisionActionStageRule implements Rule<DecisionActionStageRuleInput, StageValidationResult> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: DecisionActionStageRuleInput): StageValidationResult {
        return validateDecisionActionStage(input.riskPolicyData, input.tenant, input.tenantPolicy, input.activeOverrideDecision);
    }
}
