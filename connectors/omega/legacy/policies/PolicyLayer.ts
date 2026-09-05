import { RuleResult, DecisionStatus, RuleStatus } from '../rules/RuleTypes.js';

export interface PolicyAction {
  decision: DecisionStatus;
  blocking: boolean;
}

export class PolicyLayer {
  evaluateRuleOutcome(result: RuleResult): PolicyAction {
    switch (result.status) {
      case 'PASS':
        return { decision: 'ACCEPT', blocking: false };
      case 'WARNING':
        // Policy: warnings are non-blocking, we accept with warning
        return { decision: 'ACCEPT_WITH_WARNING', blocking: false };
      case 'UNKNOWN':
        // CRITICAL: UNKNOWN -> HOLD
        return { decision: 'HOLD', blocking: true };
      case 'REJECT':
        return { decision: 'REJECT', blocking: true };
      default:
        // Any unhandled state is an error
        return { decision: 'SYSTEM_ERROR', blocking: true };
    }
  }
}
