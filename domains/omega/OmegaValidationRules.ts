// OmegaValidationRules -- migrace legacy OmegaOutputValidationGate,
// OmegaImportLogParser, OmegaPostImportValidationGate (connectors/omega/
// legacy/{OmegaOutputValidationGate,gate5/*}.ts) pod Nexus Rule contract.
// Fáze 5 (docs/MIGRATION_PLAN.md).
//
// Všechny tři jsou synchronní čisté funkce (žádné I/O -- Gate5 dostává
// AgentEvidence jako už-načtený vstup, nečte fs/proces sám), legitimní
// Rule<> kandidáti.

import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import { OmegaOutputValidationGate, type OmegaOutputGatePayload } from '../../connectors/omega/legacy/OmegaOutputValidationGate.js';
import { OmegaImportLogParser, type ParsedOmegaLog } from '../../connectors/omega/legacy/gate5/OmegaImportLogParser.js';
import { OmegaPostImportValidationGate, type Gate5Payload, type Gate5Result } from '../../connectors/omega/legacy/gate5/OmegaPostImportValidationGate.js';
import type { ValidationResult } from '../../connectors/shoptet/legacy/validation/types.js';

export class OmegaOutputValidationRule implements Rule<OmegaOutputGatePayload, ValidationResult> {
    constructor(public readonly context: RuleContext) {}

    private readonly gate = new OmegaOutputValidationGate();

    evaluate(input: OmegaOutputGatePayload): ValidationResult {
        return this.gate.validate(input);
    }
}

export class OmegaImportLogParserRule implements Rule<string | null, ParsedOmegaLog> {
    constructor(public readonly context: RuleContext) {}

    private readonly parser = new OmegaImportLogParser();

    evaluate(logContent: string | null): ParsedOmegaLog {
        return this.parser.parse(logContent);
    }
}

export class OmegaPostImportValidationRule implements Rule<Gate5Payload, Gate5Result> {
    constructor(public readonly context: RuleContext) {}

    private readonly gate = new OmegaPostImportValidationGate();

    evaluate(input: Gate5Payload): Gate5Result {
        return this.gate.validate(input);
    }
}
