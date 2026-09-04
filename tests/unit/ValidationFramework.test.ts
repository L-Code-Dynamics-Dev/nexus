import { describe, it, expect } from 'vitest';
import { aggregateStageStatus } from '../../core/validation/errorIsolation.js';
import type { StageError } from '../../core/validation/types.js';

describe('aggregateStageStatus — error isolation (§7)', () => {
    it('happy path: no errors => SUCCESS', () => {
        expect(aggregateStageStatus(100, [])).toBe('SUCCESS');
    });

    it('single record failure: 9999 OK + 1 FAILED => PARTIAL_SUCCESS, batch continues', () => {
        const errors: StageError[] = [{ recordId: 'r1', message: 'invalid', errorClass: 'NON_RETRYABLE' }];
        expect(aggregateStageStatus(10000, errors)).toBe('PARTIAL_SUCCESS');
    });

    it('exact batch isolation scenario: 10000 records, 9997 success, 2 failed, 1 manual review => PARTIAL_SUCCESS, never a hard stop', () => {
        const errors: StageError[] = [
            { recordId: 'fail_1', message: 'parse error', errorClass: 'NON_RETRYABLE' },
            { recordId: 'fail_2', message: 'timeout', errorClass: 'RETRYABLE' },
            { recordId: 'review_1', message: 'unexpected external state', errorClass: 'MANUAL_REQUIRED' },
        ];
        const status = aggregateStageStatus(10000, errors);
        expect(status).toBe('PARTIAL_SUCCESS');
        expect(status).not.toBe('FAILED');
    });

    it('all records failed => FAILED (systemic, not per-item)', () => {
        const errors: StageError[] = [{ recordId: 'r1', message: 'x', errorClass: 'NON_RETRYABLE' }];
        expect(aggregateStageStatus(1, errors)).toBe('FAILED');
    });

    it('zero processed records => SKIPPED', () => {
        expect(aggregateStageStatus(0, [])).toBe('SKIPPED');
    });

    it('error class distinguishes retry strategy', () => {
        const retryable: StageError = { recordId: 'r1', message: 'network timeout', errorClass: 'RETRYABLE' };
        const nonRetryable: StageError = { recordId: 'r2', message: 'invalid product code', errorClass: 'NON_RETRYABLE' };
        const manual: StageError = { recordId: 'r3', message: 'unexpected external state', errorClass: 'MANUAL_REQUIRED' };
        expect(retryable.errorClass).toBe('RETRYABLE');
        expect(nonRetryable.errorClass).toBe('NON_RETRYABLE');
        expect(manual.errorClass).toBe('MANUAL_REQUIRED');
    });
});
