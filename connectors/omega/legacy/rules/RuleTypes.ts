import { CanonicalOrder } from '../domain/CanonicalModel.js';

export type RuleStatus = 'PASS' | 'WARNING' | 'REJECT' | 'UNKNOWN';
export type DecisionStatus = 'ACCEPT' | 'ACCEPT_WITH_WARNING' | 'HOLD' | 'REJECT' | 'SYSTEM_ERROR';

export interface RuleResult {
  ruleId: string;
  ruleVersion: string;
  status: RuleStatus;
  reason?: string;
  field?: string;
  metadata?: Record<string, any>;
}

export interface RuleContext {
  order: CanonicalOrder;
  tenantConfig: Record<string, any>;
}

export interface Rule {
  id: string;
  version: string;
  description: string;
  evaluate(context: RuleContext): RuleResult;
}
