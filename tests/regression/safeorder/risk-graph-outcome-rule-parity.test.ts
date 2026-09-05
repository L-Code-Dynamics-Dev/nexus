import { describe, it, expect } from 'vitest';
import { RiskGraphRule } from '../../../domains/safeorder/RiskGraphRule.js';
import { OutcomeEngineRule } from '../../../domains/safeorder/OutcomeEngineRule.js';
import { evaluateContextualRisk, type GraphNode } from '../../../connectors/safeorder/legacy/risk-graph/graph.js';
import { computeAdaptiveWeights, type OutcomeRecord } from '../../../connectors/safeorder/legacy/learning/outcome-engine.js';

describe('RiskGraphRule parity vs legacy evaluateContextualRisk', () => {
    const rule = new RiskGraphRule({ tenantId: 'ten_1', ruleId: 'risk-graph-v1', ruleVersion: '1' });

    function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
        return {
            id: 'n1', tenantId: 'ten_1', type: 'IDENTITY', blindToken: 'bt_1',
            totalOrders: 0, successfulDeliveries: 0, rtoCount: 0, returnCount: 0, totalSpend: 0,
            ...overrides,
        };
    }

    it('null entityNode (first-time buyer) matches legacy', () => {
        const order = { orderTotal: 100, paymentMethod: 'COD' as const, currency: 'CZK' };
        expect(rule.evaluate({ entityNode: null, order })).toEqual(evaluateContextualRisk(null, order));
    });

    it('high historical RTO ratio (>=2 RTO, ratio > 40%) matches legacy', () => {
        const node = makeNode({ totalOrders: 4, rtoCount: 2, successfulDeliveries: 2 });
        const order = { orderTotal: 100, paymentMethod: 'COD' as const, currency: 'CZK' };
        expect(rule.evaluate({ entityNode: node, order })).toEqual(evaluateContextualRisk(node, order));
    });

    it('single previous RTO matches legacy', () => {
        const node = makeNode({ totalOrders: 5, rtoCount: 1, successfulDeliveries: 4 });
        const order = { orderTotal: 100, paymentMethod: 'COD' as const, currency: 'CZK' };
        expect(rule.evaluate({ entityNode: node, order })).toEqual(evaluateContextualRisk(node, order));
    });

    it('trusted repeat buyer (>=3 successful deliveries, ratio > 85%) matches legacy', () => {
        const node = makeNode({ totalOrders: 10, rtoCount: 0, successfulDeliveries: 9 });
        const order = { orderTotal: 100, paymentMethod: 'COD' as const, currency: 'CZK' };
        expect(rule.evaluate({ entityNode: node, order })).toEqual(evaluateContextualRisk(node, order));
    });

    it('high-value COD exposure (>2.5x average) matches legacy', () => {
        const order = { orderTotal: 300, paymentMethod: 'COD' as const, currency: 'CZK' };
        expect(rule.evaluate({ entityNode: null, order, averageOrderValue: 50 })).toEqual(evaluateContextualRisk(null, order, 50));
    });

    it('elevated-value COD (>1.5x average) matches legacy', () => {
        const order = { orderTotal: 90, paymentMethod: 'COD' as const, currency: 'CZK' };
        expect(rule.evaluate({ entityNode: null, order, averageOrderValue: 50 })).toEqual(evaluateContextualRisk(null, order, 50));
    });

    it('prepaid protected (score scaled to 20%) matches legacy', () => {
        const node = makeNode({ totalOrders: 4, rtoCount: 2, successfulDeliveries: 2 });
        const order = { orderTotal: 100, paymentMethod: 'PREPAID' as const, currency: 'CZK' };
        expect(rule.evaluate({ entityNode: node, order })).toEqual(evaluateContextualRisk(node, order));
    });

    it('unverified payment method matches legacy', () => {
        const order = { orderTotal: 100, paymentMethod: 'UNKNOWN' as const, currency: 'CZK' };
        expect(rule.evaluate({ entityNode: null, order })).toEqual(evaluateContextualRisk(null, order));
    });

    it('confidence tiers by totalObserved (0 / 1-4 / >=5) match legacy', () => {
        for (const totalOrders of [0, 1, 4, 5, 10]) {
            const node = totalOrders === 0 ? null : makeNode({ totalOrders });
            const order = { orderTotal: 100, paymentMethod: 'CARD' as const, currency: 'CZK' };
            expect(rule.evaluate({ entityNode: node, order })).toEqual(evaluateContextualRisk(node, order));
        }
    });
});

describe('OutcomeEngineRule parity vs legacy computeAdaptiveWeights', () => {
    const rule = new OutcomeEngineRule({ tenantId: 'ten_1', ruleId: 'outcome-engine-v1', ruleVersion: '1' });

    it('empty outcomes matches legacy defaults', () => {
        expect(rule.evaluate({ outcomes: [] })).toEqual(computeAdaptiveWeights([]));
    });

    function makeOutcome(overrides: Partial<OutcomeRecord> = {}): OutcomeRecord {
        return {
            orderRef: 'o1', blindToken: 'bt_1', predictedRiskScore: 1.0,
            initialDecision: 'ALLOW', finalOutcome: 'DELIVERED_SUCCESS',
            orderTotal: 100, timestamp: Date.now(),
            ...overrides,
        };
    }

    it('UNKNOWN_COUNTERFACTUAL exclusion matches legacy', () => {
        const outcomes = [
            makeOutcome({ finalOutcome: 'UNKNOWN_COUNTERFACTUAL' }),
            makeOutcome({ finalOutcome: 'DELIVERED_SUCCESS' }),
        ];
        expect(rule.evaluate({ outcomes })).toEqual(computeAdaptiveWeights(outcomes));
    });

    it('false positive detection (RESTRICT -> MERCHANT_OVERRIDE_SUCCESS) matches legacy', () => {
        const outcomes = Array.from({ length: 50 }, (_, i) =>
            makeOutcome({ orderRef: `o${i}`, initialDecision: 'RESTRICT', finalOutcome: i < 5 ? 'MERCHANT_OVERRIDE_SUCCESS' : 'RTO_UNCOLLECTED' })
        );
        expect(rule.evaluate({ outcomes })).toEqual(computeAdaptiveWeights(outcomes));
    });

    it('high false-positive rate (>1.5%) adjustment matches legacy', () => {
        const outcomes = Array.from({ length: 100 }, (_, i) =>
            makeOutcome({ orderRef: `o${i}`, initialDecision: 'RESTRICT', finalOutcome: i < 10 ? 'DELIVERED_SUCCESS' : 'RTO_UNCOLLECTED' })
        );
        expect(rule.evaluate({ outcomes })).toEqual(computeAdaptiveWeights(outcomes));
    });

    it('low false-positive + low catch rate adjustment matches legacy', () => {
        const outcomes = Array.from({ length: 100 }, (_, i) =>
            makeOutcome({ orderRef: `o${i}`, initialDecision: i < 20 ? 'RESTRICT' : 'ALLOW', finalOutcome: i < 20 ? 'DELIVERED_SUCCESS' : 'RTO_UNCOLLECTED' })
        );
        expect(rule.evaluate({ outcomes })).toEqual(computeAdaptiveWeights(outcomes));
    });

    it('custom baseWeights passed through matches legacy', () => {
        const outcomes = [makeOutcome()];
        const baseWeights = { uncollectedWeightMultiplier: 1.1, falsePositiveSuppressionFactor: 0.9, highValueCodSensitivity: 1.2 };
        expect(rule.evaluate({ outcomes, baseWeights })).toEqual(computeAdaptiveWeights(outcomes, baseWeights));
    });

    it('MERCHANT_OVERRIDE_FAILED counted as actual RTO matches legacy', () => {
        const outcomes = [
            makeOutcome({ initialDecision: 'RESTRICT', finalOutcome: 'MERCHANT_OVERRIDE_FAILED' }),
        ];
        expect(rule.evaluate({ outcomes })).toEqual(computeAdaptiveWeights(outcomes));
    });
});
