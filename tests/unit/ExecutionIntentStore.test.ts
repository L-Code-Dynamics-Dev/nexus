// ExecutionIntentStore -- perzistence Execution vrstvy (P1).
//
// Testy se soustředí na dvě věci, které nesou pravidla, ne data:
//   1. `claimForExecution` je ATOMICKÝ -- dva paralelní běhy nesmí nárokovat
//      tentýž Intent. Kdyby mohly, zapsalo by se do vnějšího systému dvakrát.
//   2. `findRequiringReconciliation` nesmí zapomenout na EXECUTED
//      s LOG_INFERRED -- to je Omega "úspěch odvozený z logu", který se
//      bez ověření nesmí brát jako fakt.

import { describe, it, expect, beforeEach } from 'vitest';
import {
    InMemoryExecutionIntentStore,
    type PlanIntentInput,
} from '../../core/canonical/outcomes/ExecutionIntentStore.js';
import type { TenantContext } from '../../core/tenant/types.js';

const TENANT: TenantContext = { tenantId: 'tenant-a', platform: 'shoptet' };
const OTHER_TENANT: TenantContext = { tenantId: 'tenant-b', platform: 'shoptet' };

function planInput(overrides: Partial<PlanIntentInput> = {}): PlanIntentInput {
    return {
        id: 'intent-1',
        decisionId: 'decision-1',
        domain: 'pricing',
        connectorType: 'shoptet',
        operation: 'UPDATE_PRICE',
        targetRef: 'product-123',
        payload: { price: 199 },
        expectedState: { price: 199 },
        idempotencyKey: 'pricing:UPDATE_PRICE:product-123:decision-1',
        plannedAt: '2026-09-07T04:00:00Z',
        ...overrides,
    };
}

describe('plan -- idempotence', () => {
    let store: InMemoryExecutionIntentStore;
    beforeEach(() => {
        store = new InMemoryExecutionIntentStore();
    });

    it('naplánuje Intent ve stavu PLANNED s pokusem 1', async () => {
        const { intent, alreadyPlanned } = await store.plan(TENANT, planInput());

        expect(alreadyPlanned).toBe(false);
        expect(intent.state).toBe('PLANNED');
        expect(intent.attempt).toBe(1);
        expect(intent.tenantId).toBe('tenant-a');
    });

    it('tentýž idempotencyKey vrátí PŮVODNÍ Intent, nezaloží druhý', async () => {
        const first = await store.plan(TENANT, planInput({ id: 'intent-1' }));
        const second = await store.plan(TENANT, planInput({ id: 'intent-2' }));

        expect(second.alreadyPlanned).toBe(true);
        expect(second.intent.id).toBe(first.intent.id);
        // Druhé id se nesmí uchytit -- jinak by ve frontě ležely dva zápisy
        // téhož do vnějšího systému.
        expect(await store.findById('tenant-a', 'intent-2')).toBeUndefined();
    });

    it('stejný idempotencyKey u JINÉHO tenanta je jiný Intent', async () => {
        await store.plan(TENANT, planInput({ id: 'intent-a' }));
        const other = await store.plan(OTHER_TENANT, planInput({ id: 'intent-b' }));

        expect(other.alreadyPlanned).toBe(false);
        expect(other.intent.id).toBe('intent-b');
    });

    it('odmítne hardcoded/placeholder tenanta', async () => {
        await expect(
            store.plan({ tenantId: 'ten_1', platform: 'shoptet' }, planInput()),
        ).rejects.toThrow();
    });
});

describe('claimForExecution -- atomické nárokování', () => {
    let store: InMemoryExecutionIntentStore;
    beforeEach(async () => {
        store = new InMemoryExecutionIntentStore();
        await store.plan(TENANT, planInput());
    });

    it('PLANNED -> CLAIMED se stavem EXECUTING', async () => {
        const result = await store.claimForExecution(TENANT, 'intent-1', '2026-09-07T04:00:30Z');

        expect(result.outcome).toBe('CLAIMED');
        if (result.outcome === 'CLAIMED') {
            expect(result.intent.state).toBe('EXECUTING');
        }
    });

    it('druhý pokus o nárokování dostane ALREADY_EXECUTING', async () => {
        // Tohle je jádro atomicity: dva běhy, právě jeden smí zapisovat.
        await store.claimForExecution(TENANT, 'intent-1', '2026-09-07T04:00:30Z');
        const second = await store.claimForExecution(TENANT, 'intent-1', '2026-09-07T04:00:30Z');

        expect(second.outcome).toBe('ALREADY_EXECUTING');
    });

    it('paralelní nárokování: právě jeden uspěje', async () => {
        const results = await Promise.all([
            store.claimForExecution(TENANT, 'intent-1', '2026-09-07T04:00:30Z'),
            store.claimForExecution(TENANT, 'intent-1', '2026-09-07T04:00:30Z'),
            store.claimForExecution(TENANT, 'intent-1', '2026-09-07T04:00:30Z'),
        ]);

        expect(results.filter((r) => r.outcome === 'CLAIMED')).toHaveLength(1);
    });

    it('hotový Intent (EXECUTED) se nedá nárokovat znovu', async () => {
        await store.claimForExecution(TENANT, 'intent-1', '2026-09-07T04:00:30Z');
        await store.recordOutcome(TENANT, {
            intentId: 'intent-1',
            nextState: 'EXECUTED',
            confirmationQuality: 'SYSTEM_CONFIRMED',
            recordedAt: '2026-09-07T04:01:00Z',
        });

        const result = await store.claimForExecution(TENANT, 'intent-1', '2026-09-07T04:00:30Z');
        expect(result.outcome).toBe('WRONG_STATE');
        if (result.outcome === 'WRONG_STATE') {
            expect(result.currentState).toBe('EXECUTED');
        }
    });

    it('retry po FAILED inkrementuje attempt, nezakládá nový Intent', async () => {
        await store.claimForExecution(TENANT, 'intent-1', '2026-09-07T04:00:30Z');
        await store.recordOutcome(TENANT, {
            intentId: 'intent-1',
            nextState: 'FAILED',
            failureReason: 'timeout',
            recordedAt: '2026-09-07T04:01:00Z',
        });

        const retry = await store.claimForExecution(TENANT, 'intent-1', '2026-09-07T04:00:30Z');
        expect(retry.outcome).toBe('CLAIMED');
        if (retry.outcome === 'CLAIMED') {
            // Historie pokusů se drží na jednom Intentu, ne rozsypaná
            // přes několik záznamů.
            expect(retry.intent.attempt).toBe(2);
        }
    });

    it('cizí tenant dostane NOT_FOUND, ne chybu', async () => {
        // Rozdíl v odpovědi by prozradil existenci Intentů napříč tenanty.
        const result = await store.claimForExecution(OTHER_TENANT, 'intent-1', '2026-09-07T04:00:30Z');
        expect(result.outcome).toBe('NOT_FOUND');
    });
});

describe('recordOutcome -- fail-closed přechody', () => {
    let store: InMemoryExecutionIntentStore;
    beforeEach(async () => {
        store = new InMemoryExecutionIntentStore();
        await store.plan(TENANT, planInput());
        await store.claimForExecution(TENANT, 'intent-1', '2026-09-07T04:00:30Z');
    });

    it('EXECUTED bez confirmationQuality se odmítne', async () => {
        // Odpovídá CHECK constraintu v migraci 0003. Bez kvality potvrzení
        // by se nevědělo, jestli výsledek vyžaduje reconciliaci.
        await expect(
            store.recordOutcome(TENANT, {
                intentId: 'intent-1',
                nextState: 'EXECUTED',
                recordedAt: '2026-09-07T04:01:00Z',
            }),
        ).rejects.toThrow(/vyžaduje confirmationQuality/);
    });

    it('nedovolený přechod se odmítne', async () => {
        await store.recordOutcome(TENANT, {
            intentId: 'intent-1',
            nextState: 'EXECUTED',
            confirmationQuality: 'SYSTEM_CONFIRMED',
            recordedAt: '2026-09-07T04:01:00Z',
        });

        await expect(
            store.recordOutcome(TENANT, {
                intentId: 'intent-1',
                nextState: 'FAILED',
                recordedAt: '2026-09-07T04:02:00Z',
            }),
        ).rejects.toThrow(/není dovolený/);
    });

    it('UNKNOWN -> EXECUTED je dovolený (reconciliace dorovná stav)', async () => {
        await store.recordOutcome(TENANT, {
            intentId: 'intent-1',
            nextState: 'UNKNOWN',
            failureReason: 'timeout',
            recordedAt: '2026-09-07T04:01:00Z',
        });

        await expect(
            store.recordOutcome(TENANT, {
                intentId: 'intent-1',
                nextState: 'EXECUTED',
                confirmationQuality: 'SYSTEM_CONFIRMED',
                recordedAt: '2026-09-07T04:05:00Z',
            }),
        ).resolves.toBeUndefined();
    });
});

describe('findRequiringReconciliation -- fronta nejistot', () => {
    let store: InMemoryExecutionIntentStore;
    beforeEach(() => {
        store = new InMemoryExecutionIntentStore();
    });

    async function seed(id: string, key: string): Promise<void> {
        await store.plan(TENANT, planInput({ id, idempotencyKey: key }));
        await store.claimForExecution(TENANT, id, '2026-09-07T04:00:30Z');
    }

    it('zahrne UNKNOWN', async () => {
        await seed('i-unknown', 'k1');
        await store.recordOutcome(TENANT, {
            intentId: 'i-unknown',
            nextState: 'UNKNOWN',
            failureReason: 'timeout',
            recordedAt: '2026-09-07T04:01:00Z',
        });

        const queue = await store.findRequiringReconciliation('tenant-a', 10);
        expect(queue.map((i) => i.id)).toContain('i-unknown');
    });

    it('zahrne EXECUTED s LOG_INFERRED -- Omega "úspěch" z logu není fakt', async () => {
        await seed('i-omega', 'k2');
        await store.recordOutcome(TENANT, {
            intentId: 'i-omega',
            nextState: 'EXECUTED',
            confirmationQuality: 'LOG_INFERRED',
            recordedAt: '2026-09-07T04:01:00Z',
        });

        const queue = await store.findRequiringReconciliation('tenant-a', 10);
        expect(queue.map((i) => i.id)).toContain('i-omega');
    });

    it('NEzahrne EXECUTED se SYSTEM_CONFIRMED', async () => {
        await seed('i-pohoda', 'k3');
        await store.recordOutcome(TENANT, {
            intentId: 'i-pohoda',
            nextState: 'EXECUTED',
            confirmationQuality: 'SYSTEM_CONFIRMED',
            recordedAt: '2026-09-07T04:01:00Z',
        });

        const queue = await store.findRequiringReconciliation('tenant-a', 10);
        expect(queue.map((i) => i.id)).not.toContain('i-pohoda');
    });

    it('NEzahrne FAILED -- prokazatelně se nic nezapsalo', async () => {
        await seed('i-failed', 'k4');
        await store.recordOutcome(TENANT, {
            intentId: 'i-failed',
            nextState: 'FAILED',
            failureReason: 'validation',
            recordedAt: '2026-09-07T04:01:00Z',
        });

        const queue = await store.findRequiringReconciliation('tenant-a', 10);
        expect(queue.map((i) => i.id)).not.toContain('i-failed');
    });

    it('nemíchá tenanty', async () => {
        await seed('i-mine', 'k5');
        await store.recordOutcome(TENANT, {
            intentId: 'i-mine',
            nextState: 'UNKNOWN',
            failureReason: 'x',
            recordedAt: '2026-09-07T04:01:00Z',
        });

        expect(await store.findRequiringReconciliation('tenant-b', 10)).toHaveLength(0);
    });
});

describe('findPending -- fronta k provedení', () => {
    it('vrací PLANNED, ne EXECUTING ani hotové', async () => {
        const store = new InMemoryExecutionIntentStore();
        await store.plan(TENANT, planInput({ id: 'i-1', idempotencyKey: 'k1' }));
        await store.plan(TENANT, planInput({ id: 'i-2', idempotencyKey: 'k2' }));
        await store.claimForExecution(TENANT, 'i-2', '2026-09-07T04:00:30Z');

        const pending = await store.findPending('tenant-a', 10);
        expect(pending.map((i) => i.id)).toEqual(['i-1']);
    });
});
