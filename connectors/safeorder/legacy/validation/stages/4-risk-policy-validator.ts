import {
  createRawRiskScore,
  MerchantEconomicProfile,
  PaymentMethodType,
  RiskConfidence,
  RiskDecision,
  TenantPolicyRecord
} from '../../core/types.js';
import { evaluateRisk } from '../../risk-engine/engine.js';
import { evaluatePolicy } from '../../policy-engine/policies.js';
import { calibrateRiskProbability } from '../../calibration/calibration-engine.js';
import { evaluateContextualRisk, GraphNode } from '../../risk-graph/graph.js';
import { DecisionEconomicsEvaluation, evaluateDecisionEconomics } from '../../economics/decision-economics.js';
import { ValidatedSignalSet } from './3-signal-validator.js';
import { StageValidationResult, ValidationStage } from './types.js';

export interface ValidatedRiskPolicyData {
  riskScore: number;
  confidence: RiskConfidence;
  rawDecision: RiskDecision;
  economics: DecisionEconomicsEvaluation;
  reasonCodes: string[];
}

export function validateRiskPolicyStage(
  signals: ValidatedSignalSet,
  entityNode: GraphNode | null,
  orderParams: { orderTotal: number; paymentMethod: PaymentMethodType; currency: string; dataCompleteness?: number },
  tenantPolicy?: TenantPolicyRecord | null,
  economicProfile?: MerchantEconomicProfile | null
): StageValidationResult<ValidatedRiskPolicyData> {
  const start = performance.now();

  try {
    // 1. Direct Fraud Signals Risk Engine (with full historical track record propagation)
    const directRisk = evaluateRisk({
      privateSignals: signals.validPrivateSignals,
      networkSignals: signals.validNetworkSignals,
      historicalOrders: entityNode?.totalOrders ?? 0,
      successfulDeliveries: entityNode?.successfulDeliveries ?? 0,
      rtoCount: entityNode?.rtoCount ?? 0,
      returnCount: entityNode?.returnCount ?? 0,
      dataCompleteness: orderParams.dataCompleteness ?? 0.8
    });

    // 2. Contextual Risk Graph
    const contextualRisk = evaluateContextualRisk(
      entityNode,
      orderParams,
      economicProfile?.average_order_value ?? 50.0
    );

    // 3. Combined Score & Reason Code Aggregation
    const combinedScore = createRawRiskScore(directRisk.rawScore + contextualRisk.contextualScore);
    const combinedReasons = Array.from(new Set([...directRisk.reasonCodes, ...contextualRisk.contextFactors]));

    // 4. Calibrated Probability & Comparative Decision Economics
    const { probability } = calibrateRiskProbability(combinedScore, 'calib-v1-logistic');

    const effectiveProfile: MerchantEconomicProfile = economicProfile ?? {
      tenant_id: tenantPolicy?.tenant_id || 'default',
      currency: orderParams.currency,
      average_order_value: 50.0,
      product_margin_rate: 0.40,
      shipping_cost_outbound: 4.50,
      shipping_cost_return: 4.50,
      restock_packaging_cost: 2.00,
      payment_processing_rate: 0.015,
      cod_handling_fee: 1.50,
      customer_friction_cost: 6.00,
      updated_at: Date.now()
    };

    const economics = evaluateDecisionEconomics(
      probability,
      orderParams.orderTotal,
      orderParams.currency,
      effectiveProfile
    );

    // 5. Policy Arbitration (Combining Economics, Thresholds, and Confidence Constraints)
    const rawDecision = evaluatePolicy(
      {
        rawScore: combinedScore,
        confidence: directRisk.confidence,
        reasonCodes: combinedReasons,
        activeSignalCount: directRisk.activeSignalCount,
        economicRecommendedAction: economics.recommendedAction
      },
      tenantPolicy ?? undefined
    );

    return {
      stage: ValidationStage.RISK_POLICY,
      passed: true,
      code: 'RISK_POLICY_EVALUATED_VALID',
      data: {
        riskScore: combinedScore,
        confidence: directRisk.confidence,
        rawDecision,
        economics,
        reasonCodes: combinedReasons
      },
      durationMs: Math.round((performance.now() - start) * 100) / 100
    };

  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      stage: ValidationStage.RISK_POLICY,
      passed: false,
      code: 'RISK_POLICY_EVALUATION_FAILED',
      error: errorMsg,
      durationMs: Math.round((performance.now() - start) * 100) / 100
    };
  }
}
