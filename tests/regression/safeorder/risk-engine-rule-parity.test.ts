import { describe, it, expect } from 'vitest';
import { RiskEngineRule } from '../../../domains/safeorder/RiskEngineRule.js';
import { evaluateRisk, type RiskEvaluationInput } from '../../../connectors/safeorder/legacy/risk-engine/engine.js';
import type { FraudSignalRecord, NetworkSignalRecord } from '../../../connectors/safeorder/legacy/core/types.js';

const rule = new RiskEngineRule({ tenantId: 'ten_1', ruleId: 'risk-engine-v1', ruleVersion: '1' });
const NOW = Date.parse('2026-09-05T00:00:00Z');

function makeSignal(overrides?: Partial<FraudSignalRecord>): FraudSignalRecord {
    return {
        id: 'sig1', tenant_id: 'ten_1', blind_token: 'bt1', key_version: 1,
        signal_type: 'UNCOLLECTED_SHIPMENT', confidence: 0.9, source: 'test',
        created_at: NOW - 1000 * 60 * 60 * 24, // 1 day ago
        expires_at: NOW + 1000 * 60 * 60 * 24 * 90,
        policy_version: 'policy-v1',
        ...overrides,
    };
}

describe('RiskEngineRule parity vs legacy evaluateRisk', () => {
    const scenarios: { name: string; input: RiskEvaluationInput }[] = [
        { name: 'no signals at all', input: { privateSignals: [], now: NOW } },
        { name: 'single fresh UNCOLLECTED_SHIPMENT signal', input: { privateSignals: [makeSignal()], now: NOW } },
        { name: 'FALSE_POSITIVE compensation reduces score', input: { privateSignals: [makeSignal(), makeSignal({ signal_type: 'FALSE_POSITIVE', confidence: 1.0 })], now: NOW } },
        { name: 'expired signal is ignored', input: { privateSignals: [makeSignal({ expires_at: NOW - 1000 })], now: NOW } },
        {
            name: 'network signals capped at 0.5 weight',
            input: {
                privateSignals: [],
                networkSignals: [{ id: 'n1', blind_token: 'bt1', contributing_tenant_id: 'ten_2', signal_type: 'x', weight: 5.0, created_at: NOW, expires_at: NOW + 100000 } as NetworkSignalRecord],
                now: NOW,
            },
        },
        {
            name: 'old signal heavily decayed (past half-life)',
            input: { privateSignals: [makeSignal({ created_at: NOW - 1000 * 60 * 60 * 24 * 90 })], now: NOW },
        },
        {
            name: 'full context with historical orders and completeness',
            input: { privateSignals: [makeSignal()], historicalOrders: 10, successfulDeliveries: 9, rtoCount: 1, dataCompleteness: 1.0, now: NOW },
        },
    ];

    for (const s of scenarios) {
        it(`matches legacy for scenario: ${s.name}`, () => {
            const legacy = evaluateRisk(s.input);
            const nexus = rule.evaluate(s.input);
            expect(nexus).toEqual(legacy);
        });
    }
});
