import { describe, it, expect } from 'vitest';
import { ExportPurchaseOrderRule, ImportSupplierOffersRule, ImportGoodsReceiptRule } from '../../../domains/supplier-csv/SupplierCsvRule.js';
import { NoApiCsvAdapter } from '../../../connectors/supplier-csv/legacy/NoApiCsvAdapter.js';
import type { PurchaseOrder } from '../../../connectors/availability-intelligence/legacy/procurement/types.js';

const legacyAdapter = new NoApiCsvAdapter();
const ctx = { tenantId: 'ten_1', ruleVersion: '1' };

describe('SupplierCsvRule parity vs legacy NoApiCsvAdapter', () => {
    const order: PurchaseOrder = {
        id: 'po-1', supplierId: 'sup-1', status: 'DRAFT',
        lines: [{ id: 'l1', supplierId: 'sup-1', customerOrderLineId: 'c1', productId: 'p1', variantId: 'v1', sku: 'SKU1', supplierSku: 'SSKU1', quantity: 5, receivedQuantity: 0, unitPrice: 10, currency: 'CZK', expectedLeadTimeDays: 3 }],
    };

    it('ExportPurchaseOrderRule matches legacy', () => {
        const rule = new ExportPurchaseOrderRule({ ...ctx, ruleId: 'export-po-v1' });
        expect(rule.evaluate(order)).toBe(legacyAdapter.exportPurchaseOrder(order));
    });

    it('ImportSupplierOffersRule matches legacy', () => {
        const csv = 'supplierSku,productId,variantId,availableQuantity,unitPrice,currency,leadTimeDays\nSSKU1,p1,v1,100,10.5,CZK,3\n';
        const rule = new ImportSupplierOffersRule({ ...ctx, ruleId: 'import-offers-v1' });
        expect(rule.evaluate({ supplierId: 'sup-1', csvContent: csv })).toEqual(legacyAdapter.importSupplierOffers('sup-1', csv));
    });

    it('ImportGoodsReceiptRule matches legacy', () => {
        const csv = 'purchaseOrderId,procurementLineId,receivedQuantity\npo-1,l1,5\n';
        const rule = new ImportGoodsReceiptRule({ ...ctx, ruleId: 'import-receipt-v1' });
        expect(rule.evaluate(csv)).toEqual(legacyAdapter.importGoodsReceipt(csv));
    });

    it('ImportSupplierOffersRule throws matching legacy on invalid CSV', () => {
        const csv = 'supplierSku,productId,variantId,availableQuantity,unitPrice,currency,leadTimeDays\n,p1,v1,100,10.5,CZK,3\n';
        const rule = new ImportSupplierOffersRule({ ...ctx, ruleId: 'import-offers-v1' });
        expect(() => rule.evaluate({ supplierId: 'sup-1', csvContent: csv })).toThrow();
    });
});
