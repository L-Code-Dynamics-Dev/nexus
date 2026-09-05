import { Rule, RuleContext, RuleResult, DecisionStatus } from '../rules/RuleTypes.js';
import { PolicyLayer } from '../policies/PolicyLayer.js';

export interface Decision {
  status: DecisionStatus;
  documentId: string;
  evaluatedRules: RuleResult[];
  blockingIssues: RuleResult[];
  warnings: RuleResult[];
  ruleSetVersion: string;
}

export class DecisionEngine {
  constructor(
    private rules: Rule[],
    private policyLayer: PolicyLayer,
    private ruleSetVersion: string
  ) {}

  evaluate(context: RuleContext): Decision {
    const evaluatedRules: RuleResult[] = [];
    const blockingIssues: RuleResult[] = [];
    const warnings: RuleResult[] = [];

    let finalStatus: DecisionStatus = 'ACCEPT';

    for (const rule of this.rules) {
      let result: RuleResult;
      
      try {
        // Execute rule deterministically
        result = rule.evaluate(context);
      } catch (e: any) {
        // Rule threw exception - absolute failure safety
        result = {
          ruleId: rule.id,
          ruleVersion: rule.version,
          status: 'UNKNOWN',
          reason: `Rule execution crashed: ${e.message}`
        };
      }

      evaluatedRules.push(result);

      const policyAction = this.policyLayer.evaluateRuleOutcome(result);

      if (policyAction.blocking) {
        blockingIssues.push(result);
        // Elevate severity if needed (e.g. HOLD -> REJECT -> SYSTEM_ERROR)
        if (finalStatus !== 'SYSTEM_ERROR') {
          if (policyAction.decision === 'SYSTEM_ERROR') finalStatus = 'SYSTEM_ERROR';
          else if (policyAction.decision === 'REJECT' && finalStatus !== 'REJECT') finalStatus = 'REJECT';
          else if (policyAction.decision === 'HOLD' && finalStatus !== 'REJECT') finalStatus = 'HOLD';
        }
      } else if (policyAction.decision === 'ACCEPT_WITH_WARNING') {
        warnings.push(result);
        if (finalStatus === 'ACCEPT') {
          finalStatus = 'ACCEPT_WITH_WARNING';
        }
      }
    }

    return {
      status: finalStatus,
      documentId: context.order.orderNumber,
      evaluatedRules,
      blockingIssues,
      warnings,
      ruleSetVersion: this.ruleSetVersion
    };
  }
}
