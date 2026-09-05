import { describe, it, expect } from 'vitest';
import { Decimal } from 'decimal.js';
import {
    DecisionEngineRule,
    SourceDocumentIdExistsRuleAdapter,
    CustomerIdentityValidRuleAdapter,
    VatDeterminationRuleAdapter,
} from '../../../domains/omega/DecisionRules.js';
import { DecisionEngine } from '../../../connectors/omega/legacy/decisions/DecisionEngine.js';
import { PolicyLayer } from '../../../connectors/omega/legacy/policies/PolicyLayer.js';
import { SourceDocumentIdExistsRule, CustomerIdentityValidRule } from '../../../connectors/omega/legacy/rules/implementations/IdentityRules.js';
import { VatDeterminationRule } from '../../../connectors/omega/legacy/rules/implementations/TaxRules.js';
import type { CanonicalOrder } from '../../../connectors/omega/legacy/domain/CanonicalModel.js';
import type { RuleContext } from '../../../connectors/omega/legacy/rules/RuleTypes.js';

const ctx = { tenantId: 'ten_1', ruleVersion: '1' };

function makeOrder(overrides?: Partial<CanonicalOrder>): CanonicalOrder {
    const money = { amount: new Decimal(100), currency: 'CZK' };
    const tax = { rate: 21, amount: money };
    return {
        tenantId: 'ten_1', shopId: 'shop_1', orderNumber: 'ORD-1', createdAt: new Date(),
        customer: { id: 'c1', isCompany: false, name: 'Jan Novak', email: 'jan@example.com', billingAddress: { street: 'St 1', city: 'Praha', zipCode: '10000', country: 'CZ' } },
        items: [{ id: 'i1', sku: 'SKU1', name: 'Widget', quantity: new Decimal(1), unitPriceWithoutTax: money, tax, unitPriceWithTax: money, totalPriceWithTax: money }],
        shipping: { id: 'ship_1', name: 'Shipping', priceWithoutTax: money, tax, priceWithTax: money },
        payment: { id: 'pay_1', name: 'Payment', priceWithoutTax: money, tax, priceWithTax: money },
        discounts: [], totalAmount: money,
        ...overrides,
    };
}

function makeRuleContext(order: CanonicalOrder): RuleContext {
    return { order, tenantConfig: {} };
}

describe('SourceDocumentIdExistsRuleAdapter parity vs legacy SourceDocumentIdExistsRule', () => {
    const rule = new SourceDocumentIdExistsRuleAdapter({ ...ctx, ruleId: 'source-doc-id-v1' });
    const legacyRule = new SourceDocumentIdExistsRule();

    it('matches legacy for valid orderNumber', () => {
        const context = makeRuleContext(makeOrder());
        expect(rule.evaluate(context)).toEqual(legacyRule.evaluate(context));
    });

    it('matches legacy for missing orderNumber', () => {
        const context = makeRuleContext(makeOrder({ orderNumber: '' }));
        expect(rule.evaluate(context)).toEqual(legacyRule.evaluate(context));
    });
});

describe('CustomerIdentityValidRuleAdapter parity vs legacy CustomerIdentityValidRule', () => {
    const rule = new CustomerIdentityValidRuleAdapter({ ...ctx, ruleId: 'customer-identity-v1' });
    const legacyRule = new CustomerIdentityValidRule();

    it('matches legacy for customer with email', () => {
        const context = makeRuleContext(makeOrder());
        expect(rule.evaluate(context)).toEqual(legacyRule.evaluate(context));
    });

    it('matches legacy for company customer missing ICO/DIC -> UNKNOWN', () => {
        const order = makeOrder({ customer: { id: 'c1', isCompany: true, name: 'Firma s.r.o.', email: '', billingAddress: { street: 'St 1', city: 'Praha', zipCode: '10000', country: 'CZ' } } });
        const context = makeRuleContext(order);
        expect(rule.evaluate(context)).toEqual(legacyRule.evaluate(context));
    });
});

describe('VatDeterminationRuleAdapter parity vs legacy VatDeterminationRule', () => {
    const rule = new VatDeterminationRuleAdapter({ ...ctx, ruleId: 'vat-determination-v1' });
    const legacyRule = new VatDeterminationRule();

    it('matches legacy for valid VAT rates', () => {
        const context = makeRuleContext(makeOrder());
        expect(rule.evaluate(context)).toEqual(legacyRule.evaluate(context));
    });

    it('matches legacy for missing item VAT rate -> UNKNOWN', () => {
        const order = makeOrder();
        (order.items[0]!.tax as any).rate = undefined;
        const context = makeRuleContext(order);
        expect(rule.evaluate(context)).toEqual(legacyRule.evaluate(context));
    });
});

describe('DecisionEngineRule parity vs legacy DecisionEngine', () => {
    const nexusRule = new DecisionEngineRule({ ...ctx, ruleId: 'decision-engine-v1' });

    function runLegacy(order: CanonicalOrder) {
        const rules = [new SourceDocumentIdExistsRule(), new CustomerIdentityValidRule(), new VatDeterminationRule()];
        const engine = new DecisionEngine(rules, new PolicyLayer(), 'ruleset-v1');
        return engine.evaluate(makeRuleContext(order));
    }

    function runNexus(order: CanonicalOrder) {
        const rules = [new SourceDocumentIdExistsRule(), new CustomerIdentityValidRule(), new VatDeterminationRule()];
        return nexusRule.evaluate({ rules, ruleSetVersion: 'ruleset-v1', context: makeRuleContext(order) });
    }

    it('matches legacy for fully valid order -> ACCEPT', () => {
        const order = makeOrder();
        expect(runNexus(order)).toEqual(runLegacy(order));
    });

    it('matches legacy for missing orderNumber -> REJECT (blocking)', () => {
        const order = makeOrder({ orderNumber: '' });
        expect(runNexus(order)).toEqual(runLegacy(order));
    });

    it('matches legacy for missing VAT rate -> HOLD (UNKNOWN is blocking)', () => {
        const order = makeOrder();
        (order.items[0]!.tax as any).rate = undefined;
        expect(runNexus(order)).toEqual(runLegacy(order));
    });
});
