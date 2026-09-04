import { describe, it, expect } from 'vitest';
import { assertReceivingInvariant, type PurchaseOrderItem } from '../../core/canonical/entities/PurchaseOrder.js';
import Decimal from 'decimal.js';

function makeItem(quantity: number, receivedQuantity: number): PurchaseOrderItem {
    return {
        id: 'item_1',
        tenantId: 'ten_1',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        purchaseOrderId: 'po_1',
        productId: 'prod_1',
        quantity,
        receivedQuantity,
        unitPrice: { amount: new Decimal(10), currency: 'CZK' },
    };
}

describe('assertReceivingInvariant', () => {
    it('allows receiving up to the ordered quantity', () => {
        const item = makeItem(10, 5);
        expect(() => assertReceivingInvariant(item, 5)).not.toThrow();
    });

    it('throws on over-receiving', () => {
        const item = makeItem(10, 5);
        expect(() => assertReceivingInvariant(item, 6)).toThrow(/Over-receiving/);
    });

    it('allows exact match to ordered quantity', () => {
        const item = makeItem(10, 0);
        expect(() => assertReceivingInvariant(item, 10)).not.toThrow();
    });
});
