import type { PurchaseOrder, SupplierStatusUpdate } from './types.js';

export interface CommercePlatformPort {
    fetchUnfulfilledOrderLines(): Promise<any[]>;
}

export interface SupplierCatalogPort {
    fetchOffers(): Promise<any[]>;
}

export interface PurchaseOrderPort {
    savePlan(tenantId: string, plan: any): Promise<void>;
    markAsSent(orderId: string): Promise<void>;
    recordReceipt(receipt: any[]): Promise<void>;
    getOrdersByIds(tenantId: string, orderIds: string[]): Promise<PurchaseOrder[]>;
    cancel(tenantId: string, orderId: string): Promise<void>;
    approve(tenantId: string, orderId: string): Promise<void>;
    updateStatus(tenantId: string, orderId: string, status: 'ACCEPTED' | 'SHIPPED' | 'CANCELLED'): Promise<void>;
    updateLineQuantity?(tenantId: string, lineId: string, newQuantity: number): Promise<void>;
    overrideSupplier?(tenantId: string, orderId: string, newSupplierId: string): Promise<void>;
}

export interface SupplierDispatchPort {
    dispatchPurchaseOrder(order: PurchaseOrder): Promise<{ externalId: string }>;
    fetchStatusUpdates(): Promise<SupplierStatusUpdate[]>;
}

export interface FulfillmentReadinessPort {
    markReadyToShip(allocations: any[]): Promise<void>;
    reallocate?(tenantId: string, customerOrderLineId: string, newQuantity: number): Promise<void>;
}

export interface IdempotencyPort {
    claim(key: string, operation: string): Promise<boolean>;
    complete(key: string, operation: string): Promise<void>;
    fail(key: string, operation: string): Promise<void>;
}

export interface AuditPort {
    append(entry: { tenantId: string; type: string; entityId: string; payload: any; occurredAt: string }): Promise<void>;
}

export interface LoggerPort {
    info(message: string, context?: any): void;
    warn(message: string, context?: any): void;
    error(message: string, context?: any): void;
}
