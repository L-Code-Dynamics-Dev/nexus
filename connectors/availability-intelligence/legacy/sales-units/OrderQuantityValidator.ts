import type { SalesUnit, OrderQuantityValidationResult } from './types.js';

/**
 * Validates that a requested sales-unit quantity satisfies MOQ and orderStep constraints.
 * Never rounds silently. Returns a structured result, never a bare boolean.
 */
export class OrderQuantityValidator {
    static validate(salesUnit: SalesUnit, requestedQuantity: number): OrderQuantityValidationResult {
        if (!salesUnit.active) {
            return {
                valid: false,
                requestedQuantity,
                minimumQuantity: salesUnit.minimumQuantity,
                orderStep: salesUnit.orderStep,
                reason: 'INACTIVE_SALES_UNIT',
            };
        }

        if (requestedQuantity < salesUnit.minimumQuantity) {
            return {
                valid: false,
                requestedQuantity,
                minimumQuantity: salesUnit.minimumQuantity,
                orderStep: salesUnit.orderStep,
                suggestedQuantity: salesUnit.minimumQuantity,
                reason: 'BELOW_MINIMUM',
            };
        }

        // (requestedQuantity - minimumQuantity) must be divisible by orderStep
        const aboveMinimum = requestedQuantity - salesUnit.minimumQuantity;
        if (aboveMinimum % salesUnit.orderStep !== 0) {
            const steps = Math.ceil(aboveMinimum / salesUnit.orderStep);
            const suggested = salesUnit.minimumQuantity + steps * salesUnit.orderStep;
            return {
                valid: false,
                requestedQuantity,
                minimumQuantity: salesUnit.minimumQuantity,
                orderStep: salesUnit.orderStep,
                suggestedQuantity: suggested,
                reason: 'INVALID_ORDER_STEP',
            };
        }

        return {
            valid: true,
            requestedQuantity,
            minimumQuantity: salesUnit.minimumQuantity,
            orderStep: salesUnit.orderStep,
        };
    }
}
