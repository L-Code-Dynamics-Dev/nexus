import { describe, it, expect } from 'vitest';
import { Decimal } from 'decimal.js';
import {
    MoneyValidatorRule, AddressValidatorRule, TaxValidatorRule, CustomerValidatorRule,
    OrderItemValidatorRule, ShippingValidatorRule, PaymentValidatorRule, DiscountValidatorRule, OrderValidatorRule,
} from '../../../domains/omega/ValidatorRules.js';
import { validateMoney } from '../../../connectors/omega/legacy/validation/validators/MoneyValidator.js';
import { validateAddress } from '../../../connectors/omega/legacy/validation/validators/AddressValidator.js';
import { validateTax } from '../../../connectors/omega/legacy/validation/validators/TaxValidator.js';
import { validateCustomer } from '../../../connectors/omega/legacy/validation/validators/CustomerValidator.js';
import { validateOrderItem } from '../../../connectors/omega/legacy/validation/validators/OrderItemValidator.js';
import { validateShipping, validatePayment, validateDiscount } from '../../../connectors/omega/legacy/validation/validators/ServicesValidators.js';
import { validateOrder } from '../../../connectors/omega/legacy/validation/validators/OrderValidator.js';

const ctx = { tenantId: 'ten_1', ruleVersion: '1' };

function validMoney(amount = '100', currency = 'CZK') {
    return { amount: new Decimal(amount), currency };
}
function validTax(amount = '21', currency = 'CZK') {
    return { rate: 21, amount: validMoney(amount, currency) };
}
function validAddress() {
    return { street: 'St 1', city: 'Praha', zipCode: '10000', country: 'CZ' };
}
function validCustomer() {
    return { id: 'c1', isCompany: false, name: 'Jan Novak', email: 'jan@example.com', billingAddress: validAddress() };
}
function validOrderItem(qty = '2', unitPrice = '100', total = '242') {
    return {
        id: 'item1', name: 'Widget', quantity: new Decimal(qty),
        unitPriceWithoutTax: validMoney(unitPrice), tax: validTax(),
        unitPriceWithTax: validMoney('121'), totalPriceWithTax: validMoney(total),
    };
}
function validShipping() {
    return { id: 'ship1', name: 'Shipping', priceWithoutTax: validMoney('0'), tax: validTax('0'), priceWithTax: validMoney('0') };
}
function validPayment() {
    return { id: 'pay1', name: 'Payment', priceWithoutTax: validMoney('0'), tax: validTax('0'), priceWithTax: validMoney('0') };
}
function validDiscount() {
    return { id: 'disc1', name: 'Discount', amountWithTax: validMoney('0') };
}
function validOrder() {
    return {
        tenantId: 'ten_1', shopId: 'shop_1', orderNumber: 'ORD-1', createdAt: new Date('2026-09-05'),
        customer: validCustomer(),
        totalAmount: validMoney('242'),
        items: [validOrderItem('2', '100', '242')],
        shipping: validShipping(), payment: validPayment(), discounts: [],
    };
}

describe('MoneyValidatorRule parity', () => {
    const rule = new MoneyValidatorRule({ ...ctx, ruleId: 'money-v1' });
    it('valid money', () => expect(rule.evaluate({ money: validMoney() })).toEqual(validateMoney(validMoney())));
    it('missing money', () => expect(rule.evaluate({ money: null })).toEqual(validateMoney(null)));
    it('NaN amount', () => expect(rule.evaluate({ money: { amount: 'not-a-number', currency: 'CZK' } })).toEqual(validateMoney({ amount: 'not-a-number', currency: 'CZK' })));
    it('currency mismatch', () => expect(rule.evaluate({ money: validMoney('1', 'EUR'), expectedCurrency: 'CZK' })).toEqual(validateMoney(validMoney('1', 'EUR'), 'CZK')));
});

describe('AddressValidatorRule parity', () => {
    const rule = new AddressValidatorRule({ ...ctx, ruleId: 'address-v1' });
    it('valid address', () => expect(rule.evaluate(validAddress())).toEqual(validateAddress(validAddress())));
    it('missing street', () => expect(rule.evaluate({ city: 'Praha', zipCode: '10000', country: 'CZ' })).toEqual(validateAddress({ city: 'Praha', zipCode: '10000', country: 'CZ' })));
});

describe('TaxValidatorRule parity', () => {
    const rule = new TaxValidatorRule({ ...ctx, ruleId: 'tax-v1' });
    it('valid tax', () => expect(rule.evaluate({ tax: validTax(), expectedCurrency: 'CZK' })).toEqual(validateTax(validTax(), 'CZK')));
    it('invalid rate over 100', () => expect(rule.evaluate({ tax: { rate: 150, amount: validMoney() }, expectedCurrency: 'CZK' })).toEqual(validateTax({ rate: 150, amount: validMoney() }, 'CZK')));
});

describe('CustomerValidatorRule parity', () => {
    const rule = new CustomerValidatorRule({ ...ctx, ruleId: 'customer-v1' });
    it('valid customer', () => expect(rule.evaluate(validCustomer())).toEqual(validateCustomer(validCustomer())));
    it('company without ICO', () => {
        const c = { ...validCustomer(), isCompany: true, companyName: 'ACME' };
        expect(rule.evaluate(c)).toEqual(validateCustomer(c));
    });
    it('invalid email', () => {
        const c = { ...validCustomer(), email: 'not-an-email' };
        expect(rule.evaluate(c)).toEqual(validateCustomer(c));
    });
});

describe('OrderItemValidatorRule parity', () => {
    const rule = new OrderItemValidatorRule({ ...ctx, ruleId: 'order-item-v1' });
    it('valid item', () => expect(rule.evaluate({ item: validOrderItem(), expectedCurrency: 'CZK' })).toEqual(validateOrderItem(validOrderItem(), 'CZK')));
    it('total mismatch', () => {
        const item = validOrderItem('2', '100', '999');
        expect(rule.evaluate({ item, expectedCurrency: 'CZK' })).toEqual(validateOrderItem(item, 'CZK'));
    });
    it('zero quantity invalid', () => {
        const item = validOrderItem('0', '100', '0');
        expect(rule.evaluate({ item, expectedCurrency: 'CZK' })).toEqual(validateOrderItem(item, 'CZK'));
    });
});

describe('ShippingValidatorRule / PaymentValidatorRule / DiscountValidatorRule parity', () => {
    it('shipping valid', () => {
        const rule = new ShippingValidatorRule({ ...ctx, ruleId: 'shipping-v1' });
        expect(rule.evaluate({ service: validShipping(), expectedCurrency: 'CZK' })).toEqual(validateShipping(validShipping(), 'CZK'));
    });
    it('payment valid', () => {
        const rule = new PaymentValidatorRule({ ...ctx, ruleId: 'payment-v1' });
        expect(rule.evaluate({ service: validPayment(), expectedCurrency: 'CZK' })).toEqual(validatePayment(validPayment(), 'CZK'));
    });
    it('discount valid', () => {
        const rule = new DiscountValidatorRule({ ...ctx, ruleId: 'discount-v1' });
        expect(rule.evaluate({ service: validDiscount(), expectedCurrency: 'CZK' })).toEqual(validateDiscount(validDiscount(), 'CZK'));
    });
});

describe('OrderValidatorRule parity', () => {
    const rule = new OrderValidatorRule({ ...ctx, ruleId: 'order-v1' });
    it('valid order (fully consistent totals)', () => expect(rule.evaluate(validOrder())).toEqual(validateOrder(validOrder())));
    it('missing order', () => expect(rule.evaluate(null)).toEqual(validateOrder(null)));
    it('total mismatch across items+shipping+payment-discounts', () => {
        const order = { ...validOrder(), totalAmount: validMoney('9999') };
        expect(rule.evaluate(order)).toEqual(validateOrder(order));
    });
    it('missing items array', () => {
        const order = { ...validOrder(), items: [] };
        expect(rule.evaluate(order)).toEqual(validateOrder(order));
    });
});
