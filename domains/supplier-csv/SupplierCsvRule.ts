// SupplierCsvRule -- migrace legacy NoApiCsvAdapter (connectors/
// supplier-csv/legacy/NoApiCsvAdapter.ts) pod Nexus Rule contract.
// Fáze 4 (docs/MIGRATION_PLAN.md).
//
// Tři samostatné Rules, 1:1 s legacy metodami -- žádné I/O, čistě
// string/array transformace:
//   ExportPurchaseOrderRule: PurchaseOrder -> CSV string (supplierSku,quantity)
//   ImportSupplierOffersRule: CSV string -> SupplierOffer[], throw na
//     chybějící required string fields
//   ImportGoodsReceiptRule: CSV string -> GoodsReceiptLine[], throw na
//     chybějící required fields

import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import { NoApiCsvAdapter } from '../../connectors/supplier-csv/legacy/NoApiCsvAdapter.js';
import type { PurchaseOrder, SupplierOffer, GoodsReceiptLine } from '../../connectors/availability-intelligence/legacy/procurement/types.js';

const adapter = new NoApiCsvAdapter();

export class ExportPurchaseOrderRule implements Rule<PurchaseOrder, string> {
    constructor(public readonly context: RuleContext) {}

    evaluate(order: PurchaseOrder): string {
        return adapter.exportPurchaseOrder(order);
    }
}

export interface ImportSupplierOffersRuleInput {
    readonly supplierId: string;
    readonly csvContent: string;
}

export class ImportSupplierOffersRule implements Rule<ImportSupplierOffersRuleInput, SupplierOffer[]> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: ImportSupplierOffersRuleInput): SupplierOffer[] {
        return adapter.importSupplierOffers(input.supplierId, input.csvContent);
    }
}

export class ImportGoodsReceiptRule implements Rule<string, GoodsReceiptLine[]> {
    constructor(public readonly context: RuleContext) {}

    evaluate(csvContent: string): GoodsReceiptLine[] {
        return adapter.importGoodsReceipt(csvContent);
    }
}
