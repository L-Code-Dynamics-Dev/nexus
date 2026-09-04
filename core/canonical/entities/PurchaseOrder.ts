// PurchaseOrder -- podle docs/entity-audit/PurchaseOrder.md.
//
// KRITICKÉ: legacy AIE PurchaseOrder.status mísilo TŘI nezávislé osy do
// jednoho sloupce (potvrzeno state matrix v auditu):
//   1. lifecycle       -- DRAFT/PENDING_APPROVAL/SENT/PARTIALLY_RECEIVED/RECEIVED
//   2. cancellationState -- CANCELLED zapisováno, ale chybí v DB CHECK (bug)
//   3. supplierEcho     -- ACCEPTED/SHIPPED (ze SupplierStatusUpdate), psáno
//                          do STEJNÉHO sloupce jako lifecycle (confirmed conflict)
// Tento typ je rozdělí -- Janova hypotéza (C) z auditu, teď implementovaná.
//
// DALŠÍ CONFIRMED GAP: RECEIVED/PARTIALLY_RECEIVED se v legacy kódu počítá
// správně (ProcurementEngine.receive()), ale NIKDY nezapisuje do DB.
// receivedQuantity zde musí být PERZISTOVANÉ pole na PurchaseOrderItem,
// ne jen in-memory výsledek.

import type { CanonicalEntity, EntityId, Money } from './base.js';

export type PurchaseOrderLifecycle =
    | 'DRAFT'
    | 'PENDING_APPROVAL'
    | 'SENT'
    | 'PARTIALLY_RECEIVED'
    | 'RECEIVED';

export type PurchaseOrderCancellationState = 'ACTIVE' | 'CANCELLED';

/** Echo ze SupplierStatusUpdate -- externí, dodavatelův pohled, NE lifecycle. */
export type SupplierEcho = 'PENDING' | 'ACCEPTED' | 'SHIPPED' | 'CANCELLED';

/**
 * PurchaseOrder -- Nexus-owned entita (na rozdíl od Order, žádný externí
 * systém negeneruje PO zpětně, dokud SupplierStatusUpdate feed není
 * implementován -- byl mock/`[]` v legacy kódu).
 */
export interface PurchaseOrder extends CanonicalEntity {
    readonly supplierId: EntityId;

    /** Interní stav, Nexus-owned. Nahrazuje legacy jediný `status` sloupec. */
    lifecycle: PurchaseOrderLifecycle;

    /** Nezávislá osa -- může nastat z JAKÉHOKOLI lifecycle stavu. */
    cancellationState: PurchaseOrderCancellationState;

    /**
     * Nezávislá osa -- dodavatelův echo. TBD zda je vůbec potřeba
     * na PurchaseOrder samotném, nebo patří na samostatnou entitu
     * vázanou 1:1 (dokud SupplierStatusUpdate feed neexistuje, je to
     * prázdné/PENDING).
     */
    supplierEcho: SupplierEcho;

    items: PurchaseOrderItem[];
}

export interface PurchaseOrderItem extends CanonicalEntity {
    readonly purchaseOrderId: EntityId;
    readonly productId: EntityId;
    quantity: number;

    /**
     * CONFIRMED GAP FIX: legacy `ProcurementEngine.receive()` počítal
     * tuto hodnotu správně, ale nikdy ji nezapsal zpět do DB (in-memory
     * only mutation). Zde je to POVINNÉ perzistované pole -- write path
     * do repository je architektonický požadavek, ne volitelný krok.
     */
    receivedQuantity: number;

    unitPrice: Money;
}

/**
 * Invariant potvrzený v legacy kódu (ProcurementEngine.receive()):
 * receivedQuantity nikdy nepřekročí min(quantity, quantity - receivedQuantity + delta).
 * Zapsáno explicitně jako kontrakt, ne jen implicitně v implementaci.
 */
export function assertReceivingInvariant(item: PurchaseOrderItem, delta: number): void {
    if (item.receivedQuantity + delta > item.quantity) {
        throw new Error(
            `Over-receiving violation: ${item.receivedQuantity} + ${delta} > ${item.quantity} for item ${item.id}`
        );
    }
}
