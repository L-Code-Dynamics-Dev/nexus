// Parity testy: Nexus ValidationStageRules/IdentityNormalizationRule/
// AuditLedgerRule vs skutečné legacy SafeOrder 5-stage pipeline funkce
// (connectors/safeorder/legacy/{validation/stages,normalization,audit}/).
//
// durationMs a created_at pole jsou nedeterministická (performance.now(),
// Date.now()) -- testy je z porovnání vylučují (destructure + omit),
// zbytek objektu se porovnává přesně.

import { describe, it, expect } from 'vitest';
import { InputValidationStageRule, SignalValidationStageRule, RiskPolicyStageRule, DecisionActionStageRule } from '../../../domains/safeorder/ValidationStageRules.js';
import { IdentityNormalizationRule } from '../../../domains/safeorder/IdentityNormalizationRule.js';
import { AuditLedgerRule } from '../../../domains/safeorder/AuditLedgerRule.js';
import { validateInputStage } from '../../../connectors/safeorder/legacy/validation/stages/1-input-validator.js';
import { validateSignalsStage } from '../../../connectors/safeorder/legacy/validation/stages/3-signal-validator.js';
import { validateRiskPolicyStage } from '../../../connectors/safeorder/legacy/validation/stages/4-risk-policy-validator.js';
import { validateDecisionActionStage } from '../../../connectors/safeorder/legacy/validation/stages/5-decision-action-validator.js';
import { canonicalizeIdentity } from '../../../connectors/safeorder/legacy/normalization/identity.js';
import { buildAuditRecord } from '../../../connectors/safeorder/legacy/audit/ledger.js';
import type { FraudSignalRecord, TenantRecord, TenantPolicyRecord } from '../../../connectors/safeorder/legacy/core/types.js';
import type { GraphNode } from '../../../connectors/safeorder/legacy/risk-graph/graph.js';
import type { ValidatedRiskPolicyData } from '../../../connectors/safeorder/legacy/validation/stages/4-risk-policy-validator.js';
import type { ValidatedSignalSet } from '../../../connectors/safeorder/legacy/validation/stages/3-signal-validator.js';

const ctx = { tenantId: 'ten_1', ruleVersion: '1' };

function omitDuration<T extends { durationMs: number }>(obj: T) {
    const { durationMs, ...rest } = obj;
    return rest;
}

describe('InputValidationStageRule parity vs legacy validateInputStage', () => {
    const rule = new InputValidationStageRule({ ...ctx, ruleId: 'input-stage-v1' });

    it('matches legacy for a valid payload', () => {
        const payload = { checkoutSessionId: 'sess1', identity: { email: 'a@b.com' }, paymentMethod: 'COD', orderTotal: 100, currency: 'czk' };
        const legacy = validateInputStage(payload);
        const nexus = rule.evaluate(payload);
        expect(omitDuration(nexus)).toEqual(omitDuration(legacy));
    });

    it('matches legacy for an invalid (non-object) payload', () => {
        const legacy = validateInputStage(null);
        const nexus = rule.evaluate(null);
        expect(omitDuration(nexus)).toEqual(omitDuration(legacy));
    });

    it('matches legacy for schema-invalid payload (negative orderTotal)', () => {
        const payload = { checkoutSessionId: 'sess1', identity: {}, paymentMethod: 'COD', orderTotal: -5, currency: 'CZK' };
        const legacy = validateInputStage(payload);
        const nexus = rule.evaluate(payload);
        expect(nexus.passed).toBe(legacy.passed);
        expect(nexus.code).toBe(legacy.code);
    });
});

describe('SignalValidationStageRule parity vs legacy validateSignalsStage', () => {
    const rule = new SignalValidationStageRule({ ...ctx, ruleId: 'signal-stage-v1' });
    const NOW = Date.parse('2026-09-05T00:00:00Z');

    function makeSignal(overrides?: Partial<FraudSignalRecord>): FraudSignalRecord {
        return { id: 's1', tenant_id: 'ten_1', blind_token: 'bt1', key_version: 1, signal_type: 'MANUAL_FLAG', confidence: 0.8, source: 'test', expires_at: NOW + 100000, created_at: NOW, policy_version: 'policy-v1', ...overrides };
    }

    it('matches legacy for valid active signal', () => {
        const input = { tenantId: 'ten_1', rawPrivateSignals: [makeSignal()], now: NOW };
        const legacy = validateSignalsStage(input.tenantId, input.rawPrivateSignals, [], input.now);
        const nexus = rule.evaluate(input);
        expect(omitDuration(nexus)).toEqual(omitDuration(legacy));
    });

    it('matches legacy for cross-tenant signal rejection', () => {
        const input = { tenantId: 'ten_1', rawPrivateSignals: [makeSignal({ tenant_id: 'ten_2' })], now: NOW };
        const legacy = validateSignalsStage(input.tenantId, input.rawPrivateSignals, [], input.now);
        const nexus = rule.evaluate(input);
        expect(nexus.passed).toBe(legacy.passed);
        expect(nexus.code).toBe(legacy.code);
    });

    it('matches legacy for expired signal filtering', () => {
        const input = { tenantId: 'ten_1', rawPrivateSignals: [makeSignal({ expires_at: NOW - 1000 })], now: NOW };
        const legacy = validateSignalsStage(input.tenantId, input.rawPrivateSignals, [], input.now);
        const nexus = rule.evaluate(input);
        expect(omitDuration(nexus)).toEqual(omitDuration(legacy));
    });
});

describe('RiskPolicyStageRule parity vs legacy validateRiskPolicyStage', () => {
    const rule = new RiskPolicyStageRule({ ...ctx, ruleId: 'risk-policy-stage-v1' });
    const signals: ValidatedSignalSet = { validPrivateSignals: [], validNetworkSignals: [], totalActiveCount: 0, filteredExpiredCount: 0 };
    const entityNode: GraphNode = { id: 'n1', tenantId: 'ten_1', type: 'IDENTITY', blindToken: 'bt1', totalOrders: 5, successfulDeliveries: 4, rtoCount: 1, returnCount: 0, totalSpend: 500 };
    const orderParams = { orderTotal: 1000, paymentMethod: 'COD' as const, currency: 'CZK', dataCompleteness: 0.9 };

    it('matches legacy for a typical evaluation', () => {
        const legacy = validateRiskPolicyStage(signals, entityNode, orderParams);
        const nexus = rule.evaluate({ signals, entityNode, orderParams });
        expect(omitDuration(nexus)).toEqual(omitDuration(legacy));
    });

    it('matches legacy with null entityNode (unknown customer)', () => {
        const legacy = validateRiskPolicyStage(signals, null, orderParams);
        const nexus = rule.evaluate({ signals, entityNode: null, orderParams });
        expect(omitDuration(nexus)).toEqual(omitDuration(legacy));
    });
});

describe('DecisionActionStageRule parity vs legacy validateDecisionActionStage', () => {
    const rule = new DecisionActionStageRule({ ...ctx, ruleId: 'decision-action-stage-v1' });
    const tenant: TenantRecord = { id: 'ten_1', platform: 'shoptet', platform_shop_id: 'shop1', status: 'ACTIVE', mode: 'PRIVATE', created_at: 0, updated_at: 0 };
    const riskPolicyData: ValidatedRiskPolicyData = {
        riskScore: 1.0, confidence: 0.7 as any,
        rawDecision: { decision: 'RESTRICT', rawScore: 1.0 as any, calibratedProbability: 0.5 as any, confidence: 0.7 as any, reasonCodes: [], policyVersion: 'policy-v1', calibrationVersion: 'calib-v1-logistic' },
        economics: { currency: 'CZK', currencyMatch: true, actions: {}, recommendedAction: 'ALLOW', estimatedNetSavings: 0, reasoning: '' },
        reasonCodes: [],
    };

    it('matches legacy for active tenant with RESTRICT decision', () => {
        const legacy = validateDecisionActionStage(riskPolicyData, tenant);
        const nexus = rule.evaluate({ riskPolicyData, tenant });
        expect(omitDuration(nexus)).toEqual(omitDuration(legacy));
    });

    it('matches legacy for inactive tenant rejection', () => {
        const suspendedTenant = { ...tenant, status: 'SUSPENDED' as const };
        const legacy = validateDecisionActionStage(riskPolicyData, suspendedTenant);
        const nexus = rule.evaluate({ riskPolicyData, tenant: suspendedTenant });
        expect(omitDuration(nexus)).toEqual(omitDuration(legacy));
    });

    it('matches legacy when human override forces ALLOW', () => {
        const legacy = validateDecisionActionStage(riskPolicyData, tenant, undefined, 'FALSE_POSITIVE');
        const nexus = rule.evaluate({ riskPolicyData, tenant, activeOverrideDecision: 'FALSE_POSITIVE' });
        expect(omitDuration(nexus)).toEqual(omitDuration(legacy));
    });
});

describe('IdentityNormalizationRule parity vs legacy canonicalizeIdentity', () => {
    const rule = new IdentityNormalizationRule({ ...ctx, ruleId: 'identity-norm-v1' });

    it('matches legacy for phone+email+address', () => {
        const identity = { phone: '777123456', email: 'Test@Example.com', street: 'Hlavní 12', zip: '100 00', country: 'CZ' };
        expect(rule.evaluate({ identity })).toBe(canonicalizeIdentity(identity));
    });

    it('throws matching legacy when no identity attribute provided', () => {
        const emptyIdentity = { country: 'CZ' };
        expect(() => rule.evaluate({ identity: emptyIdentity })).toThrow();
        expect(() => canonicalizeIdentity(emptyIdentity)).toThrow();
    });
});

describe('AuditLedgerRule parity vs legacy buildAuditRecord', () => {
    const rule = new AuditLedgerRule({ ...ctx, ruleId: 'audit-ledger-v1' });

    it('matches legacy (excluding created_at timestamp)', () => {
        const input = {
            decisionId: 'dec_1', tenantId: 'ten_1', platform: 'shoptet' as const, blindToken: 'bt1',
            decision: { decision: 'RESTRICT' as const, rawScore: 1.0 as any, calibratedProbability: 0.5 as any, confidence: 0.7 as any, reasonCodes: ['X'], policyVersion: 'policy-v1', calibrationVersion: 'calib-v1-logistic' },
            signalCount: 2,
        };
        const legacy = buildAuditRecord(input);
        const nexus = rule.evaluate(input);
        const { created_at: _legacyCreated, ...legacyRest } = legacy;
        const { created_at: _nexusCreated, ...nexusRest } = nexus;
        expect(nexusRest).toEqual(legacyRest);
    });
});
