import { describe, it, expect } from 'vitest';
import { EconomicsRule } from '../../../domains/safeorder/EconomicsRule.js';
import { PolicyRule, PolicyOptimizationRule } from '../../../domains/safeorder/PolicyRule.js';
import { evaluateDecisionEconomics } from '../../../connectors/safeorder/legacy/economics/decision-economics.js';
import { evaluatePolicy } from '../../../connectors/safeorder/legacy/policy-engine/policies.js';
import { optimizePolicyThresholds } from '../../../connectors/safeorder/legacy/policy-engine/adaptive-optimizer.js';
import { createRawRiskScore, createRiskConfidence, type MerchantEconomicProfile, type TenantPolicyRecord } from '../../../connectors/safeorder/legacy/core/types.js';

const profile: MerchantEconomicProfile = {
    tenant_id: 'ten_1',
    currency: 'CZK',
    average_order_value: 1000,
    product_margin_rate: 0.4,
    shipping_cost_outbound: 100,
    shipping_cost_return: 100,
    restock_packaging_cost: 30,
    payment_processing_rate: 0.015,
    cod_handling_fee: 40,
    customer_friction_cost: 150,
    updated_at: Date.now(),
};

describe('EconomicsRule parity vs legacy evaluateDecisionEconomics', () => {
    const rule = new EconomicsRule({ tenantId: 'ten_1', ruleId: 'economics-v1', ruleVersion: '1' });

    const scenarios = [
        { name: 'currency mismatch', probability: 0.5, currency: 'EUR' },
        { name: 'low probability', probability: 0.01, currency: 'CZK' },
        { name: 'mid probability', probability: 0.4, currency: 'CZK' },
        { name: 'high probability', probability: 0.9, currency: 'CZK' },
    ];

    for (const s of scenarios) {
        it(`matches legacy for scenario: ${s.name}`, () => {
            const prob = createRiskConfidence(s.probability) as any;
            const legacy = evaluateDecisionEconomics(prob, 1000, s.currency, profile);
            const nexus = rule.evaluate({ calibratedRtoProbability: prob, orderTotal: 1000, orderCurrency: s.currency, profile });

            expect(nexus.recommendedAction).toBe(legacy.recommendedAction);
            expect(nexus.estimatedNetSavings).toBe(legacy.estimatedNetSavings);
            expect(nexus.currencyMatch).toBe(legacy.currencyMatch);
        });
    }
});

describe('PolicyRule parity vs legacy evaluatePolicy', () => {
    const rule = new PolicyRule({ tenantId: 'ten_1', ruleId: 'policy-v1', ruleVersion: '1' });
    const tenantPolicy: TenantPolicyRecord = {
        tenant_id: 'ten_1',
        policy_version: 'policy-v1',
        review_threshold: 0.8,
        restrict_threshold: 1.8,
        signal_retention_days: 90,
        cod_policy_action: 'RESTRICT_COD',
        network_enabled: 0,
        fallback_behavior: 'ALLOW',
        updated_at: Date.now(),
    };

    const scenarios = [
        { name: 'trusted repeat buyer bypass', rawScore: 2.5, confidence: 0.9, reasonCodes: ['TRUSTED_REPEAT_BUYER'] },
        { name: 'unknown first-time buyer low score', rawScore: 0.3, confidence: 0.3, reasonCodes: ['FIRST_TIME_BUYER'] },
        { name: 'established customer high score', rawScore: 2.0, confidence: 0.7, reasonCodes: [] },
        { name: 'established customer elevated score', rawScore: 1.0, confidence: 0.7, reasonCodes: [] },
        { name: 'established customer low confidence high score', rawScore: 2.0, confidence: 0.2, reasonCodes: [] },
    ];

    for (const s of scenarios) {
        it(`matches legacy for scenario: ${s.name}`, () => {
            const input = {
                rawScore: createRawRiskScore(s.rawScore),
                confidence: createRiskConfidence(s.confidence),
                reasonCodes: s.reasonCodes,
                activeSignalCount: 0,
            };
            const legacy = evaluatePolicy(input, tenantPolicy);
            const nexus = rule.evaluate({ evaluation: input, tenantPolicy });

            expect(nexus.decision).toBe(legacy.decision);
            expect(nexus.policyVersion).toBe(legacy.policyVersion);
        });
    }

    it('missing tenantPolicy falls back to hardcoded defaults, matches legacy', () => {
        const input = { rawScore: createRawRiskScore(0.5), confidence: createRiskConfidence(0.7), reasonCodes: [], activeSignalCount: 0 };
        const legacy = evaluatePolicy(input);
        const nexus = rule.evaluate({ evaluation: input });
        expect(nexus.decision).toBe(legacy.decision);
    });
});

describe('PolicyOptimizationRule parity vs legacy optimizePolicyThresholds', () => {
    const rule = new PolicyOptimizationRule({ tenantId: 'ten_1', ruleId: 'policy-optimization-v1', ruleVersion: '1' });

    const scenarios = [
        { name: 'insufficient data', sampleCount: 10, fpRate: 0.5, targetFpRate: 0.1 },
        { name: 'too aggressive', sampleCount: 100, fpRate: 0.2, targetFpRate: 0.1 },
        { name: 'too lenient', sampleCount: 100, fpRate: 0.02, targetFpRate: 0.1 },
        { name: 'optimal', sampleCount: 100, fpRate: 0.09, targetFpRate: 0.1 },
    ];

    for (const s of scenarios) {
        it(`matches legacy for scenario: ${s.name}`, () => {
            const input = {
                currentRestrictThreshold: 1.8,
                currentReviewThreshold: 0.8,
                observedFalsePositiveRate: s.fpRate,
                targetMaxFalsePositiveRate: s.targetFpRate,
                observedSampleCount: s.sampleCount,
            };
            const legacy = optimizePolicyThresholds(input);
            const nexus = rule.evaluate(input);

            expect(nexus.status).toBe(legacy.status);
            expect(nexus.recommendedRestrictThreshold).toBe(legacy.recommendedRestrictThreshold);
            expect(nexus.recommendedReviewThreshold).toBe(legacy.recommendedReviewThreshold);
        });
    }
});
