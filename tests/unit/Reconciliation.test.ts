import { describe, it, expect } from 'vitest';
import { aggregateBatchStatus, type ReconciliationItemResult } from '../../core/canonical/reconciliation/Reconciliation.js';

describe('aggregateBatchStatus — error isolation (master prompt §8)', () => {
    it('10000 items, 9997 OK + 2 FAILED + 1 MANUAL_REVIEW => COMPLETE_WITH_ERRORS, never a hard stop', () => {
        const items: ReconciliationItemResult[] = [
            ...Array.from({ length: 9997 }, (_, i) => ({ itemId: `ok_${i}`, expected: 1, actual: 1, outcome: 'MATCHED' as const })),
            { itemId: 'fail_1', expected: 1, actual: 2, outcome: 'FAILED' as const },
            { itemId: 'fail_2', expected: 1, actual: null, outcome: 'FAILED' as const },
            { itemId: 'review_1', expected: 1, actual: 1, outcome: 'MANUAL_REVIEW' as const },
        ];
        expect(aggregateBatchStatus(items)).toBe('COMPLETE_WITH_ERRORS');
    });

    it('all matched => COMPLETE', () => {
        const items: ReconciliationItemResult[] = [
            { itemId: 'a', expected: 1, actual: 1, outcome: 'MATCHED' },
        ];
        expect(aggregateBatchStatus(items)).toBe('COMPLETE');
    });

    it('a single FAILED item does not fail the whole batch', () => {
        const items: ReconciliationItemResult[] = [
            { itemId: 'ok', expected: 1, actual: 1, outcome: 'MATCHED' },
            { itemId: 'bad', expected: 1, actual: 0, outcome: 'FAILED' },
        ];
        expect(aggregateBatchStatus(items)).toBe('COMPLETE_WITH_ERRORS');
    });
});
