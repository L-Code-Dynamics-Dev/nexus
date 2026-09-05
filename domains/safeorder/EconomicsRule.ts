// EconomicsRule -- migrace legacy decision-economics.ts (connectors/
// safeorder/legacy/economics/decision-economics.ts) pod Nexus Rule
// contract. Fáze 2 (docs/MIGRATION_PLAN.md).
//
// Zachováno 1:1: striktní currency safety check (nikdy neporovnává
// mismatched měny -- vrací UNCERTAIN_CURRENCY_MISMATCH), expected-value
// model pro všechny 4 akce (ALLOW/REVIEW/RESTRICT_COD/REQUIRE_PREPAYMENT),
// comparative cost minimization se safety bufferem (min. 1.0 jednotka
// úspory, jinak zůstává ALLOW i kdyby jiná akce byla nominálně levnější).

import { evaluateDecisionEconomics, computeMerchantRoi, type DecisionEconomicsEvaluation } from '../../connectors/safeorder/legacy/economics/decision-economics.js';
import type { RiskProbability, MerchantEconomicProfile } from '../../connectors/safeorder/legacy/core/types.js';
import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';

export interface EconomicsRuleInput {
    readonly calibratedRtoProbability: RiskProbability;
    readonly orderTotal: number;
    readonly orderCurrency: string;
    readonly profile: MerchantEconomicProfile;
}

export class EconomicsRule implements Rule<EconomicsRuleInput, DecisionEconomicsEvaluation> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: EconomicsRuleInput): DecisionEconomicsEvaluation {
        return evaluateDecisionEconomics(input.calibratedRtoProbability, input.orderTotal, input.orderCurrency, input.profile);
    }
}

export { computeMerchantRoi };
