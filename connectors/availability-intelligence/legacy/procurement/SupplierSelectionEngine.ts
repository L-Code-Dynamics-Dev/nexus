import type { CustomerOrderLine, ProcurementLine, ProcurementPolicy, SupplierOffer, UnfulfilledDemand } from './types.js';

export interface SelectionResult {
    lines?: ProcurementLine[];
    line?: ProcurementLine; // backward compatibility
    unfulfilled?: UnfulfilledDemand;
}

/**
 * Chooses exact product + variant matches. If a single supplier cannot cover the entire deficit,
 * splits procurement across multiple candidates according to policy ranking and available capacities.
 * Consumes supplier capacity so suppliers cannot be overbooked across customer orders in the same run.
 */
export class SupplierSelectionEngine {
    public static select(
        demand: CustomerOrderLine,
        offers: SupplierOffer[],
        policy: ProcurementPolicy,
        reservedByOffer: Map<string, number>,
    ): SelectionResult {
        const totalNeeded = Math.max(0, demand.quantity - demand.ownStockQuantity);
        if (totalNeeded === 0) return {};

        const candidates = offers
            .filter((offer) => offer.active && offer.productId === demand.productId && offer.variantId === demand.variantId)
            .map((offer) => ({
                offer,
                remaining: Math.max(0, offer.availableQuantity - (reservedByOffer.get(this.offerKey(offer)) ?? 0)),
            }))
            .filter(({ remaining }) => remaining > 0)
            .sort((a, b) => this.compare(a.offer, b.offer, policy));

        // 1. Check if there's a single supplier that can fulfill the entire deficit (preferred for single PO)
        const singleFullCover = candidates.find(({ remaining }) => remaining >= totalNeeded);
        if (singleFullCover) {
            const selected = singleFullCover.offer;
            reservedByOffer.set(this.offerKey(selected), (reservedByOffer.get(this.offerKey(selected)) ?? 0) + totalNeeded);
            const line: ProcurementLine = {
                id: `proc-${demand.id}`,
                supplierId: selected.supplierId,
                customerOrderLineId: demand.id,
                productId: demand.productId,
                variantId: demand.variantId,
                sku: demand.sku,
                supplierSku: selected.supplierSku,
                quantity: totalNeeded,
                receivedQuantity: 0,
                unitPrice: selected.unitPrice,
                currency: selected.currency,
                expectedLeadTimeDays: selected.leadTimeDays,
            };
            return { line, lines: [line] };
        }

        // 2. Multi-supplier split: fulfill as much as possible across ranked candidates
        let remainingNeeded = totalNeeded;
        const allocatedLines: ProcurementLine[] = [];
        let splitIndex = 1;

        for (const candidate of candidates) {
            if (remainingNeeded <= 0) break;
            const take = Math.min(remainingNeeded, candidate.remaining);
            if (take <= 0) continue;

            reservedByOffer.set(
                this.offerKey(candidate.offer),
                (reservedByOffer.get(this.offerKey(candidate.offer)) ?? 0) + take,
            );

            allocatedLines.push({
                id: `proc-${demand.id}-${splitIndex++}`,
                supplierId: candidate.offer.supplierId,
                customerOrderLineId: demand.id,
                productId: demand.productId,
                variantId: demand.variantId,
                sku: demand.sku,
                supplierSku: candidate.offer.supplierSku,
                quantity: take,
                receivedQuantity: 0,
                unitPrice: candidate.offer.unitPrice,
                currency: candidate.offer.currency,
                expectedLeadTimeDays: candidate.offer.leadTimeDays,
            });

            remainingNeeded -= take;
        }

        // If something remains unfulfilled
        let unfulfilled: UnfulfilledDemand | undefined;
        if (remainingNeeded > 0) {
            const hasVariantOffer = offers.some(
                (offer) => offer.active && offer.productId === demand.productId && offer.variantId === demand.variantId,
            );
            unfulfilled = {
                customerOrderLineId: demand.id,
                productId: demand.productId,
                variantId: demand.variantId,
                sku: demand.sku,
                quantity: remainingNeeded,
                reason: hasVariantOffer ? 'INSUFFICIENT_SUPPLIER_STOCK' : 'NO_SUPPLIER_OFFER',
            };
        }

        const res: SelectionResult = {};
        if (allocatedLines.length > 0) res.lines = allocatedLines;
        if (allocatedLines.length === 1 && allocatedLines[0]) res.line = allocatedLines[0];
        if (unfulfilled) res.unfulfilled = unfulfilled;
        return res;
    }

    private static compare(a: SupplierOffer, b: SupplierOffer, policy: ProcurementPolicy): number {
        const speedWeight = policy.speedWeight ?? 0;
        const priorityWeight = policy.supplierPriorityWeight ?? 0;
        const aScore = a.unitPrice + a.leadTimeDays * speedWeight - (a.supplierPriority ?? 0) * priorityWeight;
        const bScore = b.unitPrice + b.leadTimeDays * speedWeight - (b.supplierPriority ?? 0) * priorityWeight;
        return aScore - bScore || a.supplierId.localeCompare(b.supplierId) || a.supplierSku.localeCompare(b.supplierSku);
    }

    private static offerKey(offer: SupplierOffer): string {
        return `${offer.supplierId}:${offer.supplierSku}`;
    }
}
