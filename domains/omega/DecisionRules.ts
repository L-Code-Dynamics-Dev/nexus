// DecisionRules -- migrace legacy DecisionEngine/PolicyLayer/rules
// implementations (connectors/omega/legacy/{decisions,policies,rules}/)
// pod Nexus Rule contract. Fáze 5 pokračování (docs/MIGRATION_PLAN.md).
//
// Zachováno 1:1: DecisionEngine.evaluate() iteruje pravidla determinis-
// ticky, chytá výjimku z rule.evaluate() a mapuje ji na status UNKNOWN
// (absolutní failure-safety -- shozené pravidlo nikdy nezhroutí celý
// engine). PolicyLayer.evaluateRuleOutcome() mapuje RuleStatus na
// DecisionStatus: PASS->ACCEPT, WARNING->ACCEPT_WITH_WARNING (non-
// blocking), UNKNOWN->HOLD (blocking, "neznámý stav je kriticky"),
// REJECT->REJECT (blocking), cokoliv jiného->SYSTEM_ERROR (blocking).
// Eskalace finalStatus: SYSTEM_ERROR > REJECT > HOLD > ACCEPT_WITH_WARNING
// > ACCEPT, nikdy se nesnižuje zpět.
//
// IdentityRules (SourceDocumentIdExistsRule, CustomerIdentityValidRule)
// a TaxRules (VatDeterminationRule) jsou konkrétní Rule implementace --
// migrovány jako Nexus Rules obalující stejnou evaluate() logiku.

import type { Rule, RuleContext as NexusRuleContext } from '../../core/canonical/rules/Rule.js';
import { DecisionEngine, type Decision } from '../../connectors/omega/legacy/decisions/DecisionEngine.js';
import { PolicyLayer } from '../../connectors/omega/legacy/policies/PolicyLayer.js';
import type { Rule as OmegaRule, RuleContext as OmegaRuleContext, RuleResult } from '../../connectors/omega/legacy/rules/RuleTypes.js';
import { SourceDocumentIdExistsRule, CustomerIdentityValidRule } from '../../connectors/omega/legacy/rules/implementations/IdentityRules.js';
import { VatDeterminationRule } from '../../connectors/omega/legacy/rules/implementations/TaxRules.js';

export interface DecisionEngineRuleInput {
    readonly rules: OmegaRule[];
    readonly ruleSetVersion: string;
    readonly context: OmegaRuleContext;
}

export class DecisionEngineRule implements Rule<DecisionEngineRuleInput, Decision> {
    constructor(public readonly context: NexusRuleContext) {}

    evaluate(input: DecisionEngineRuleInput): Decision {
        const engine = new DecisionEngine(input.rules, new PolicyLayer(), input.ruleSetVersion);
        return engine.evaluate(input.context);
    }
}

export class SourceDocumentIdExistsRuleAdapter implements Rule<OmegaRuleContext, RuleResult> {
    constructor(public readonly context: NexusRuleContext) {}

    private readonly rule = new SourceDocumentIdExistsRule();

    evaluate(input: OmegaRuleContext): RuleResult {
        return this.rule.evaluate(input);
    }
}

export class CustomerIdentityValidRuleAdapter implements Rule<OmegaRuleContext, RuleResult> {
    constructor(public readonly context: NexusRuleContext) {}

    private readonly rule = new CustomerIdentityValidRule();

    evaluate(input: OmegaRuleContext): RuleResult {
        return this.rule.evaluate(input);
    }
}

export class VatDeterminationRuleAdapter implements Rule<OmegaRuleContext, RuleResult> {
    constructor(public readonly context: NexusRuleContext) {}

    private readonly rule = new VatDeterminationRule();

    evaluate(input: OmegaRuleContext): RuleResult {
        return this.rule.evaluate(input);
    }
}
