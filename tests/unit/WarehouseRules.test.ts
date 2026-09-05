// WarehouseStockLinkRule -- Fáze 6.2 business rules testy + Fáze 6.3
// rozhodnutí (warehouseId undefined = UNSCOPED, ne "hlavní sklad").
// Pokrývá aktivní/neaktivní sklad, chybějící vazbu, a nesouhlasící warehouseId.

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

    it('potvrdí platnou vazbu na ACTIVE Warehouse -- linkStatus ACTIVE_LINK', () => {
        const result = rule.evaluate({ warehouse: makeWarehouse(), stockPosition: makeStockPosition() });
        expect(result.isValidActiveLink).toBe(true);
        expect(result.linkStatus).toBe('ACTIVE_LINK');
        expect(result.reason).toBeUndefined();
    });

    it('zamítne vazbu na INACTIVE Warehouse -- linkStatus INACTIVE_WAREHOUSE', () => {
        const result = rule.evaluate({
            warehouse: makeWarehouse({ status: 'INACTIVE' }),
            stockPosition: makeStockPosition(),
        });
        expect(result.isValidActiveLink).toBe(false);
        expect(result.linkStatus).toBe('INACTIVE_WAREHOUSE');
        expect(result.reason).toMatch(/není aktivní/i);
    });

    it('ROZHODNUTO (Fáze 6.3): warehouseId undefined -- linkStatus UNSCOPED, NENÍ chyba, NENÍ automaticky "hlavní sklad"', () => {
        const result = rule.evaluate({
            warehouse: makeWarehouse(),
            stockPosition: makeStockPosition({ warehouseId: undefined }),
        });
        expect(result.isValidActiveLink).toBe(false);
        expect(result.linkStatus).toBe('UNSCOPED');
        expect(result.reason).toMatch(/globální|dosud neurčený/i);
        // Rule nikdy nevrací žádný konkrétní Warehouse.id jako fallback --
        // isValidActiveLink zůstává false, žádné "vybráno automaticky".
        expect(result.isValidActiveLink).toBe(false);
    });

    it('zamítne, když StockPosition.warehouseId neodpovídá předanému Warehouse.id -- linkStatus MISMATCHED_WAREHOUSE', () => {
        const result = rule.evaluate({
            warehouse: makeWarehouse({ id: 'wh_1' }),
            stockPosition: makeStockPosition({ warehouseId: 'wh_2' }),
        });
        expect(result.isValidActiveLink).toBe(false);
        expect(result.linkStatus).toBe('MISMATCHED_WAREHOUSE');
        expect(result.reason).toMatch(/neodpovídá/i);
    });

    it('linkStatus UNSCOPED je odlišný od MISMATCHED_WAREHOUSE a INACTIVE_WAREHOUSE (tři různé diskriminanty)', () => {
        const unscoped = rule.evaluate({ warehouse: makeWarehouse(), stockPosition: makeStockPosition({ warehouseId: undefined }) });
        const mismatched = rule.evaluate({ warehouse: makeWarehouse(), stockPosition: makeStockPosition({ warehouseId: 'wh_other' }) });
        const inactive = rule.evaluate({ warehouse: makeWarehouse({ status: 'INACTIVE' }), stockPosition: makeStockPosition() });

        const statuses = new Set([unscoped.linkStatus, mismatched.linkStatus, inactive.linkStatus]);
        expect(statuses.size).toBe(3);
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
