// OrderQuantityValidationRule -- migrace legacy OrderQuantityValidator
// (connectors/availability-intelligence/legacy/sales-units/
// OrderQuantityValidator.ts) pod Nexus Rule contract. Fáze 3
// (docs/MIGRATION_PLAN.md).
//
// 1:1 s legacy: pořadí kontrol beze změny (inactive -> below minimum ->
// invalid order step -> valid), suggestedQuantity výpočet (ceil na
// nejbližší platný krok) zachován přesně -- žádné tiché zaokrouhlení,
// vždy strukturovaný výsledek s reason.

import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import type { SalesUnit, OrderQuantityValidationResult } from '../../connectors/availability-intelligence/legacy/sales-units/types.js';

export interface OrderQuantityValidationInput {
    readonly salesUnit: SalesUnit;
    readonly requestedQuantity: number;
}

export class OrderQuantityValidationRule implements Rule<OrderQuantityValidationInput, OrderQuantityValidationResult> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: OrderQuantityValidationInput): OrderQuantityValidationResult {
        const { salesUnit, requestedQuantity } = input;

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
