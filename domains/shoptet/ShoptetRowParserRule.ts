// ShoptetRowParserRule -- migrace legacy parseRow (connectors/shoptet/
// legacy/csv/ShoptetRowParser.ts) pod Nexus Rule contract. Fáze 4
// (docs/MIGRATION_PLAN.md).
//
// 1:1 s legacy: acceptedSourceNames column matching (první shoda vyhrává),
// parser/normalizationRules/validationRules pipeline v tomto pořadí,
// required-field-empty-after-parse detekce. Čistá funkce, žádné I/O --
// na rozdíl od CsvInputValidationGate (čte fs), parseRow operuje jen
// na už načteném ValidatedCsvRow, takže je legitimní Rule<> kandidát.

import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import { parseRow, type ShoptetParsedRow } from '../../connectors/shoptet/legacy/csv/ShoptetRowParser.js';
import type { ShoptetExportSchema } from '../../connectors/shoptet/legacy/csv/ShoptetExportSchema.js';
import type { ValidatedCsvRow } from '../../connectors/shoptet/legacy/csv/CsvInputValidationGate.js';

export interface ShoptetRowParserRuleInput {
    readonly row: ValidatedCsvRow;
    readonly schema: ShoptetExportSchema;
}

export class ShoptetRowParserRule implements Rule<ShoptetRowParserRuleInput, ShoptetParsedRow> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: ShoptetRowParserRuleInput): ShoptetParsedRow {
        return parseRow(input.row, input.schema);
    }
}
