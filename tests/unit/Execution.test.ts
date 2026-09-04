import { describe, it, expect } from 'vitest';
import { isConfirmedSuccess, type Execution } from '../../core/canonical/lifecycle/Execution.js';

function makeExecution(status: Execution['status']): Execution {
    return {
        executionId: 'exec_1',
        tenantId: 'ten_1',
        decisionId: 'dec_1',
        connectorId: 'shoptet-csv',
        attempt: 1,
        status,
        startedAt: '2026-01-01T00:00:00Z',
        requestFingerprint: 'fp_1',
        retryPolicy: 'RETRYABLE',
    };
}

describe('isConfirmedSuccess — SENT != CONFIRMED (Shoptet HTTP 200 incident)', () => {
    it('SENT (connector returned no error) is NOT treated as success', () => {
        expect(isConfirmedSuccess(makeExecution('SENT'))).toBe(false);
    });

    it('only CONFIRMED (post-reconciliation) counts as success', () => {
        expect(isConfirmedSuccess(makeExecution('CONFIRMED'))).toBe(true);
    });

    it('FAILED and RETRYING are not success', () => {
        expect(isConfirmedSuccess(makeExecution('FAILED'))).toBe(false);
        expect(isConfirmedSuccess(makeExecution('RETRYING'))).toBe(false);
    });
});
