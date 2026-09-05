import { SupplierSelectionEngine } from './SupplierSelectionEngine.js';
import type { Allocation, CustomerOrderLine, GoodsReceiptLine, ProcurementPlan, ProcurementPolicy, PurchaseOrder, SupplierOffer } from './types.js';

export class ProcurementEngine {
    public static plan(demands: CustomerOrderLine[], offers: SupplierOffer[], policy: ProcurementPolicy, eventId: string): ProcurementPlan {
        const reserved = new Map<string, number>();
        const bySupplier = new Map<string, PurchaseOrder>();
        const unfulfilled: ProcurementPlan['unfulfilled'] = [];

        for (const demand of [...demands].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
            const result = SupplierSelectionEngine.select(demand, offers, policy, reserved);
            if (result.unfulfilled) unfulfilled.push(result.unfulfilled);
            const lines = result.lines ?? (result.line ? [result.line] : []);
            for (const line of lines) {
                const supplierId = line.supplierId;
                const order = bySupplier.get(supplierId) ?? {
                    id: `po-${supplierId}-${eventId}`,
                    supplierId,
                    status: policy.approvalMode === 'automatic' ? 'DRAFT' : 'PENDING_APPROVAL',
                    lines: [],
                };
                order.lines.push(line);
                bySupplier.set(supplierId, order);
            }
        }
        return { purchaseOrders: [...bySupplier.values()], unfulfilled };
    }

    /** Allocates received units to the original customer lines; never allocates more than received or ordered. */
    public static receive(purchaseOrders: PurchaseOrder[], receipt: GoodsReceiptLine[]): Allocation[] {
        const allocations: Allocation[] = [];
        for (const received of receipt) {
            if (!Number.isInteger(received.receivedQuantity) || received.receivedQuantity <= 0) throw new Error('receivedQuantity must be a positive integer');
            const order = purchaseOrders.find((po) => po.id === received.purchaseOrderId);
            const line = order?.lines.find((candidate) => candidate.id === received.procurementLineId);
            if (!order || !line) throw new Error(`Unknown purchase order line ${received.procurementLineId}`);
            const allocatable = Math.min(received.receivedQuantity, line.quantity - line.receivedQuantity);
            line.receivedQuantity += allocatable;
            if (allocatable > 0) allocations.push({ customerOrderLineId: line.customerOrderLineId, allocatedQuantity: allocatable, fulfilled: line.receivedQuantity === line.quantity });
            order.status = order.lines.every((candidate) => candidate.receivedQuantity === candidate.quantity)
                ? 'RECEIVED'
                : 'PARTIALLY_RECEIVED';
        }
        return allocations;
    }
}
