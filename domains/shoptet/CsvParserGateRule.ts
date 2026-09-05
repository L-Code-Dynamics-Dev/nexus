// CsvParserGateRule -- migrace legacy CsvParserGate2 (connectors/shoptet/
// legacy/csv/CsvParserGate2.ts) pod Nexus Rule contract. Fáze 4
// (docs/MIGRATION_PLAN.md).
//
// 1:1 s legacy: ROW_LOSS_DETECTED check (input vs parsed count mismatch),
// per-row error agregace, ROW_MISSING_IDENTITY (chybějící orderNumber ->
// nelze clusterovat do objednávky), "any rejected row invalidates whole
// batch" pravidlo (viz legacy komentář o "blocking validation failure").
// CsvParserGate2 je čistá třída (žádné I/O), legitimní Rule<> kandidát --
// na rozdíl od CsvInputValidationGate, co čte fs.

import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import { CsvParserGate2, type ParserGate2Payload, type ParserValidationResult } from '../../connectors/shoptet/legacy/csv/CsvParserGate2.js';

export class CsvParserGateRule implements Rule<ParserGate2Payload, ParserValidationResult> {
    constructor(public readonly context: RuleContext) {}

    private readonly gate = new CsvParserGate2();

    evaluate(input: ParserGate2Payload): ParserValidationResult {
        return this.gate.validate(input);
    }
}
