export enum AvailabilityStatus {
    IN_STOCK = 'IN_STOCK',
    LOW_STOCK = 'LOW_STOCK',
    PARTIALLY_AVAILABLE = 'PARTIALLY_AVAILABLE',
    IN_TRANSIT = 'IN_TRANSIT',
    ON_ORDER = 'ON_ORDER',
    OUT_OF_STOCK = 'OUT_OF_STOCK',
    UNKNOWN = 'UNKNOWN'
}

export const AvailabilityScore: Record<AvailabilityStatus, number> = {
    [AvailabilityStatus.IN_STOCK]: 100,
    [AvailabilityStatus.LOW_STOCK]: 90,
    [AvailabilityStatus.PARTIALLY_AVAILABLE]: 75,
    [AvailabilityStatus.IN_TRANSIT]: 60,
    [AvailabilityStatus.ON_ORDER]: 40,
    [AvailabilityStatus.OUT_OF_STOCK]: 0,
    [AvailabilityStatus.UNKNOWN]: -1
};

export interface VariantAvailability {
    id: string;
    isPurchasable: boolean;
    inStock: boolean;
    stockAmount?: number | undefined;
    onOrder?: boolean | undefined;
    inTransit?: boolean | undefined;
}

export interface ProductAvailabilityInput {
    id: string;
    variants: VariantAvailability[];
    baseSortPriority?: number; // Secondary business sorting
    relevanceScore?: number;   // Tertiary deterministic tie-breaker
    sku?: string | undefined;
    source?: 'MERCHANT' | 'SUPPLIER' | 'NETWORK';
    timestamp?: string | undefined;
}

export interface AvailabilityResult {
    productId: string;
    sku?: string | undefined;
    status: AvailabilityStatus;
    score: number;
    source: 'MERCHANT' | 'SUPPLIER' | 'NETWORK' | 'SYSTEM';
    timestamp: string;
    reason: string;
    
    // Original business inputs for the sorting pipeline
    baseSortPriority: number;
    relevanceScore: number;
}
