// ValidatorRules -- migrace legacy CanonicalOrder validátorů (connectors/
// omega/legacy/validation/validators/*.ts) pod Nexus Rule contract.
// Fáze 5 pokračování (docs/MIGRATION_PLAN.md).
//
// POZOR: tyto validátory validují CanonicalOrder/Customer/Money/atd.
// (connectors/omega/legacy/domain/CanonicalModel.ts) -- JINÝ typ než
// CanonicalAccountingDocument (connectors/omega/legacy/core/), který
// řeší R01/R02 export. CanonicalModel.ts je JEN typová kostra (žádná
// logika) potřebná jako závislost validátorů -- není to totéž jako
// OrderReconstructor.ts (Fáze 4 rozhodnutí, nemigrováno kvůli mock
// placeholder polím). Validátory samotné jsou kompletní, čistá logika
// nezávislá na tom rozhodnutí.
//
// Všech 7 validátorů je synchronních čistých funkcí, žádné I/O --
// legitimní Rule<> kandidáti. 1:1 delegace, žádná re-implementace.

import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import type { ValidationResult } from '../../connectors/shoptet/legacy/validation/types.js';
import { validateMoney } from '../../connectors/omega/legacy/validation/validators/MoneyValidator.js';
import { validateAddress } from '../../connectors/omega/legacy/validation/validators/AddressValidator.js';
import { validateTax } from '../../connectors/omega/legacy/validation/validators/TaxValidator.js';
import { validateCustomer } from '../../connectors/omega/legacy/validation/validators/CustomerValidator.js';
import { validateOrderItem } from '../../connectors/omega/legacy/validation/validators/OrderItemValidator.js';
import { validateShipping, validatePayment, validateDiscount } from '../../connectors/omega/legacy/validation/validators/ServicesValidators.js';
import { validateOrder } from '../../connectors/omega/legacy/validation/validators/OrderValidator.js';

export interface MoneyValidationInput {
    readonly money: unknown;
    readonly expectedCurrency?: string;
}

export class MoneyValidatorRule implements Rule<MoneyValidationInput, ValidationResult> {
    constructor(public readonly context: RuleContext) {}
    evaluate(input: MoneyValidationInput): ValidationResult {
        return validateMoney(input.money, input.expectedCurrency);
    }
}

export class AddressValidatorRule implements Rule<unknown, ValidationResult> {
    constructor(public readonly context: RuleContext) {}
    evaluate(address: unknown): ValidationResult {
        return validateAddress(address);
    }
}

export interface TaxValidationInput {
    readonly tax: unknown;
    readonly expectedCurrency: string;
}

export class TaxValidatorRule implements Rule<TaxValidationInput, ValidationResult> {
    constructor(public readonly context: RuleContext) {}
    evaluate(input: TaxValidationInput): ValidationResult {
        return validateTax(input.tax, input.expectedCurrency);
    }
}

export class CustomerValidatorRule implements Rule<unknown, ValidationResult> {
    constructor(public readonly context: RuleContext) {}
    evaluate(customer: unknown): ValidationResult {
        return validateCustomer(customer);
    }
}

export interface OrderItemValidationInput {
    readonly item: unknown;
    readonly expectedCurrency: string;
}

export class OrderItemValidatorRule implements Rule<OrderItemValidationInput, ValidationResult> {
    constructor(public readonly context: RuleContext) {}
    evaluate(input: OrderItemValidationInput): ValidationResult {
        return validateOrderItem(input.item, input.expectedCurrency);
    }
}

export interface ServiceValidationInput {
    readonly service: unknown;
    readonly expectedCurrency: string;
}

export class ShippingValidatorRule implements Rule<ServiceValidationInput, ValidationResult> {
    constructor(public readonly context: RuleContext) {}
    evaluate(input: ServiceValidationInput): ValidationResult {
        return validateShipping(input.service, input.expectedCurrency);
    }
}

export class PaymentValidatorRule implements Rule<ServiceValidationInput, ValidationResult> {
    constructor(public readonly context: RuleContext) {}
    evaluate(input: ServiceValidationInput): ValidationResult {
        return validatePayment(input.service, input.expectedCurrency);
    }
}

export class DiscountValidatorRule implements Rule<ServiceValidationInput, ValidationResult> {
    constructor(public readonly context: RuleContext) {}
    evaluate(input: ServiceValidationInput): ValidationResult {
        return validateDiscount(input.service, input.expectedCurrency);
    }
}

export class OrderValidatorRule implements Rule<unknown, ValidationResult> {
    constructor(public readonly context: RuleContext) {}
    evaluate(order: unknown): ValidationResult {
        return validateOrder(order);
    }
}
