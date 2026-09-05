// RiskGraphRule -- migrace legacy graph.ts (connectors/safeorder/legacy/
// risk-graph/graph.ts) pod Nexus Rule contract. Fáze 2 (docs/MIGRATION_PLAN.md).
//
// Zachováno 1:1: historická RTO/delivery ratio analýza z GraphNode
// (>=2 RTO a ratio > 40% -> +1.8, přesně 1 RTO -> +0.6, >=3 úspěšné
// doručení a ratio > 85% -> -1.0 "TRUSTED_REPEAT_BUYER"), explicitní
// payment-method vyhodnocení (COD s prahy 2.5x/1.5x průměrné hodnoty
// objednávky, PREPAID/CARD/BANK_TRANSFER škáluje skóre na 20%),
// confidence odvozená z počtu pozorovaných objednávek (>=5 -> 0.90,
// >=1 -> 0.65, jinak 0.30). Žádná re-implementace, jen 1:1 delegace.

import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import { evaluateContextualRisk, type GraphNode, type ContextualOrderParams, type ContextualRiskResult } from '../../connectors/safeorder/legacy/risk-graph/graph.js';

export interface RiskGraphRuleInput {
    readonly entityNode: GraphNode | null;
    readonly order: ContextualOrderParams;
    readonly averageOrderValue?: number;
}

export class RiskGraphRule implements Rule<RiskGraphRuleInput, ContextualRiskResult> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: RiskGraphRuleInput): ContextualRiskResult {
        return evaluateContextualRisk(input.entityNode, input.order, input.averageOrderValue);
    }
}
