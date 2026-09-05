// AuditLedgerRule -- migrace legacy audit/ledger.ts (connectors/safeorder/
// legacy/audit/ledger.ts) pod Nexus Rule contract. Fáze 2 pokračování
// (docs/MIGRATION_PLAN.md).
//
// Zachováno 1:1: buildAuditRecord sestaví DecisionAuditRecord z RiskDecision
// + kontextu (tenant/platform/checkout session). POZOR: `created_at:
// Date.now()` je nedeterministické -- parity test musí ignorovat toto
// pole (porovnávat zbytek záznamu, ne created_at samo).

import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import { buildAuditRecord, type CreateAuditInput } from '../../connectors/safeorder/legacy/audit/ledger.js';
import type { DecisionAuditRecord } from '../../connectors/safeorder/legacy/core/types.js';

export class AuditLedgerRule implements Rule<CreateAuditInput, DecisionAuditRecord> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: CreateAuditInput): DecisionAuditRecord {
        return buildAuditRecord(input);
    }
}
