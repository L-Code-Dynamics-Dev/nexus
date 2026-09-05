// WarehouseStockFlow -- Fáze 6.4 business flow testy. Kompozice nad
// WarehouseStockLinkRule, žádná nová validace -- testy ověřují 1:1
// wrapper i pole-variantu (nezávislé výsledky, žádná agregace).

import { describe, it, expect } from 'vitest';
import {
    evaluateWarehouseStockLink,
    resolveWarehouseStockLinks,
} from '../../domains/warehouse/WarehouseStockFlow.js';
import type { Warehouse } from '../../core/canonical/entities/Warehouse.js';
import type { StockPosition } from '../../core/canonical/entities/Stock.js';

const now = '2026-09-05T00:00:00Z';
const ctx = { tenantId: 'ten_1', ruleId: 'warehouse-stock-flow-v1', ruleVersion: '1' };

function makeWarehouse(overrides: Partial<Warehouse> = {}): Warehouse {
    return {
        id: 'wh_1',
        tenantId: 'ten_1',
        createdAt: now,
        updatedAt: now,
        name: 'Centrální sklad Praha',
        isPhysical: true,
        status: 'ACTIVE',
        ...overrides,
    };
}

function makeStockPosition(overrides: Partial<StockPosition> = {}): StockPosition {
    return {
        id: 'stock_1',
        tenantId: 'ten_1',
        createdAt: now,
        updatedAt: now,
        productId: 'prod_1',
        warehouseId: 'wh_1',
        quantity: 10,
        purchasable: true,
        canPreorder: false,
        inTransit: false,
        observedAt: now,
        ...overrides,
    };
}

describe('evaluateWarehouseStockLink (1:1 wrapper)', () => {
    it('potvrdí platnou vazbu na ACTIVE Warehouse', () => {
        const result = evaluateWarehouseStockLink(ctx, makeWarehouse(), makeStockPosition());
        expect(result.isValidActiveLink).toBe(true);
        expect(result.linkStatus).toBe('ACTIVE_LINK');
    });

    it('zamítne vazbu na INACTIVE Warehouse', () => {
        const result = evaluateWarehouseStockLink(
            ctx,
            makeWarehouse({ status: 'INACTIVE' }),
            makeStockPosition()
        );
        expect(result.isValidActiveLink).toBe(false);
        expect(result.linkStatus).toBe('INACTIVE_WAREHOUSE');
    });

    it('deleguje 1:1 na WarehouseStockLinkRule -- žádná nová logika, stejný výsledek shape', () => {
        const result = evaluateWarehouseStockLink(ctx, makeWarehouse(), makeStockPosition({ warehouseId: undefined }));
        expect(result.linkStatus).toBe('UNSCOPED');
        expect(result.isValidActiveLink).toBe(false);
    });
});

describe('resolveWarehouseStockLinks (pole-varianta, nezávislé výsledky)', () => {
    it('vrátí jeden výsledek per StockPosition, ve stejném pořadí jako vstup', () => {
        const positions = [
            makeStockPosition({ id: 'stock_a', warehouseId: 'wh_1' }),
            makeStockPosition({ id: 'stock_b', warehouseId: undefined }),
            makeStockPosition({ id: 'stock_c', warehouseId: 'wh_other' }),
        ];
        const results = resolveWarehouseStockLinks(ctx, makeWarehouse(), positions);

        expect(results).toHaveLength(3);
        expect(results.map((r) => r.stockPositionId)).toEqual(['stock_a', 'stock_b', 'stock_c']);
        expect(results[0]?.result.linkStatus).toBe('ACTIVE_LINK');
        expect(results[1]?.result.linkStatus).toBe('UNSCOPED');
        expect(results[2]?.result.linkStatus).toBe('MISMATCHED_WAREHOUSE');
    });

    it('nepočítá žádnou agregaci -- výsledky jsou nezávislé, žádné souhrnné pole navíc', () => {
        const positions = [makeStockPosition({ id: 'stock_a' }), makeStockPosition({ id: 'stock_b' })];
        const results = resolveWarehouseStockLinks(ctx, makeWarehouse(), positions);

        expect(results).toHaveLength(2);
        expect(Object.keys(results[0] ?? {})).toEqual(['stockPositionId', 'result']);
    });

    it('prázdné pole StockPosition vrátí prázdné pole výsledků', () => {
        const results = resolveWarehouseStockLinks(ctx, makeWarehouse(), []);
        expect(results).toEqual([]);
    });

    it('sklad INACTIVE zamítne všechny pozice stejně (žádná výjimka per pozice)', () => {
        const positions = [
            makeStockPosition({ id: 'stock_a', warehouseId: 'wh_1' }),
            makeStockPosition({ id: 'stock_b', warehouseId: 'wh_1' }),
        ];
        const results = resolveWarehouseStockLinks(ctx, makeWarehouse({ status: 'INACTIVE' }), positions);

        expect(results.every((r) => r.result.linkStatus === 'INACTIVE_WAREHOUSE')).toBe(true);
    });
});
