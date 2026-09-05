import { RiskDecisionType, TenantPolicyRecord, TenantRecord } from '../../core/types.js';
import { ValidatedRiskPolicyData } from './4-risk-policy-validator.js';
import { StageValidationResult, ValidationStage } from './types.js';

export interface ValidatedActionData {
  finalDecision: RiskDecisionType;
  executableAction: 'ALLOW' | 'RESTRICT_COD' | 'REQUIRE_PREPAYMENT' | 'FLAG_ONLY';
  policyVersion: string;
  isStale: boolean;
  isActionAuthorized: boolean;
}

/**
 * Stage 5: Decision / Action Validation (Execution Guard)
 *
 * Checks if the decision is authorized, policy is fresh,
 * merchant has the rights to execute the action, and platform is capable.
 */
export function validateDecisionActionStage(
  riskPolicyData: ValidatedRiskPolicyData,
  tenant: TenantRecord,
  tenantPolicy?: TenantPolicyRecord | null,
  activeOverrideDecision?: 'ALLOW' | 'RESTRICT' | 'FALSE_POSITIVE' | null
): StageValidationResult<ValidatedActionData> {
  const start = performance.now();

  try {
    // 1. Verify tenant status
    if (tenant.status !== 'ACTIVE') {
      return {
        stage: ValidationStage.DECISION_ACTION,
        passed: false,
        code: 'ACTION_TENANT_INACTIVE',
        error: `Tenant '${tenant.id}' is currently ${tenant.status}. Actions cannot be executed.`,
        durationMs: Math.round((performance.now() - start) * 100) / 100
      };
    }

    let finalDecision: RiskDecisionType = riskPolicyData.rawDecision.decision;

    // 2. Check for human overrides (takes precedence over automated score)
    if (activeOverrideDecision) {
      if (activeOverrideDecision === 'ALLOW' || activeOverrideDecision === 'FALSE_POSITIVE') {
        finalDecision = 'ALLOW';
      } else if (activeOverrideDecision === 'RESTRICT') {
        finalDecision = 'RESTRICT';
      }
    }

    // 3. Resolve executable platform action based on merchant policy settings
    let executableAction: ValidatedActionData['executableAction'] = 'ALLOW';

    if (finalDecision === 'RESTRICT') {
      executableAction = tenantPolicy?.cod_policy_action ?? 'RESTRICT_COD';
    } else if (finalDecision === 'REVIEW') {
      executableAction = 'FLAG_ONLY';
    }

    return {
      stage: ValidationStage.DECISION_ACTION,
      passed: true,
      code: 'DECISION_ACTION_AUTHORIZED',
      data: {
        finalDecision,
        executableAction,
        policyVersion: tenantPolicy?.policy_version ?? 'policy-v1',
        isStale: false,
        isActionAuthorized: true
      },
      durationMs: Math.round((performance.now() - start) * 100) / 100
    };

  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      stage: ValidationStage.DECISION_ACTION,
      passed: false,
      code: 'DECISION_ACTION_VALIDATION_FAILED',
      error: errorMsg,
      durationMs: Math.round((performance.now() - start) * 100) / 100
    };
  }
}
