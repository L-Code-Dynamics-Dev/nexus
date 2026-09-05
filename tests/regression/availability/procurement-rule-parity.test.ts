// Parity testy: Nexus ProcurementPlanRule/ProcurementReceiveRule/
// SupplierSelectionRule vs skutecne legacy ProcurementEngine/
// SupplierSelectionEngine (connectors/availability-intelligence/legacy/
// procurement/). Zadna re-implementace byznys logiky -- kazdy test
// vola OBOJI (legacy primo + Nexus Rule) a porovnava vysledek.

import { describe, it, expect } from 'vitest';
import { ProcurementEngine } from '../../../connectors/availability-intelligence/legacy/procurement/ProcurementEngine.js';
import { SupplierSelectionEngine } from '../../../connectors/availability-intelligence/legacy/procurement/SupplierSelectionEngine.js';
import type { CustomerOrderLine, GoodsReceiptLine, ProcurementPolicy, PurchaseOrder, SupplierOffer } from '../../../connectors/availability-intelligence/legacy/procurement/types.js';
import { ProcurementPlanRule, ProcurementReceiveRule } from '../../../domains/procurement/ProcurementRule.js';
import { SupplierSelectionRule } from '../../../domains/procurement/SupplierSelectionRule.js';

const RULE_CONTEXT = { tenantId: 'ten_1', ruleId: 'procurement-v1', ruleVersion: '1' };

function makeDemand(overrides: Partial<CustomerOrderLine> = {}): CustomerOrderLine {
    return {
        id: 'line-1',
        orderId: 'order-1',
        productId: 'prod-1',
        variantId: 'var-1',
        sku: 'SKU-1',
        quantity: 10,
        ownStockQuantity: 0,
        createdAt: '2026-01-01T00:00:00Z',
        ...overrides,
    };
}

function makeOffer(overrides: Partial<SupplierOffer> = {}): SupplierOffer {
    return {
        supplierId: 'sup-1',
        supplierSku: 'SSKU-1',
        productId: 'prod-1',
        variantId: 'var-1',
        availableQuantity: 100,
        unitPrice: 10,
        currency: 'CZK',
        leadTimeDays: 3,
        active: true,
        ...overrides,
    };
}

const AUTO_POLICY: ProcurementPolicy = { approvalMode: 'automatic' };

describe('SupplierSelectionRule parity vs SupplierSelectionEngine.select()', () => {
    it('exact product+variant match, single supplier fully covers demand', () => {
        const demand = makeDemand({ quantity: 10, ownStockQuantity: 0 });
        const offers = [makeOffer({ availableQuantity: 50 })];

        const legacyReserved = new Map<string, number>();
        const legacy = SupplierSelectionEngine.select(demand, offers, AUTO_POLICY, legacyReserved);

        const nexusReserved = new Map<string, number>();
        const rule = new SupplierSelectionRule(RULE_CONTEXT);
        const nexus = rule.evaluate({ demand, offers, policy: AUTO_POLICY, reservedByOffer: nexusReserved });

        expect(nexus).toEqual(legacy);
        expect(nexusReserved).toEqual(legacyReserved);
    });

    it('offer with mismatched variantId is not a candidate -> unfulfilled NO_SUPPLIER_OFFER', () => {
        const demand = makeDemand({ variantId: 'var-1' });
        const offers = [makeOffer({ variantId: 'var-2' })];

        const legacy = SupplierSelectionEngine.select(demand, offers, AUTO_POLICY, new Map());
        const nexus = new SupplierSelectionRule(RULE_CONTEXT).evaluate({ demand, offers, policy: AUTO_POLICY, reservedByOffer: new Map() });

        expect(nexus).toEqual(legacy);
        expect(nexus.unfulfilled?.reason).toBe('NO_SUPPLIER_OFFER');
    });

    it('multi-supplier split when no single offer covers the full deficit', () => {
        const demand = makeDemand({ quantity: 30, ownStockQuantity: 0 });
        const offers = [
            makeOffer({ supplierId: 'sup-A', supplierSku: 'A1', availableQuantity: 10, unitPrice: 5 }),
            makeOffer({ supplierId: 'sup-B', supplierSku: 'B1', availableQuantity: 10, unitPrice: 6 }),
            makeOffer({ supplierId: 'sup-C', supplierSku: 'C1', availableQuantity: 10, unitPrice: 7 }),
        ];

        const legacy = SupplierSelectionEngine.select(demand, offers, AUTO_POLICY, new Map());
        const nexus = new SupplierSelectionRule(RULE_CONTEXT).evaluate({ demand, offers, policy: AUTO_POLICY, reservedByOffer: new Map() });

        expect(nexus).toEqual(legacy);
        expect(nexus.lines).toHaveLength(3);
    });

    it('insufficient supplier stock across all candidates -> partial fulfilment + unfulfilled remainder', () => {
        const demand = makeDemand({ quantity: 100, ownStockQuantity: 0 });
        const offers = [makeOffer({ availableQuantity: 40 })];

        const legacy = SupplierSelectionEngine.select(demand, offers, AUTO_POLICY, new Map());
        const nexus = new SupplierSelectionRule(RULE_CONTEXT).evaluate({ demand, offers, policy: AUTO_POLICY, reservedByOffer: new Map() });

        expect(nexus).toEqual(legacy);
        expect(nexus.unfulfilled?.reason).toBe('INSUFFICIENT_SUPPLIER_STOCK');
        expect(nexus.unfulfilled?.quantity).toBe(60);
    });

    it('capacity reservation carries across two sequential calls sharing the same Map -- second call cannot overbook', () => {
        const offers = [makeOffer({ availableQuantity: 15 })];
        const reserved = new Map<string, number>();
        const policyResult1 = new SupplierSelectionRule(RULE_CONTEXT).evaluate({
            demand: makeDemand({ id: 'line-A', quantity: 10 }),
            offers,
            policy: AUTO_POLICY,
            reservedByOffer: reserved,
        });
        const policyResult2 = new SupplierSelectionRule(RULE_CONTEXT).evaluate({
            demand: makeDemand({ id: 'line-B', quantity: 10 }),
            offers,
            policy: AUTO_POLICY,
            reservedByOffer: reserved,
        });

        expect(policyResult1.line?.quantity).toBe(10);
        // Only 5 remaining capacity after first reservation -- second call must be partial/unfulfilled, not overbooked.
        expect(policyResult2.lines?.reduce((sum, l) => sum + l.quantity, 0) ?? 0).toBe(5);
        expect(policyResult2.unfulfilled?.quantity).toBe(5);
    });

    it('policy speedWeight/supplierPriorityWeight changes candidate ranking, matches legacy compare()', () => {
        const demand = makeDemand({ quantity: 5 });
        const offers = [
            makeOffer({ supplierId: 'sup-cheap-slow', supplierSku: 'CS', unitPrice: 5, leadTimeDays: 10, availableQuantity: 5 }),
            makeOffer({ supplierId: 'sup-expensive-fast', supplierSku: 'EF', unitPrice: 8, leadTimeDays: 1, availableQuantity: 5 }),
        ];
        const speedFocusedPolicy: ProcurementPolicy = { approvalMode: 'automatic', speedWeight: 2 };

        const legacy = SupplierSelectionEngine.select(demand, offers, speedFocusedPolicy, new Map());
        const nexus = new SupplierSelectionRule(RULE_CONTEXT).evaluate({ demand, offers, policy: speedFocusedPolicy, reservedByOffer: new Map() });

        expect(nexus).toEqual(legacy);
    });
});

describe('ProcurementPlanRule parity vs ProcurementEngine.plan()', () => {
    it('single demand, single supplier fully covers -> one DRAFT purchase order', () => {
        const demands = [makeDemand()];
        const offers = [makeOffer({ availableQuantity: 50 })];

        const legacy = ProcurementEngine.plan(demands, offers, AUTO_POLICY, 'evt-1');
        const nexus = new ProcurementPlanRule(RULE_CONTEXT).evaluate({ demands, offers, policy: AUTO_POLICY, eventId: 'evt-1' });

        expect(nexus).toEqual(legacy);
        expect(nexus.purchaseOrders).toHaveLength(1);
        expect(nexus.purchaseOrders[0]?.status).toBe('DRAFT');
    });

    it('manual approval mode -> PENDING_APPROVAL status, matches legacy', () => {
        const demands = [makeDemand()];
        const offers = [makeOffer({ availableQuantity: 50 })];
        const manualPolicy: ProcurementPolicy = { approvalMode: 'manual' };

        const legacy = ProcurementEngine.plan(demands, offers, manualPolicy, 'evt-2');
        const nexus = new ProcurementPlanRule(RULE_CONTEXT).evaluate({ demands, offers, policy: manualPolicy, eventId: 'evt-2' });

        expect(nexus).toEqual(legacy);
        expect(nexus.purchaseOrders[0]?.status).toBe('PENDING_APPROVAL');
    });

    it('higher-priority demand is processed first, affecting which supplier capacity it consumes', () => {
        const lowPriority = makeDemand({ id: 'line-low', priority: 1, createdAt: '2026-01-01T00:00:00Z', quantity: 10 });
        const highPriority = makeDemand({ id: 'line-high', priority: 5, createdAt: '2026-01-02T00:00:00Z', quantity: 10 });
        const offers = [makeOffer({ availableQuantity: 15 })];

        const legacy = ProcurementEngine.plan([lowPriority, highPriority], offers, AUTO_POLICY, 'evt-3');
        const nexus = new ProcurementPlanRule(RULE_CONTEXT).evaluate({ demands: [lowPriority, highPriority], offers, policy: AUTO_POLICY, eventId: 'evt-3' });

        expect(nexus).toEqual(legacy);
        // High priority demand processed first -> should get its full 10, low priority gets remaining 5 + unfulfilled 5.
        expect(nexus.unfulfilled.find((u) => u.customerOrderLineId === 'line-low')?.quantity).toBe(5);
    });

    it('no supplier offer at all -> demand fully unfulfilled, empty purchase order list', () => {
        const demands = [makeDemand({ productId: 'prod-nonexistent' })];
        const offers = [makeOffer({ productId: 'prod-1' })];

        const legacy = ProcurementEngine.plan(demands, offers, AUTO_POLICY, 'evt-4');
        const nexus = new ProcurementPlanRule(RULE_CONTEXT).evaluate({ demands, offers, policy: AUTO_POLICY, eventId: 'evt-4' });

        expect(nexus).toEqual(legacy);
        expect(nexus.purchaseOrders).toHaveLength(0);
        expect(nexus.unfulfilled).toHaveLength(1);
    });
});

describe('ProcurementReceiveRule parity vs ProcurementEngine.receive()', () => {
    function makePurchaseOrder(): PurchaseOrder {
        return {
            id: 'po-1',
            supplierId: 'sup-1',
            status: 'SENT',
            lines: [
                { id: 'pline-1', supplierId: 'sup-1', customerOrderLineId: 'line-1', productId: 'prod-1', variantId: 'var-1', sku: 'SKU-1', supplierSku: 'SSKU-1', quantity: 10, receivedQuantity: 0, unitPrice: 10, currency: 'CZK', expectedLeadTimeDays: 3 },
            ],
        };
    }

    it('valid full receipt -> RECEIVED status, matches legacy', () => {
        const legacyOrders = [makePurchaseOrder()];
        const nexusOrders = [makePurchaseOrder()];
        const receipt: GoodsReceiptLine[] = [{ purchaseOrderId: 'po-1', procurementLineId: 'pline-1', receivedQuantity: 10 }];

        const legacyAllocations = ProcurementEngine.receive(legacyOrders, receipt);
        const nexusAllocations = new ProcurementReceiveRule(RULE_CONTEXT).evaluate({ purchaseOrders: nexusOrders, receipt });

        expect(nexusAllocations).toEqual(legacyAllocations);
        expect(nexusOrders[0]?.status).toBe(legacyOrders[0]?.status);
        expect(nexusOrders[0]?.status).toBe('RECEIVED');
    });

    it('partial receipt -> PARTIALLY_RECEIVED status, matches legacy', () => {
        const legacyOrders = [makePurchaseOrder()];
        const nexusOrders = [makePurchaseOrder()];
        const receipt: GoodsReceiptLine[] = [{ purchaseOrderId: 'po-1', procurementLineId: 'pline-1', receivedQuantity: 4 }];

        const legacyAllocations = ProcurementEngine.receive(legacyOrders, receipt);
        const nexusAllocations = new ProcurementReceiveRule(RULE_CONTEXT).evaluate({ purchaseOrders: nexusOrders, receipt });

        expect(nexusAllocations).toEqual(legacyAllocations);
        expect(nexusOrders[0]?.status).toBe('PARTIALLY_RECEIVED');
    });

    it('non-integer receivedQuantity throws, matches legacy throw', () => {
        const receipt: GoodsReceiptLine[] = [{ purchaseOrderId: 'po-1', procurementLineId: 'pline-1', receivedQuantity: 4.5 }];
        expect(() => ProcurementEngine.receive([makePurchaseOrder()], receipt)).toThrow('receivedQuantity must be a positive integer');
        expect(() => new ProcurementReceiveRule(RULE_CONTEXT).evaluate({ purchaseOrders: [makePurchaseOrder()], receipt })).toThrow('receivedQuantity must be a positive integer');
    });

    it('negative receivedQuantity throws, matches legacy throw', () => {
        const receipt: GoodsReceiptLine[] = [{ purchaseOrderId: 'po-1', procurementLineId: 'pline-1', receivedQuantity: -1 }];
        expect(() => ProcurementEngine.receive([makePurchaseOrder()], receipt)).toThrow('receivedQuantity must be a positive integer');
        expect(() => new ProcurementReceiveRule(RULE_CONTEXT).evaluate({ purchaseOrders: [makePurchaseOrder()], receipt })).toThrow('receivedQuantity must be a positive integer');
    });

    it('unknown purchaseOrderId throws, matches legacy throw', () => {
        const receipt: GoodsReceiptLine[] = [{ purchaseOrderId: 'po-unknown', procurementLineId: 'pline-1', receivedQuantity: 1 }];
        expect(() => ProcurementEngine.receive([makePurchaseOrder()], receipt)).toThrow(/Unknown purchase order line/);
        expect(() => new ProcurementReceiveRule(RULE_CONTEXT).evaluate({ purchaseOrders: [makePurchaseOrder()], receipt })).toThrow(/Unknown purchase order line/);
    });

    it('unknown procurementLineId throws, matches legacy throw', () => {
        const receipt: GoodsReceiptLine[] = [{ purchaseOrderId: 'po-1', procurementLineId: 'pline-unknown', receivedQuantity: 1 }];
        expect(() => ProcurementEngine.receive([makePurchaseOrder()], receipt)).toThrow(/Unknown purchase order line/);
        expect(() => new ProcurementReceiveRule(RULE_CONTEXT).evaluate({ purchaseOrders: [makePurchaseOrder()], receipt })).toThrow(/Unknown purchase order line/);
    });

    it('never allocates more than received or ordered (over-receipt is clamped to remaining order quantity)', () => {
        const legacyOrders = [makePurchaseOrder()];
        const nexusOrders = [makePurchaseOrder()];
        // Receiving 20 units against an order of 10 -- must clamp allocation to 10, not 20.
        const receipt: GoodsReceiptLine[] = [{ purchaseOrderId: 'po-1', procurementLineId: 'pline-1', receivedQuantity: 20 }];

        const legacyAllocations = ProcurementEngine.receive(legacyOrders, receipt);
        const nexusAllocations = new ProcurementReceiveRule(RULE_CONTEXT).evaluate({ purchaseOrders: nexusOrders, receipt });

        expect(nexusAllocations).toEqual(legacyAllocations);
        expect(nexusAllocations[0]?.allocatedQuantity).toBe(10);
    });
});
