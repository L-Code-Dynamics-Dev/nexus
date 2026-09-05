// PackagingDepositRule -- migrace legacy PackagingDepositEngine
// (connectors/availability-intelligence/legacy/sales-units/
// PackagingDepositEngine.ts) pod Nexus Rule contract. Fáze 3
// (docs/MIGRATION_PLAN.md).
//
// 1:1 s legacy: vrací pole DepositCharge, NIKDY neslučuje deposit do
// ceny produktu -- to je záměrný byznys invariant (např. EURO_PALLET
// deposit musí zůstat viditelně oddělený, kvůli refundable trackingu).

import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import type { PackagingDepositRule as PackagingDepositRuleConfig, DepositCharge } from '../../connectors/availability-intelligence/legacy/sales-units/types.js';

export interface PackagingDepositInput {
    readonly rules: readonly PackagingDepositRuleConfig[];
    readonly salesUnitQuantity: number;
}

export class PackagingDepositRule implements Rule<PackagingDepositInput, DepositCharge[]> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: PackagingDepositInput): DepositCharge[] {
        const { rules, salesUnitQuantity } = input;
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
