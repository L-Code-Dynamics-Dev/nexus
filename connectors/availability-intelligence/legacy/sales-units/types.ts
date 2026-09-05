// Precision-safe integer arithmetic only.
// weightPerBaseUnitGrams: weight in grams per 1 base unit (integer, grams avoid float issues)

export type BaseUnit = string; // e.g. 'PCS', 'KG', 'L'

export interface SalesUnit {
    id: string;
    productId: string;
    name: string;         // e.g. "Pytel"
    code: string;         // e.g. "BAG" | "PALLET" | "CONTAINER"
    baseQuantity: number; // integer: how many base units = 1 of this sales unit
    baseUnit: BaseUnit;
    weightPerBaseUnitGrams: number; // integer grams per base unit, 0 if not applicable
    priceMultiplier: number;        // multiplier on top of base unit price
    minimumQuantity: number;        // integer
    orderStep: number;              // integer
    active: boolean;
}

export interface SalesUnitPricing {
    unitPriceExVat: number;   // price for 1 sales unit, excl VAT
    unitPriceIncVat: number;  // price for 1 sales unit, incl VAT
    pricePerBaseUnit: number; // unitPriceExVat / baseQuantity
    currency: string;
}

export interface ConversionResult {
    salesUnitCode: string;
    salesUnitQuantity: number;   // how many sales units ordered
    baseQuantity: number;        // canonical stock units
    totalWeightGrams: number;    // integer grams
}

export interface OrderQuantityValidationResult {
    valid: boolean;
    requestedQuantity: number;
    minimumQuantity: number;
    orderStep: number;
    suggestedQuantity?: number;
    reason?: 'BELOW_MINIMUM' | 'INVALID_ORDER_STEP' | 'INACTIVE_SALES_UNIT';
}

export interface PackagingDepositRule {
    id: string;
    salesUnitId: string;
    packagingType: string;        // e.g. "EURO_PALLET"
    depositAmount: number;        // amount per deposit unit
    currency: string;
    quantityPerSalesUnit: number; // how many deposit units per 1 sales unit
    refundable: boolean;
    active: boolean;
}

export interface DepositCharge {
    packagingType: string;
    depositAmount: number;
    currency: string;
    quantity: number;      // how many deposit units
    totalAmount: number;   // depositAmount * quantity
    refundable: boolean;
}

export interface ProductAvailabilityBySalesUnit {
    salesUnitCode: string;
    salesUnitName: string;
    salesUnitQuantityAvailable: number; // floor(ownStockBaseQty / salesUnit.baseQuantity)
    baseQuantityAvailable: number;
    totalWeightGrams: number;
    pricing?: SalesUnitPricing | undefined;
}
