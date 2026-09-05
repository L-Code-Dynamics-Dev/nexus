// ProcurementPlanRule / ProcurementReceiveRule -- migrace legacy
// ProcurementEngine (connectors/availability-intelligence/legacy/
// procurement/ProcurementEngine.ts) pod Nexus Rule contract.
//
// Zachovano 1:1 vcetne netrivialnich detailu:
//   plan(): demands se tridi priority DESC, pak createdAt ASC, pak id ASC
//     (deterministicke poradi zpracovani -- vyssi priorita jde prvni,
//     tie-break je FIFO podle vzniku, pak stabilni podle id). Purchase
//     order status = DRAFT pri automatic approval mode, jinak
//     PENDING_APPROVAL. Order id je `po-${supplierId}-${eventId}` --
//     jeden PO per supplier per planning event, radky se do nej sbiraji.
//   receive(): baseline validace (receivedQuantity musi byt kladne cele
//     cislo, jinak throw), pak throw na neznamou objednavku/radku. NIKDY
//     nealokuje vic nez bylo prijato NEBO objednano (Math.min).
//     Order.status = RECEIVED jen kdyz VSECHNY radky maji
//     receivedQuantity === quantity, jinak PARTIALLY_RECEIVED -- i po
//     castecnem prijmu jedne radky se prepocitava cely order status.
//
// ProcurementPlanRule interne vytvari cerstvou `reservedByOffer` Map pro
// kazde volani evaluate() a preda ji SupplierSelectionRule pro kazdy
// demand v ramci stejneho planovaciho behu -- viz SupplierSelectionRule.ts
// komentar o sdilenem stavu v ramci jednoho batch behu.

import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import { ProcurementEngine } from '../../connectors/availability-intelligence/legacy/procurement/ProcurementEngine.js';
import type { Allocation, CustomerOrderLine, GoodsReceiptLine, ProcurementPlan, ProcurementPolicy, PurchaseOrder, SupplierOffer } from '../../connectors/availability-intelligence/legacy/procurement/types.js';

export interface ProcurementPlanRuleInput {
    readonly demands: CustomerOrderLine[];
    readonly offers: SupplierOffer[];
    readonly policy: ProcurementPolicy;
    readonly eventId: string;
}

export class ProcurementPlanRule implements Rule<ProcurementPlanRuleInput, ProcurementPlan> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: ProcurementPlanRuleInput): ProcurementPlan {
        return ProcurementEngine.plan(input.demands, input.offers, input.policy, input.eventId);
    }
}

export interface ProcurementReceiveRuleInput {
    readonly purchaseOrders: PurchaseOrder[];
    readonly receipt: GoodsReceiptLine[];
}

export class ProcurementReceiveRule implements Rule<ProcurementReceiveRuleInput, Allocation[]> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: ProcurementReceiveRuleInput): Allocation[] {
        return ProcurementEngine.receive(input.purchaseOrders, input.receipt);
    }
}
