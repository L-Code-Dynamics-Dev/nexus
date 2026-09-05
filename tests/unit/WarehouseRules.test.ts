// WarehouseStockLinkRule -- Fáze 6.2 business rules testy. Pokrývá aktivní/
// neaktivní sklad, chybějící vazbu, a nesouhlasící warehouseId.

import { describe, it, expect } from 'vitest';
import { WarehouseStockLinkRule } from '../../domains/warehouse/WarehouseStockLinkRule.js';
import type { Warehouse } from '../../core/canonical/entities/Warehouse.js';
import type { StockPosition } from '../../core/canonical/entities/Stock.js';

const now = '2026-09-05T00:00:00Z';

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

describe('WarehouseStockLinkRule', () => {
    const rule = new WarehouseStockLinkRule({ tenantId: 'ten_1', ruleId: 'warehouse-stock-link-v1', ruleVersion: '1' });

    it('potvrdí platnou vazbu na ACTIVE Warehouse', () => {
        const result = rule.evaluate({ warehouse: makeWarehouse(), stockPosition: makeStockPosition() });
        expect(result.isValidActiveLink).toBe(true);
        expect(result.reason).toBeUndefined();
    });

    it('zamítne vazbu na INACTIVE Warehouse', () => {
        const result = rule.evaluate({
            warehouse: makeWarehouse({ status: 'INACTIVE' }),
            stockPosition: makeStockPosition(),
        });
        expect(result.isValidActiveLink).toBe(false);
        expect(result.reason).toMatch(/není aktivní/i);
    });

    it('zamítne, když StockPosition.warehouseId chybí (undefined)', () => {
        const result = rule.evaluate({
            warehouse: makeWarehouse(),
            stockPosition: makeStockPosition({ warehouseId: undefined }),
        });
        expect(result.isValidActiveLink).toBe(false);
        expect(result.reason).toMatch(/nemá warehouseId/i);
    });

    it('zamítne, když StockPosition.warehouseId neodpovídá předanému Warehouse.id', () => {
        const result = rule.evaluate({
            warehouse: makeWarehouse({ id: 'wh_1' }),
            stockPosition: makeStockPosition({ warehouseId: 'wh_2' }),
        });
        expect(result.isValidActiveLink).toBe(false);
        expect(result.reason).toMatch(/neodpovídá/i);
    });

    it('nepřidává žádnou vazbu na Supplier -- vstupní ani výstupní shape ho neobsahuje', () => {
        const result = rule.evaluate({ warehouse: makeWarehouse(), stockPosition: makeStockPosition() });
        expect('supplierId' in result).toBe(false);
    });

    it('je čistá funkce -- stejný vstup vždy stejný výstup', () => {
        const input = { warehouse: makeWarehouse(), stockPosition: makeStockPosition() };
        const first = rule.evaluate(input);
        const second = rule.evaluate(input);
        expect(first).toEqual(second);
    });
});
