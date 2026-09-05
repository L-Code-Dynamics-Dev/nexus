// Sanity test proti skutečně portovanému Omega/ERP adapter kódu
// (connectors/omega/legacy/), 1:1 kopie z ~/omega-bridge/src/adapters/
// targets/omega/ + gate5/. Ověřuje, že portovaný pipeline funguje, než
// se začne migrovat pod Nexus Rule contract.

import { describe, it, expect } from 'vitest';
import { Decimal } from 'decimal.js';
import { OmegaMapper } from '../../../connectors/omega/legacy/OmegaMapper.js';
import { OmegaOutputValidationGate } from '../../../connectors/omega/legacy/OmegaOutputValidationGate.js';
import { OmegaAdapter } from '../../../connectors/omega/legacy/OmegaAdapter.js';
import { OmegaImportLogParser } from '../../../connectors/omega/legacy/gate5/OmegaImportLogParser.js';
import { OmegaPostImportValidationGate } from '../../../connectors/omega/legacy/gate5/OmegaPostImportValidationGate.js';
import type { CanonicalAccountingDocument } from '../../../connectors/omega/legacy/core/CanonicalAccountingDocument.js';
import type { AgentEvidence } from '../../../connectors/omega/legacy/agent/AgentEvidence.js';

function makeDocument(overrides?: Partial<CanonicalAccountingDocument>): CanonicalAccountingDocument {
    return {
        sourceDocumentId: 'DOC-1',
        documentType: 'INVOICE',
        issueDate: new Date('2026-09-05'),
        currency: 'CZK',
        supplier: { id: 's1', name: 'Supplier', street: 'St 1', city: 'Praha', zipCode: '10000', country: 'CZ' },
        customer: { id: 'c1', name: 'Customer', ico: '12345678', dic: 'CZ12345678', street: 'St 2', city: 'Brno', zipCode: '60200', country: 'CZ' },
        lines: [
            { text: 'Widget', quantity: new Decimal(2), unitPriceWithoutTax: new Decimal(100), taxRate: 21, taxAmount: new Decimal(42), totalWithTax: new Decimal(242) },
        ],
        summary: { totalWithoutTax: new Decimal(200), totalTax: new Decimal(42), totalWithTax: new Decimal(242) },
        ...overrides,
    };
}

describe('OmegaMapper sanity', () => {
    it('generates R01/R02 tab-delimited content with sha256 hash', () => {
        const mapper = new OmegaMapper();
        const payload = mapper.map([makeDocument()], 'corr-1');

        expect(payload.content).toContain('R01\t');
        expect(payload.content).toContain('R02\t');
        expect(payload.encoding).toBe('Windows-1250');
        expect(payload.documentCount).toBe(1);
        expect(payload.itemCount).toBe(1);
        expect(payload.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('formats decimal with comma separator (Omega/Pohoda convention)', () => {
        const mapper = new OmegaMapper();
        const payload = mapper.map([makeDocument()], 'corr-1');
        expect(payload.content).toContain('242,00'); // totalWithTax
    });
});

describe('OmegaOutputValidationGate sanity — structural + financial reconciliation', () => {
    it('valid payload passes reconciliation', () => {
        const mapper = new OmegaMapper();
        const gate = new OmegaOutputValidationGate();
        const documents = [makeDocument()];
        const payload = mapper.map(documents, 'corr-1');

        const result = gate.validate({ sourceDocuments: documents, generatedPayload: payload });
        expect(result.valid).toBe(true);
    });

    it('detects financial total mismatch between source and generated payload', () => {
        const mapper = new OmegaMapper();
        const gate = new OmegaOutputValidationGate();
        const documents = [makeDocument({ summary: { totalWithoutTax: new Decimal(999), totalTax: new Decimal(0), totalWithTax: new Decimal(999) } })];
        const payload = mapper.map(documents, 'corr-1');

        const result = gate.validate({ sourceDocuments: documents, generatedPayload: payload });
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.code === 'OUTPUT_TOTAL_MISMATCH')).toBe(true);
    });
});

describe('OmegaAdapter sanity — full process() pipeline', () => {
    it('READY_FOR_DELIVERY for valid documents', async () => {
        const adapter = new OmegaAdapter();
        const result = await adapter.process([makeDocument()], 'corr-1');
        expect(result.status).toBe('READY_FOR_DELIVERY');
        expect(result.payload).toBeDefined();
    });

    it('OUTPUT_VALIDATION_FAILED for mismatched totals', async () => {
        const adapter = new OmegaAdapter();
        const badDoc = makeDocument({ summary: { totalWithoutTax: new Decimal(1), totalTax: new Decimal(0), totalWithTax: new Decimal(1) } });
        const result = await adapter.process([badDoc], 'corr-1');
        expect(result.status).toBe('OUTPUT_VALIDATION_FAILED');
    });
});

describe('OmegaImportLogParser + Gate5 sanity — post-import validation', () => {
    it('parses SUCCESS log lines into imported document IDs', () => {
        const parser = new OmegaImportLogParser();
        const result = parser.parse('Document: DOC-1 SUCCESS\nDocument: DOC-2 SUCCESS\n');
        expect(result.importedDocumentIds).toEqual(['DOC-1', 'DOC-2']);
        expect(result.errors).toEqual([]);
    });

    it('missing log content -> LOG_MISSING error', () => {
        const parser = new OmegaImportLogParser();
        const result = parser.parse(null);
        expect(result.errors).toContain('LOG_MISSING');
    });

    it('Gate5: successful execution with all documents confirmed -> COMPLETED', () => {
        const gate = new OmegaPostImportValidationGate();
        const evidence: AgentEvidence = {
            jobId: 'job-1', correlationId: 'corr-1', agentId: 'agent-1',
            payloadHashVerified: true,
            executorResult: { pid: 1, exitCode: 0, stdout: '', stderr: '', startTime: new Date(), endTime: new Date(), durationMs: 100, logContent: 'Document: DOC-1 SUCCESS\n' },
            status: 'done', timestamp: new Date(),
        };
        const result = gate.validate({ expectedDocumentIds: ['DOC-1'], evidence });
        expect(result.finalStatus).toBe('COMPLETED');
    });

    it('Gate5: payload hash not verified -> QUARANTINED immediately', () => {
        const gate = new OmegaPostImportValidationGate();
        const evidence: AgentEvidence = {
            jobId: 'job-1', correlationId: 'corr-1', agentId: 'agent-1',
            payloadHashVerified: false,
            status: 'done', timestamp: new Date(),
        };
        const result = gate.validate({ expectedDocumentIds: ['DOC-1'], evidence });
        expect(result.finalStatus).toBe('QUARANTINED');
    });

    it('Gate5: non-zero exit code -> TARGET_RESULT_UNKNOWN', () => {
        const gate = new OmegaPostImportValidationGate();
        const evidence: AgentEvidence = {
            jobId: 'job-1', correlationId: 'corr-1', agentId: 'agent-1',
            payloadHashVerified: true,
            executorResult: { pid: 1, exitCode: 1, stdout: '', stderr: 'err', startTime: new Date(), endTime: new Date(), durationMs: 100, logContent: null },
            status: 'done', timestamp: new Date(),
        };
        const result = gate.validate({ expectedDocumentIds: ['DOC-1'], evidence });
        expect(result.finalStatus).toBe('TARGET_RESULT_UNKNOWN');
    });

    it('Gate5: document count mismatch -> POST_IMPORT_VALIDATION_FAILED', () => {
        const gate = new OmegaPostImportValidationGate();
        const evidence: AgentEvidence = {
            jobId: 'job-1', correlationId: 'corr-1', agentId: 'agent-1',
            payloadHashVerified: true,
            executorResult: { pid: 1, exitCode: 0, stdout: '', stderr: '', startTime: new Date(), endTime: new Date(), durationMs: 100, logContent: 'Document: DOC-1 SUCCESS\n' },
            status: 'done', timestamp: new Date(),
        };
        const result = gate.validate({ expectedDocumentIds: ['DOC-1', 'DOC-2'], evidence });
        expect(result.finalStatus).toBe('POST_IMPORT_VALIDATION_FAILED');
    });
});
