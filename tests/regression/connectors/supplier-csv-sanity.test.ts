// Sanity test proti skutečně portovanému NoApiCsvAdapter
// (connectors/supplier-csv/legacy/NoApiCsvAdapter.ts), 1:1 kopie z
// ~/availability-intelligence-engine/src/platform/suppliers/NoApiCsvAdapter.ts.
// Toto je SUPPLIER procurement CSV kanál, NENÍ Shoptet connector -- viz
// commit message pro zdůvodnění proč je oddělený od connectors/shoptet/.

import { describe, it, expect } from 'vitest';
import { NoApiCsvAdapter } from '../../../connectors/supplier-csv/legacy/NoApiCsvAdapter.js';
import type { PurchaseOrder } from '../../../connectors/availability-intelligence/legacy/procurement/types.js';

describe('NoApiCsvAdapter sanity', () => {
    const adapter = new NoApiCsvAdapter();

    it('exportPurchaseOrder produces supplierSku,quantity CSV', () => {
        const order: PurchaseOrder = {
            id: 'po-1',
            supplierId: 'sup-1',
            status: 'DRAFT',
            lines: [
                { id: 'l1', supplierId: 'sup-1', customerOrderLineId: 'c1', productId: 'p1', variantId: 'v1', sku: 'SKU1', supplierSku: 'SSKU1', quantity: 5, receivedQuantity: 0, unitPrice: 10, currency: 'CZK', expectedLeadTimeDays: 3 },
            ],
        };
        const csv = adapter.exportPurchaseOrder(order);
        expect(csv).toBe('supplierSku,quantity\nSSKU1,5');
    });

    it('importSupplierOffers parses valid CSV into SupplierOffer[]', () => {
        const csv = 'supplierSku,productId,variantId,availableQuantity,unitPrice,currency,leadTimeDays\n' +
            'SSKU1,p1,v1,100,10.5,CZK,3\n';
        const offers = adapter.importSupplierOffers('sup-1', csv);

        expect(offers).toHaveLength(1);
        expect(offers[0]).toMatchObject({ supplierId: 'sup-1', supplierSku: 'SSKU1', availableQuantity: 100, unitPrice: 10.5, active: true });
    });

    it('importSupplierOffers throws on missing required string fields', () => {
        const csv = 'supplierSku,productId,variantId,availableQuantity,unitPrice,currency,leadTimeDays\n' +
            ',p1,v1,100,10.5,CZK,3\n';
        expect(() => adapter.importSupplierOffers('sup-1', csv)).toThrow();
    });

    it('importSupplierOffers returns empty array for header-only CSV', () => {
        const csv = 'supplierSku,productId,variantId,availableQuantity,unitPrice,currency,leadTimeDays\n';
        expect(adapter.importSupplierOffers('sup-1', csv)).toEqual([]);
    });

    it('importGoodsReceipt parses valid CSV into GoodsReceiptLine[]', () => {
        const csv = 'purchaseOrderId,procurementLineId,receivedQuantity\npo-1,l1,5\n';
        const receipt = adapter.importGoodsReceipt(csv);
        expect(receipt).toEqual([{ purchaseOrderId: 'po-1', procurementLineId: 'l1', receivedQuantity: 5 }]);
    });

    it('importGoodsReceipt throws on missing required fields', () => {
        const csv = 'purchaseOrderId,procurementLineId,receivedQuantity\n,l1,5\n';
        expect(() => adapter.importGoodsReceipt(csv)).toThrow();
    });
});
