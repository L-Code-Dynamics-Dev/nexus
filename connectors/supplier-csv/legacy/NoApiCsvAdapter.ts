import type { PurchaseOrder, SupplierOffer, GoodsReceiptLine } from '../../availability-intelligence/legacy/procurement/types.js';

/**
 * Resolves the "NO-API procurement workflow" blocker.
 * Instead of manual copy-pasting SKU/quantity into a supplier's portal,
 * this adapter generates automated CSV exports and parses CSV imports.
 */
export class NoApiCsvAdapter {
    /**
     * Generates a CSV for a PurchaseOrder to be uploaded to the supplier's B2B portal.
     * Keeps the format simple: supplierSku, quantity
     */
    public exportPurchaseOrder(order: PurchaseOrder): string {
        const header = 'supplierSku,quantity';
        const rows = order.lines.map((line) => `${line.supplierSku},${line.quantity}`);
        return [header, ...rows].join('\n');
    }

    /**
     * Parses a generic CSV feed of supplier offers.
     * Expected format: supplierSku,productId,variantId,availableQuantity,unitPrice,currency,leadTimeDays
     */
    public importSupplierOffers(supplierId: string, csvContent: string): SupplierOffer[] {
        const lines = csvContent.trim().split('\n');
        if (lines.length < 2) return [];

        return lines.slice(1).map((line) => {
            const [supplierSku, productId, variantId, availableQuantity, unitPrice, currency, leadTimeDays] = line.split(',');
            if (!supplierSku || !productId || !variantId || !currency) {
                throw new Error('Invalid CSV format: Missing required string fields');
            }
            return {
                supplierId,
                supplierSku: supplierSku.trim(),
                productId: productId.trim(),
                variantId: variantId.trim(),
                availableQuantity: Number(availableQuantity),
                unitPrice: Number(unitPrice),
                currency: currency.trim(),
                leadTimeDays: Number(leadTimeDays),
                active: true
            };
        });
    }

    /**
     * Parses a generic CSV receipt from a supplier.
     * Expected format: purchaseOrderId,procurementLineId,receivedQuantity
     */
    public importGoodsReceipt(csvContent: string): GoodsReceiptLine[] {
        const lines = csvContent.trim().split('\n');
        if (lines.length < 2) return [];

        return lines.slice(1).map((line) => {
            const [purchaseOrderId, procurementLineId, receivedQuantity] = line.split(',');
            if (!purchaseOrderId || !procurementLineId) {
                throw new Error('Invalid CSV format: Missing required fields in goods receipt');
            }
            return {
                purchaseOrderId: purchaseOrderId.trim(),
                procurementLineId: procurementLineId.trim(),
                receivedQuantity: Number(receivedQuantity)
            };
        });
    }
}

// NoApiCsvSupplierClient (I/O port implementace, závislá na BlobStoragePort/
// SupplierFeedAdapter z AIE platform vrstvy) ZÁMĚRNĚ NEPŘENESENO -- to je
// Connector Layer / platform kód s async I/O, ne čistá parsing logika.
// Až přijde na řadu skutečné napojení na storage (Fáze 4 pokračování),
// staví se nově proti Nexus connectors/ kontraktům, ne kopíruje AIE port.
