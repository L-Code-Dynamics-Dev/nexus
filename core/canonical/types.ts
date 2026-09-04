// Canonical Model — jediný sdílený jazyk pro všechny domény (master prompt §4).
// Žádná doména nesmí definovat vlastní paralelní verzi těchto entit.
// Peníze vždy jako Decimal (nikdy float) — konvence potvrzená v Pricing Engine i Omega.

import Decimal from 'decimal.js';

export type TenantId = string;
export type EntityId = string;
export type ISODateTime = string;

/** Sdíleno všemi entitami — tenant-scoped, auditovatelné, verzovatelné (§4). */
export interface CanonicalEntity {
    readonly id: EntityId;
    readonly tenantId: TenantId;
    readonly createdAt: ISODateTime;
    readonly updatedAt: ISODateTime;
}

export interface Tenant extends CanonicalEntity {
    name: string;
    /** Platforma primárního e-shopu; core na tuhle hodnotu nesmí nikdy větvit (§15). */
    platform: string;
}

export interface Store extends CanonicalEntity {
    tenantId: TenantId;
    name: string;
    /** DRAFT|CONNECTED|ACTIVE|... — přesná state machine v core/state-machine/. */
    integrationMode: 'api' | 'import';
}

export interface Money {
    amount: Decimal;
    currency: string;
}

export interface Product extends CanonicalEntity {
    sku: string;
    ean?: string;
    name: string;
    manufacturer?: string;
    category?: string;
    /** Skladová/nákupní cena — nikdy vystavená koncovému zákazníkovi. */
    purchasePrice?: Money;
}

export interface ProductGroup extends CanonicalEntity {
    name: string;
    memberProductIds: EntityId[];
}

export interface Variant extends CanonicalEntity {
    productId: EntityId;
    sku: string;
    attributes: Record<string, string>;
}

export interface Category extends CanonicalEntity {
    name: string;
    parentCategoryId?: EntityId;
}

export interface Brand extends CanonicalEntity {
    name: string;
}

export interface Customer extends CanonicalEntity {
    /** Nikdy raw PII v audit/log vrstvě — jen zde, v core domain store. */
    email?: string;
    customerGroupId?: EntityId;
    priceListId?: EntityId;
}

export interface CustomerGroup extends CanonicalEntity {
    name: string;
}

export interface PriceList extends CanonicalEntity {
    name: string;
    /** Nahrazuje hardcoded CustomerTier union type z okfish (viz MIGRATION_PLAN.md Fáze 1). */
    tenantScopedTierKey: string;
}

export interface Price extends CanonicalEntity {
    productId: EntityId;
    priceListId: EntityId;
    value: Money;
}

export interface QuantityTier extends CanonicalEntity {
    priceListId: EntityId;
    minQuantity: number;
    priceMultiplier: Decimal;
}

export interface Promotion extends CanonicalEntity {
    name: string;
    discount: Decimal;
    startsAt: ISODateTime;
    endsAt: ISODateTime;
}

export interface PromoGroup extends CanonicalEntity {
    promotionId: EntityId;
    targetProductIds: EntityId[];
}

export interface Campaign extends CanonicalEntity {
    name: string;
    status: 'DRAFT' | 'SCHEDULED' | 'ACTIVE' | 'ENDING' | 'EXPIRED' | 'ARCHIVED';
    startsAt: ISODateTime;
    endsAt: ISODateTime;
}

export interface CampaignPlacement extends CanonicalEntity {
    campaignId: EntityId;
    placement:
        | 'HOMEPAGE_HERO'
        | 'HOMEPAGE_CAROUSEL'
        | 'CATEGORY_BANNER'
        | 'PRODUCT_CARD'
        | 'PRODUCT_DETAIL'
        | 'LANDING_PAGE'
        | 'NEWSLETTER'
        | 'B2B'
        | 'PRINT';
}

export interface Creative extends CanonicalEntity {
    campaignId: EntityId;
    placementId: EntityId;
    template: string;
}

export interface Order extends CanonicalEntity {
    customerId: EntityId;
    storeId: EntityId;
    status: string;
    total: Money;
}

export interface OrderItem extends CanonicalEntity {
    orderId: EntityId;
    productId: EntityId;
    quantity: number;
    unitPrice: Money;
}

export interface Stock extends CanonicalEntity {
    productId: EntityId;
    warehouseId: EntityId;
    quantity: number;
}

export interface Warehouse extends CanonicalEntity {
    name: string;
}

export interface Supplier extends CanonicalEntity {
    name: string;
}

export interface PurchaseOrder extends CanonicalEntity {
    supplierId: EntityId;
    /** DRAFT|PENDING_APPROVAL|SENT|PARTIALLY_RECEIVED|RECEIVED|CANCELLED — viz AIE audit nesoulad TS/DB, opravit zde. */
    status: string;
}

export interface PurchaseOrderItem extends CanonicalEntity {
    purchaseOrderId: EntityId;
    productId: EntityId;
    quantity: number;
    receivedQuantity: number;
}

export interface Receiving extends CanonicalEntity {
    purchaseOrderId: EntityId;
    receivedAt: ISODateTime;
}

export interface Invoice extends CanonicalEntity {
    orderId?: EntityId;
    total: Money;
    variableSymbol: string;
    dueDate: ISODateTime;
}

export interface InvoiceItem extends CanonicalEntity {
    invoiceId: EntityId;
    description: string;
    total: Money;
}

export interface CreditNote extends CanonicalEntity {
    invoiceId: EntityId;
    total: Money;
}

export interface Payment extends CanonicalEntity {
    invoiceId: EntityId;
    amount: Money;
    paidAt: ISODateTime;
}

export interface Delivery extends CanonicalEntity {
    orderId: EntityId;
    carrierId: EntityId;
    trackingNumber?: string;
}

export interface Carrier extends CanonicalEntity {
    name: string;
}

export interface RiskDecision extends CanonicalEntity {
    orderId: EntityId;
    decision: 'ALLOW' | 'RESTRICT_COD' | 'REQUIRE_PREPAYMENT' | 'REVIEW';
    riskScore: Decimal;
    confidence: Decimal;
}

export interface MarketingCampaign extends CanonicalEntity {
    campaignId: EntityId;
}

export interface ExportRun extends CanonicalEntity {
    definitionId: EntityId;
    status: string;
}

export interface ImportRun extends CanonicalEntity {
    sourceName: string;
    status: string;
}

export interface SyncRun extends CanonicalEntity {
    connectorId: string;
    status: string;
}

export interface Reconciliation extends CanonicalEntity {
    domain: string;
    expected: unknown;
    actual: unknown;
    mismatchCount: number;
}

export interface Outcome extends CanonicalEntity {
    decisionEntityId: EntityId;
    actualResult: unknown;
    deviatedFromPrediction: boolean;
}

export interface AuditRecord extends CanonicalEntity {
    entity: string;
    entityId: EntityId;
    action: string;
    actor: string;
    rulesVersion?: string;
    calculationVersion?: string;
}

export interface ManualOverride extends CanonicalEntity {
    who: string;
    oldValue: unknown;
    newValue: unknown;
    reason: string;
    approvedBy?: string;
}

export interface Rule extends CanonicalEntity {
    domain: string;
    definition: unknown;
}

export interface RuleVersion extends CanonicalEntity {
    ruleId: EntityId;
    version: number;
}

export interface CalculationVersion extends CanonicalEntity {
    domain: string;
    version: number;
}
