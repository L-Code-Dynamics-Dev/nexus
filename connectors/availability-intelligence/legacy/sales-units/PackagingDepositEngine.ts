import type { PackagingDepositRule, DepositCharge } from './types.js';

/**
 * Calculates deposit charges for a sales unit order.
 * Returns an array of DepositCharge — NEVER merges deposit into product price.
 */
export class PackagingDepositEngine {
    static calculate(rules: PackagingDepositRule[], salesUnitQuantity: number): DepositCharge[] {
        if (!Number.isInteger(salesUnitQuantity) || salesUnitQuantity <= 0) {
            throw new Error(`salesUnitQuantity must be a positive integer, got ${salesUnitQuantity}`);
        }
        const charges: DepositCharge[] = [];
        for (const rule of rules) {
            if (!rule.active) continue;
            const qty = rule.quantityPerSalesUnit * salesUnitQuantity;
            const total = rule.depositAmount * qty;
            charges.push({
                packagingType: rule.packagingType,
                depositAmount: rule.depositAmount,
                currency: rule.currency,
                quantity: qty,
                totalAmount: total,
                refundable: rule.refundable,
            });
        }
        return charges;
    }
}
