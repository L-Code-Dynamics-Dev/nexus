// OmegaMapperRule -- migrace legacy OmegaMapper (connectors/omega/legacy/
// OmegaMapper.ts) pod Nexus Rule contract. Fáze 5 (docs/MIGRATION_PLAN.md).
//
// 1:1 s legacy: R01/R02 tab-delimited generátor, formatDecimal (čárka),
// sanitizeString (tab/newline strip), SHA-256 hash na celý payload.
// OmegaMapper.map() je synchronní čistá funkce (crypto.createHash je
// synchronní Node API, ne I/O) -- legitimní Rule<> kandidát.

import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import { OmegaMapper } from '../../connectors/omega/legacy/OmegaMapper.js';
import type { CanonicalAccountingDocument } from '../../connectors/omega/legacy/core/CanonicalAccountingDocument.js';
import type { OmegaImportPayload } from '../../connectors/omega/legacy/OmegaPayload.js';

export interface OmegaMapperRuleInput {
    readonly documents: CanonicalAccountingDocument[];
    readonly correlationId: string;
}

export class OmegaMapperRule implements Rule<OmegaMapperRuleInput, OmegaImportPayload> {
    constructor(public readonly context: RuleContext) {}

    private readonly mapper = new OmegaMapper();

    evaluate(input: OmegaMapperRuleInput): OmegaImportPayload {
        return this.mapper.map(input.documents, input.correlationId);
    }
}
