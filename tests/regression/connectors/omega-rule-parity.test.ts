import { describe, it, expect } from 'vitest';
import { Decimal } from 'decimal.js';
import { OmegaMapperRule } from '../../../domains/omega/OmegaMapperRule.js';
import { OmegaOutputValidationRule, OmegaImportLogParserRule, OmegaPostImportValidationRule } from '../../../domains/omega/OmegaValidationRules.js';
import { OmegaMapper } from '../../../connectors/omega/legacy/OmegaMapper.js';
import { OmegaOutputValidationGate } from '../../../connectors/omega/legacy/OmegaOutputValidationGate.js';
import { OmegaImportLogParser } from '../../../connectors/omega/legacy/gate5/OmegaImportLogParser.js';
import { OmegaPostImportValidationGate } from '../../../connectors/omega/legacy/gate5/OmegaPostImportValidationGate.js';
import type { CanonicalAccountingDocument } from '../../../connectors/omega/legacy/core/CanonicalAccountingDocument.js';
import type { AgentEvidence } from '../../../connectors/omega/legacy/agent/AgentEvidence.js';

const ctx = { tenantId: 'ten_1', ruleVersion: '1' };
const legacyMapper = new OmegaMapper();
const legacyGate = new OmegaOutputValidationGate();
const legacyParser = new OmegaImportLogParser();
const legacyGate5 = new OmegaPostImportValidationGate();

function makeDocument(overrides?: Partial<CanonicalAccountingDocument>): CanonicalAccountingDocument {
    return {
        sourceDocumentId: 'DOC-1', documentType: 'INVOICE', issueDate: new Date('2026-09-05'), currency: 'CZK',
        supplier: { id: 's1', name: 'Supplier', street: 'St 1', city: 'Praha', zipCode: '10000', country: 'CZ' },
        customer: { id: 'c1', name: 'Customer', ico: '12345678', dic: 'CZ12345678', street: 'St 2', city: 'Brno', zipCode: '60200', country: 'CZ' },
        lines: [{ text: 'Widget', quantity: new Decimal(2), unitPriceWithoutTax: new Decimal(100), taxRate: 21, taxAmount: new Decimal(42), totalWithTax: new Decimal(242) }],
        summary: { totalWithoutTax: new Decimal(200), totalTax: new Decimal(42), totalWithTax: new Decimal(242) },
        ...overrides,
    };
}

describe('OmegaMapperRule parity vs legacy OmegaMapper', () => {
    const rule = new OmegaMapperRule({ ...ctx, ruleId: 'omega-mapper-v1' });

    it('matches legacy output including hash', () => {
        const documents = [makeDocument()];
        const legacy = legacyMapper.map(documents, 'corr-1');
        const nexus = rule.evaluate({ documents, correlationId: 'corr-1' });
        expect(nexus).toEqual(legacy);
    });
});

describe('OmegaOutputValidationRule parity vs legacy OmegaOutputValidationGate', () => {
    const rule = new OmegaOutputValidationRule({ ...ctx, ruleId: 'omega-output-validation-v1' });

    it('matches legacy for valid payload', () => {
        const documents = [makeDocument()];
        const payload = legacyMapper.map(documents, 'corr-1');
        const legacy = legacyGate.validate({ sourceDocuments: documents, generatedPayload: payload });
        const nexus = rule.evaluate({ sourceDocuments: documents, generatedPayload: payload });
        expect(nexus).toEqual(legacy);
    });

    it('matches legacy for total mismatch', () => {
        const documents = [makeDocument({ summary: { totalWithoutTax: new Decimal(1), totalTax: new Decimal(0), totalWithTax: new Decimal(1) } })];
        const payload = legacyMapper.map(documents, 'corr-1');
        const legacy = legacyGate.validate({ sourceDocuments: documents, generatedPayload: payload });
        const nexus = rule.evaluate({ sourceDocuments: documents, generatedPayload: payload });
        expect(nexus).toEqual(legacy);
    });
});

describe('OmegaImportLogParserRule parity vs legacy OmegaImportLogParser', () => {
    const rule = new OmegaImportLogParserRule({ ...ctx, ruleId: 'omega-log-parser-v1' });

    it('matches legacy for valid log', () => {
        const log = 'Document: DOC-1 SUCCESS\nDocument: DOC-2 SUCCESS\n';
        expect(rule.evaluate(log)).toEqual(legacyParser.parse(log));
    });

    it('matches legacy for null log', () => {
        expect(rule.evaluate(null)).toEqual(legacyParser.parse(null));
    });

    it('matches legacy for log with errors', () => {
        const log = 'Document: DOC-1 SUCCESS\nChyba: neplatny format\n';
        expect(rule.evaluate(log)).toEqual(legacyParser.parse(log));
    });
});

describe('OmegaPostImportValidationRule parity vs legacy OmegaPostImportValidationGate', () => {
    const rule = new OmegaPostImportValidationRule({ ...ctx, ruleId: 'omega-post-import-v1' });

    const scenarios: { name: string; evidence: AgentEvidence; expectedIds: string[] }[] = [
        {
            name: 'completed success',
            evidence: { jobId: 'j1', correlationId: 'c1', agentId: 'a1', payloadHashVerified: true, executorResult: { pid: 1, exitCode: 0, stdout: '', stderr: '', startTime: new Date(), endTime: new Date(), durationMs: 1, logContent: 'Document: DOC-1 SUCCESS\n' }, status: 'done', timestamp: new Date() },
            expectedIds: ['DOC-1'],
        },
        {
            name: 'hash not verified',
            evidence: { jobId: 'j1', correlationId: 'c1', agentId: 'a1', payloadHashVerified: false, status: 'done', timestamp: new Date() },
            expectedIds: ['DOC-1'],
        },
        {
            name: 'non-zero exit code',
            evidence: { jobId: 'j1', correlationId: 'c1', agentId: 'a1', payloadHashVerified: true, executorResult: { pid: 1, exitCode: 1, stdout: '', stderr: '', startTime: new Date(), endTime: new Date(), durationMs: 1, logContent: null }, status: 'done', timestamp: new Date() },
            expectedIds: ['DOC-1'],
        },
        {
            name: 'document count mismatch',
            evidence: { jobId: 'j1', correlationId: 'c1', agentId: 'a1', payloadHashVerified: true, executorResult: { pid: 1, exitCode: 0, stdout: '', stderr: '', startTime: new Date(), endTime: new Date(), durationMs: 1, logContent: 'Document: DOC-1 SUCCESS\n' }, status: 'done', timestamp: new Date() },
            expectedIds: ['DOC-1', 'DOC-2'],
        },
    ];

    for (const s of scenarios) {
        it(`matches legacy for scenario: ${s.name}`, () => {
            const legacy = legacyGate5.validate({ expectedDocumentIds: s.expectedIds, evidence: s.evidence });
            const nexus = rule.evaluate({ expectedDocumentIds: s.expectedIds, evidence: s.evidence });
            expect(nexus).toEqual(legacy);
        });
    }
});
