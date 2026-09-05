// core/audit framework testy -- append-only invariant, hash konzistence,
// a reprodukce Omega PipelineAuditRecord shape (4 hashe + stateHistory).
// Žádný z testů nenapojuje framework na produkční kód -- čistě
// framework-level ověření.

import { describe, it, expect } from 'vitest';
import {
    createAuditLog,
    appendAuditRecord,
    withStateTransition,
    transitionResultToAuditEntry,
    type AuditRecord,
} from '../../core/audit/AuditRecord.js';
import { evaluateTransition, type StateAxisDefinition } from '../../core/state-machine/StateMachine.js';

describe('AuditLog — append-only invariant', () => {
    it('appendAuditRecord returns a NEW log, does not mutate the original', () => {
        const log = createAuditLog('ten_1');
        const record: AuditRecord = {
            recordId: 'rec_1',
            tenantId: 'ten_1',
            entityId: 'entity_1',
            eventType: 'CREATED',
            occurredAt: '2026-09-05T00:00:00Z',
            payload: { foo: 'bar' },
            hashes: {},
            stateHistory: [],
            errors: [],
            warnings: [],
        };

        const newLog = appendAuditRecord(log, record);

        expect(log.records).toHaveLength(0); // originál beze změny
        expect(newLog.records).toHaveLength(1);
        expect(newLog.records[0]).toEqual(record);
        expect(newLog).not.toBe(log); // nová reference, ne mutace
    });

    it('multiple appends accumulate records in order, never overwrite', () => {
        let log = createAuditLog('ten_1');
        for (let i = 0; i < 5; i++) {
            log = appendAuditRecord(log, {
                recordId: `rec_${i}`,
                tenantId: 'ten_1',
                entityId: 'entity_1',
                eventType: 'STEP',
                occurredAt: `2026-09-05T00:0${i}:00Z`,
                payload: { step: i },
                hashes: {},
                stateHistory: [],
                errors: [],
                warnings: [],
            });
        }
        expect(log.records).toHaveLength(5);
        expect(log.records.map((r) => r.recordId)).toEqual(['rec_0', 'rec_1', 'rec_2', 'rec_3', 'rec_4']);
    });

    it('refuses cross-tenant append (tenant isolation invariant)', () => {
        const log = createAuditLog('ten_1');
        const foreignRecord: AuditRecord = {
            recordId: 'rec_evil',
            tenantId: 'ten_2', // jiný tenant než log
            entityId: 'entity_1',
            eventType: 'CREATED',
            occurredAt: '2026-09-05T00:00:00Z',
            payload: {},
            hashes: {},
            stateHistory: [],
            errors: [],
            warnings: [],
        };

        expect(() => appendAuditRecord(log, foreignRecord)).toThrow(/Tenant mismatch/);
    });

    it('withStateTransition returns a NEW record, does not mutate the original', () => {
        const record: AuditRecord<'DRAFT' | 'SENT'> = {
            recordId: 'rec_1',
            tenantId: 'ten_1',
            entityId: 'entity_1',
            eventType: 'STATE_CHANGE',
            occurredAt: '2026-09-05T00:00:00Z',
            payload: {},
            hashes: {},
            stateHistory: [],
            errors: [],
            warnings: [],
        };

        const updated = withStateTransition(record, {
            from: 'DRAFT',
            to: 'SENT',
            timestamp: '2026-09-05T00:01:00Z',
            actor: 'system',
        });

        expect(record.stateHistory).toHaveLength(0); // originál beze změny
        expect(updated.stateHistory).toHaveLength(1);
        expect(updated.stateHistory[0]).toEqual({ from: 'DRAFT', to: 'SENT', timestamp: '2026-09-05T00:01:00Z', actor: 'system' });
    });
});

describe('AuditHashSet — hash consistency', () => {
    it('stores multiple named hashes independently, none required', () => {
        const record: AuditRecord = {
            recordId: 'rec_1',
            tenantId: 'ten_1',
            entityId: 'entity_1',
            eventType: 'PROCESSED',
            occurredAt: '2026-09-05T00:00:00Z',
            payload: {},
            hashes: {
                sourceHash: 'aaa',
                canonicalHash: 'bbb',
                payloadHash: 'ccc',
                evidenceHash: 'ddd',
            },
            stateHistory: [],
            errors: [],
            warnings: [],
        };

        expect(record.hashes.sourceHash).toBe('aaa');
        expect(record.hashes.canonicalHash).toBe('bbb');
        expect(record.hashes.payloadHash).toBe('ccc');
        expect(record.hashes.evidenceHash).toBe('ddd');
    });

    it('supports extra domain-specific hashes beyond the four named fields', () => {
        const record: AuditRecord = {
            recordId: 'rec_1',
            tenantId: 'ten_1',
            entityId: 'entity_1',
            eventType: 'PROCESSED',
            occurredAt: '2026-09-05T00:00:00Z',
            payload: {},
            hashes: { extra: { safeOrderChecksum: 'eee' } },
            stateHistory: [],
            errors: [],
            warnings: [],
        };

        expect(record.hashes.extra?.safeOrderChecksum).toBe('eee');
    });
});

describe('AuditRecord reproduces Omega PipelineAuditRecord shape', () => {
    // Reprodukuje ~/omega-bridge/src/core/orchestrator/PipelineAuditRecord.ts
    // (pipelineId/tenantId/sourceDocumentId/correlationId/jobId/currentState/
    // stateHistory/ruleSetVersion/mappingVersion/agentVersion/4 hashe/
    // errors/warnings) jako AuditRecord + payload s doménovými poli navíc,
    // ne re-implementaci PipelineAuditRecord typu samotného.

    type JobState = 'RECEIVED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

    const jobStateDefinition: StateAxisDefinition<JobState> = {
        axisName: 'jobState',
        initialState: 'RECEIVED',
        terminalStates: ['COMPLETED', 'FAILED'],
        transitions: {
            RECEIVED: ['PROCESSING', 'FAILED'],
            PROCESSING: ['COMPLETED', 'FAILED'],
            COMPLETED: [],
            FAILED: [],
        },
    };

    it('records a full pipeline run: 4 hashes + state history via core/state-machine bridge', () => {
        let log = createAuditLog<JobState>('ten_1');

        const record: AuditRecord<JobState> = {
            recordId: 'pipeline_run_1',
            tenantId: 'ten_1',
            entityId: 'job_42',
            eventType: 'PIPELINE_RUN',
            occurredAt: '2026-09-05T00:00:00Z',
            payload: {
                pipelineId: 'pipeline_1',
                sourceDocumentId: 'doc_1',
                correlationId: 'corr_1',
                jobId: 'job_42',
                ruleSetVersion: '1',
                mappingVersion: '1',
                agentVersion: '1',
            },
            hashes: {
                sourceHash: 'source_abc',
                canonicalHash: 'canonical_def',
                payloadHash: 'payload_ghi',
                evidenceHash: 'evidence_jkl',
            },
            stateHistory: [],
            errors: [],
            warnings: [],
        };

        log = appendAuditRecord(log, record);

        // Simuluje přechod RECEIVED -> PROCESSING přes core/state-machine,
        // zaznamenaný do audit historie mostem transitionResultToAuditEntry.
        const transition1 = evaluateTransition(jobStateDefinition, 'RECEIVED', 'PROCESSING');
        expect(transition1.allowed).toBe(true);
        const entry1 = transitionResultToAuditEntry(transition1, 'sync-worker', '2026-09-05T00:00:01Z');

        const transition2 = evaluateTransition(jobStateDefinition, 'PROCESSING', 'COMPLETED');
        expect(transition2.allowed).toBe(true);
        const entry2 = transitionResultToAuditEntry(transition2, 'sync-worker', '2026-09-05T00:00:02Z', 'post-import validation passed');

        const updatedRecord = withStateTransition(withStateTransition(record, entry1), entry2);

        expect(updatedRecord.stateHistory).toEqual([
            { from: 'RECEIVED', to: 'PROCESSING', timestamp: '2026-09-05T00:00:01Z', actor: 'sync-worker', reason: undefined },
            { from: 'PROCESSING', to: 'COMPLETED', timestamp: '2026-09-05T00:00:02Z', actor: 'sync-worker', reason: 'post-import validation passed' },
        ]);
        // Původní záznam v logu beze změny -- append-only, oprava = nový záznam.
        expect(log.records[0]?.stateHistory).toHaveLength(0);
    });

    it('rejects an illegal transition attempt before it reaches the audit log', () => {
        const illegal = evaluateTransition(jobStateDefinition, 'COMPLETED', 'PROCESSING');
        expect(illegal.allowed).toBe(false);
        expect(illegal.reason).toContain('terminal');
    });
});

describe('AuditRecord reproduces AIE procurement_audit_log shape (simple case, no state/hashes)', () => {
    // ~/availability-intelligence-engine/migrations/001_procurement_core.sql:26-29
    // -- prostá JSONB tabulka (tenant_id, event_type, entity_id, payload,
    // occurred_at), žádné hashe, žádná state historie. AuditRecord typ
    // dovoluje tenhle "prázdný" případ beze změny kontraktu -- hashes/
    // stateHistory nejsou povinně vyplněné, jen povinně PŘÍTOMNÉ (prázdné
    // hodnoty), takže se framework hodí i na doménu bez lifecycle.
    it('supports a bare event log entry with empty hashes and stateHistory', () => {
        const log = createAuditLog('ten_1');
        const record: AuditRecord<never> = {
            recordId: 'evt_1',
            tenantId: 'ten_1',
            entityId: 'po_123',
            eventType: 'PURCHASE_ORDER_CREATED',
            occurredAt: '2026-09-05T00:00:00Z',
            payload: { supplierId: 'sup_1', totalAmount: '1500.00' },
            hashes: {},
            stateHistory: [],
            errors: [],
            warnings: [],
        };

        const updated = appendAuditRecord(log, record);
        expect(updated.records).toHaveLength(1);
        expect(updated.records[0]?.stateHistory).toEqual([]);
        expect(updated.records[0]?.hashes).toEqual({});
    });
});
