import { describe, it, expect } from 'vitest';
import {
    classifyDrift,
    evaluateDebounce,
    aggregateMultiEntityBatch,
    evaluateHistoricalCheckpoint,
    type DebounceState,
    type MultiEntityReconciliationItem,
    type HistoricalReconciliationCheckpoint,
} from '../../core/reconciliation/GenericReconciliation.js';

describe('classifyDrift — tolerance-based drift (reconcile-coupon-drift.ts vzor)', () => {
    it('rozdíl uvnitř tolerance je MATCHED (zaokrouhlovací šum)', () => {
        expect(classifyDrift(0.15, 0.1503, 0.001, 0.05)).toBe('MATCHED');
    });

    it('rozdíl mimo toleranci ale pod major threshold je DRIFT_MINOR', () => {
        expect(classifyDrift(0.15, 0.16, 0.001, 0.05)).toBe('DRIFT_MINOR');
    });

    it('rozdíl nad major threshold je DRIFT_MAJOR', () => {
        expect(classifyDrift(0.15, 0.5, 0.001, 0.05)).toBe('DRIFT_MAJOR');
    });

    it('přesná shoda je MATCHED', () => {
        expect(classifyDrift(0.15, 0.15, 0.001, 0.05)).toBe('MATCHED');
    });
});

describe('evaluateDebounce — mismatch alertuje až po druhém běhu (.coupon_reconciliation_state.json vzor)', () => {
    it('první výskyt mismatche se jen zaznamená, nealertuje', () => {
        const state: DebounceState = {};
        const result = evaluateDebounce('SKU1::ZR20', { expected: '0.15', actual: '0.16', immediate: false }, state);

        expect(result.shouldAlert).toBe(false);
        expect(result.nextState['SKU1::ZR20']).toBeDefined();
    });

    it('mismatch přetrvávající přes druhý běh alertuje', () => {
        const firstRunState: DebounceState = {};
        const firstRun = evaluateDebounce('SKU1::ZR20', { expected: '0.15', actual: '0.16', immediate: false }, firstRunState);

        const secondRun = evaluateDebounce('SKU1::ZR20', { expected: '0.15', actual: '0.16', immediate: false }, firstRun.nextState);

        expect(secondRun.shouldAlert).toBe(true);
        expect(secondRun.nextState['SKU1::ZR20']!.firstSeenAt).toBe(firstRun.nextState['SKU1::ZR20']!.firstSeenAt);
    });

    it('mismatch, co zmizel (opraven mezi běhy), se vyčistí ze stavu, nealertuje', () => {
        const firstRunState: DebounceState = {};
        const firstRun = evaluateDebounce('SKU1::ZR20', { expected: '0.15', actual: '0.16', immediate: false }, firstRunState);

        const secondRun = evaluateDebounce('SKU1::ZR20', null, firstRun.nextState);

        expect(secondRun.shouldAlert).toBe(false);
        expect(secondRun.nextState['SKU1::ZR20']).toBeUndefined();
    });

    it('immediate=true (missing item / locked rule violation) alertuje OKAMŽITĚ, bez debounce', () => {
        const state: DebounceState = {};
        const result = evaluateDebounce('SKU2::ZR25', { expected: 'false', actual: 'true', immediate: true }, state);

        expect(result.shouldAlert).toBe(true);
    });
});

describe('aggregateMultiEntityBatch — reconciliation napříč více entity typy', () => {
    it('agreguje status per-entity-type i celkově', () => {
        const items: MultiEntityReconciliationItem[] = [
            { itemId: 'sku1', entityType: 'Price', expected: '12.70', actual: '12.70', outcome: 'MATCHED' },
            { itemId: 'sku2', entityType: 'Price', expected: '9.90', actual: '9.90', outcome: 'MATCHED' },
            { itemId: 'sku1', entityType: 'Stock', expected: 5, actual: 3, outcome: 'DIFF' },
        ];

        const result = aggregateMultiEntityBatch('ten_1', items);

        expect(result.statusByEntityType.Price).toBe('COMPLETE');
        expect(result.statusByEntityType.Stock).toBe('COMPLETE_WITH_ERRORS');
        expect(result.overallStatus).toBe('COMPLETE_WITH_ERRORS');
    });
});

describe('evaluateHistoricalCheckpoint — entity bez perzistovaného baseline (Confirmed Gap #3)', () => {
    it('bez baseline vrací UNKNOWN, NIKDY MATCHED', () => {
        const checkpoint: HistoricalReconciliationCheckpoint<number> = {
            entityId: 'stock-sku1',
            baselineAvailable: false,
            current: 10,
            checkedAt: '2026-09-05T00:00:00Z',
        };

        const outcome = evaluateHistoricalCheckpoint(checkpoint, (baseline, current) => (baseline === current ? 'MATCHED' : 'DIFF'));
        expect(outcome).toBe('UNKNOWN');
    });

    it('s baseline provede skutečné porovnání', () => {
        const checkpoint: HistoricalReconciliationCheckpoint<number> = {
            entityId: 'stock-sku1',
            baselineAvailable: true,
            baseline: 10,
            current: 10,
            checkedAt: '2026-09-05T00:00:00Z',
        };

        const outcome = evaluateHistoricalCheckpoint(checkpoint, (baseline, current) => (baseline === current ? 'MATCHED' : 'DIFF'));
        expect(outcome).toBe('MATCHED');
    });
});
