// RetentionRule -- migrace legacy privacy/retention.ts (connectors/
// safeorder/legacy/privacy/retention.ts) pod Nexus Rule contract.
// Fáze 2 pokračování (docs/MIGRATION_PLAN.md).
//
// Zachováno 1:1: computeExpiryTimestamp (createdAtMs + retentionDays)
// a RETENTION_POLICIES mapa (fraud_signals 90d, webhook_events 30d,
// decision_audit 365d, auth_sessions 1d, všechny HARD_DELETE strategie).
// Čistá funkce, createdAtMs je vstupní parametr -- žádné Date.now() uvnitř.

import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import { computeExpiryTimestamp, RETENTION_POLICIES, type RetentionPolicy } from '../../connectors/safeorder/legacy/privacy/retention.js';

export interface ComputeExpiryTimestampInput {
    readonly createdAtMs: number;
    readonly retentionDays: number;
}

export class ComputeExpiryTimestampRule implements Rule<ComputeExpiryTimestampInput, number> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: ComputeExpiryTimestampInput): number {
        return computeExpiryTimestamp(input.createdAtMs, input.retentionDays);
    }
}

export { RETENTION_POLICIES, type RetentionPolicy };
