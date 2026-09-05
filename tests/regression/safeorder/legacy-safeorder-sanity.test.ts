// Sanity test proti skutečně portovanému legacy SafeOrder kódu
// (connectors/safeorder/legacy/, 1:1 kopie ~/safeorder-3.0/src/core/).
// Ověřuje, že portovaný kód funguje (žádná re-implementace, jen import +
// spuštění), než se začne migrovat pod Nexus Rule contract -- stejný
// první krok jako u Pricing Engine (tests/regression/golden-pricing/golden.test.ts).

import { describe, it, expect } from 'vitest';
import { calibrateRiskProbability, computeEvidentiaryConfidence } from '../../../connectors/safeorder/legacy/calibration/calibration-engine.js';
import { evaluateDecisionEconomics, computeMerchantRoi } from '../../../connectors/safeorder/legacy/economics/decision-economics.js';
import { evaluatePolicy } from '../../../connectors/safeorder/legacy/policy-engine/policies.js';
import { optimizePolicyThresholds } from '../../../connectors/safeorder/legacy/policy-engine/adaptive-optimizer.js';
import { generateBlindToken, verifyBlindToken } from '../../../connectors/safeorder/legacy/crypto/blind-token.js';
import { createRawRiskScore, createRiskConfidence, type MerchantEconomicProfile, type TenantPolicyRecord } from '../../../connectors/safeorder/legacy/core/types.js';

describe('legacy calibration-engine — logistic + piecewise sanity', () => {
    it('rawScore 0 -> minimal probability (0.01) for both models', () => {
        const logistic = calibrateRiskProbability(createRawRiskScore(0), 'calib-v1-logistic');
        const piecewise = calibrateRiskProbability(createRawRiskScore(0), 'calib-v1-piecewise');
        expect(logistic.probability).toBe(0.01);
        expect(piecewise.probability).toBe(0.01);
    });

    it('rawScore at logistic midpoint (1.5) -> probability ~0.5', () => {
        const result = calibrateRiskProbability(createRawRiskScore(1.5), 'calib-v1-logistic');
        expect(result.probability).toBeCloseTo(0.5, 2);
    });

    it('higher rawScore always yields higher-or-equal probability (monotonicity)', () => {
        const low = calibrateRiskProbability(createRawRiskScore(0.5), 'calib-v1-logistic');
        const high = calibrateRiskProbability(createRawRiskScore(3.0), 'calib-v1-logistic');
        expect(high.probability).toBeGreaterThan(low.probability);
    });

    it('zero signals + zero history -> low confidence (0.20-0.30), NEVER 1.0 (absence of evidence != evidence of absence)', () => {
        const confidence = computeEvidentiaryConfidence({
            signalCount: 0,
            totalHistoricalOrders: 0,
            successfulDeliveries: 0,
            rtoCount: 0,
            returnCount: 0,
            dataCompletenessScore: 1.0,
            averageSignalFreshnessDecay: 0,
        });
        expect(confidence).toBeGreaterThanOrEqual(0.2);
        expect(confidence).toBeLessThanOrEqual(0.3);
    });
});

describe('legacy decision-economics — currency safety + cost minimization', () => {
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

    it('currency mismatch -> UNCERTAIN_CURRENCY_MISMATCH, NEVER a numeric comparison across currencies', () => {
        const result = evaluateDecisionEconomics(createRiskConfidence(0.5) as any, 1000, 'EUR', profile);
        expect(result.currencyMatch).toBe(false);
        expect(result.recommendedAction).toBe('UNCERTAIN_CURRENCY_MISMATCH');
    });

    it('low RTO probability -> recommends ALLOW (no unnecessary friction)', () => {
        const result = evaluateDecisionEconomics(createRiskConfidence(0.01) as any, 1000, 'CZK', profile);
        expect(result.recommendedAction).toBe('ALLOW');
    });

    it('very high RTO probability -> recommends a restrictive action, not ALLOW', () => {
        const result = evaluateDecisionEconomics(createRiskConfidence(0.95) as any, 1000, 'CZK', profile);
        expect(result.recommendedAction).not.toBe('ALLOW');
    });

    it('computeMerchantRoi: prevented loss below subscription cost -> zero net savings, not negative', () => {
        const roi = computeMerchantRoi(50, 200);
        expect(roi.netMerchantSavings).toBe(0);
    });
});

describe('legacy policy-engine — trusted customer bypass + confidence gating', () => {
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

    it('trusted repeat buyer with high confidence bypasses threshold -> ALLOW even with elevated raw score', () => {
        const decision = evaluatePolicy(
            {
                rawScore: createRawRiskScore(2.5),
                confidence: createRiskConfidence(0.9),
                reasonCodes: ['TRUSTED_REPEAT_BUYER'],
                activeSignalCount: 0,
            },
            tenantPolicy
        );
        expect(decision.decision).toBe('ALLOW');
    });

    it('unknown first-time buyer with low raw score -> ALLOW (does not penalize typical behavior)', () => {
        const decision = evaluatePolicy(
            {
                rawScore: createRawRiskScore(0.3),
                confidence: createRiskConfidence(0.3),
                reasonCodes: ['FIRST_TIME_BUYER'],
                activeSignalCount: 0,
            },
            tenantPolicy
        );
        expect(decision.decision).toBe('ALLOW');
    });

    it('established customer with raw score above restrict threshold -> RESTRICT', () => {
        const decision = evaluatePolicy(
            {
                rawScore: createRawRiskScore(2.0),
                confidence: createRiskConfidence(0.7),
                reasonCodes: [],
                activeSignalCount: 3,
            },
            tenantPolicy
        );
        expect(decision.decision).toBe('RESTRICT');
    });

    it('missing tenantPolicy falls back to hardcoded defaults (review 0.8, restrict 1.8)', () => {
        const decision = evaluatePolicy({
            rawScore: createRawRiskScore(0.5),
            confidence: createRiskConfidence(0.7),
            reasonCodes: [],
            activeSignalCount: 0,
        });
        expect(decision.policyVersion).toBe('policy-v1');
    });
});

describe('legacy adaptive-optimizer — insufficient data guard + false positive rate response', () => {
    it('fewer than 30 samples -> INSUFFICIENT_DATA, no threshold change recommended', () => {
        const result = optimizePolicyThresholds({
            currentRestrictThreshold: 1.8,
            currentReviewThreshold: 0.8,
            observedFalsePositiveRate: 0.5,
            targetMaxFalsePositiveRate: 0.1,
            observedSampleCount: 10,
        });
        expect(result.status).toBe('INSUFFICIENT_DATA');
        expect(result.recommendedRestrictThreshold).toBe(1.8);
    });

    it('false positive rate far above target -> TOO_AGGRESSIVE, raises restrict threshold', () => {
        const result = optimizePolicyThresholds({
            currentRestrictThreshold: 1.8,
            currentReviewThreshold: 0.8,
            observedFalsePositiveRate: 0.2,
            targetMaxFalsePositiveRate: 0.1,
            observedSampleCount: 100,
        });
        expect(result.status).toBe('TOO_AGGRESSIVE');
        expect(result.recommendedRestrictThreshold).toBeGreaterThan(1.8);
    });
});

describe('legacy blind-token — HMAC generation + verification + domain separation', () => {
    const secret = 'a-secret-of-at-least-16-chars';

    it('generates and verifies a PRIVATE domain token round-trip', async () => {
        const token = await generateBlindToken('customer@example.com', secret, 'ten_1', 'PRIVATE', 1);
        expect(token.startsWith('SO:v1:priv:ten_1:')).toBe(true);

        const valid = await verifyBlindToken('customer@example.com', token, secret, 'ten_1');
        expect(valid).toBe(true);
    });

    it('same identity, different tenant -> different token (domain separation)', async () => {
        const tokenA = await generateBlindToken('customer@example.com', secret, 'ten_A', 'PRIVATE', 1);
        const tokenB = await generateBlindToken('customer@example.com', secret, 'ten_B', 'PRIVATE', 1);
        expect(tokenA).not.toBe(tokenB);
    });

    it('verification fails against wrong tenant scope', async () => {
        const token = await generateBlindToken('customer@example.com', secret, 'ten_A', 'PRIVATE', 1);
        const valid = await verifyBlindToken('customer@example.com', token, secret, 'ten_B');
        expect(valid).toBe(false);
    });

    it('rejects empty canonical identity', async () => {
        await expect(generateBlindToken('', secret, 'ten_1')).rejects.toThrow();
    });

    it('rejects secret shorter than 16 characters', async () => {
        await expect(generateBlindToken('customer@example.com', 'short', 'ten_1')).rejects.toThrow();
    });
});
