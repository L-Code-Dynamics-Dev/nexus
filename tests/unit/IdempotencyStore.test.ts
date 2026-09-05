// core/idempotency testy -- ověřují framework proti reálnému AIE vzoru
// (~/availability-intelligence-engine/src/core/procurement/Workflow.ts,
// PostgresProcurementRepository.ts:90-92). Žádné napojení na produkční kód.

import { describe, it, expect } from 'vitest';
import { InMemoryIdempotencyStore } from '../../core/idempotency/IdempotencyStore.js';

describe('InMemoryIdempotencyStore -- basic claim/complete/fail contract', () => {
    it('claim succeeds on a fresh key', () => {
        const store = new InMemoryIdempotencyStore();
        const result = store.claim({ key: 'evt_1', operation: 'PROCUREMENT_PLAN' });
        expect(result.claimed).toBe(true);
        expect(store.peek({ key: 'evt_1', operation: 'PROCUREMENT_PLAN' })).toBe('PROCESSING');
    });

    it('second claim on the same (key, operation) while PROCESSING is rejected -- only one caller wins', () => {
        const store = new InMemoryIdempotencyStore();
        const ref = { key: 'evt_1', operation: 'PROCUREMENT_PLAN' };

        const first = store.claim(ref);
        const second = store.claim(ref);

        expect(first.claimed).toBe(true);
        expect(second.claimed).toBe(false);
        expect(second.reason).toContain('already exists');
    });

    it('complete() transitions PROCESSING -> COMPLETED', () => {
        const store = new InMemoryIdempotencyStore();
        const ref = { key: 'evt_1', operation: 'PROCUREMENT_PLAN' };
        store.claim(ref);
        store.complete(ref);
        expect(store.peek(ref)).toBe('COMPLETED');
    });

    it('fail() transitions PROCESSING -> FAILED', () => {
        const store = new InMemoryIdempotencyStore();
        const ref = { key: 'evt_1', operation: 'PROCUREMENT_PLAN' };
        store.claim(ref);
        store.fail(ref);
        expect(store.peek(ref)).toBe('FAILED');
    });

    it('claim after COMPLETED is rejected -- terminal state, no re-claim (no TTL/expiry in source system)', () => {
        const store = new InMemoryIdempotencyStore();
        const ref = { key: 'evt_1', operation: 'PROCUREMENT_PLAN' };
        store.claim(ref);
        store.complete(ref);

        const retry = store.claim(ref);
        expect(retry.claimed).toBe(false);
    });

    it('claim after FAILED is rejected -- FAILED is NOT retryable with the same key (matches AIE: no re-claim path exists)', () => {
        const store = new InMemoryIdempotencyStore();
        const ref = { key: 'evt_1', operation: 'PROCUREMENT_PLAN' };
        store.claim(ref);
        store.fail(ref);

        const retry = store.claim(ref);
        expect(retry.claimed).toBe(false);
    });

    it('complete() on a never-claimed key throws (programmer error, not silent no-op)', () => {
        const store = new InMemoryIdempotencyStore();
        expect(() => store.complete({ key: 'never_claimed', operation: 'X' })).toThrow(/never claimed/);
    });

    it('complete() on an already-COMPLETED key throws (terminal, no double-complete)', () => {
        const store = new InMemoryIdempotencyStore();
        const ref = { key: 'evt_1', operation: 'PROCUREMENT_PLAN' };
        store.claim(ref);
        store.complete(ref);
        expect(() => store.complete(ref)).toThrow(/rejected/);
    });

    it('different operation on the same key is independent -- (key, operation) is the composite identity', () => {
        const store = new InMemoryIdempotencyStore();
        const planRef = { key: 'evt_1', operation: 'PROCUREMENT_PLAN' };
        const dispatchRef = { key: 'evt_1', operation: 'DISPATCH_PO' };

        store.claim(planRef);
        const dispatchClaim = store.claim(dispatchRef);

        expect(dispatchClaim.claimed).toBe(true);
        expect(store.peek(planRef)).toBe('PROCESSING');
        expect(store.peek(dispatchRef)).toBe('PROCESSING');
    });

    it('peek on a never-claimed key returns undefined', () => {
        const store = new InMemoryIdempotencyStore();
        expect(store.peek({ key: 'nope', operation: 'X' })).toBeUndefined();
    });
});

describe('InMemoryIdempotencyStore -- reproduces AIE Workflow.createPlan flow', () => {
    // Reprodukuje strukturu ~/availability-intelligence-engine/src/core/
    // procurement/Workflow.ts:17-58 createPlan(): claim(eventId, PLAN) ->
    // práce -> pro každou PO: claim(order.id, DISPATCH_PO) -> dispatch ->
    // complete/fail -> nakonec complete(eventId, PLAN). Test simuluje
    // úspěšný běh i větev, kde jedna PO dispatch selže, ale celkový plán
    // přesto dokončí (per-PO try/catch v původním kódu, chyba se re-throwne
    // AŽ po fail() -- test ověřuje jen store chování, ne re-throw sémantiku).

    it('successful plan: outer claim + two PO dispatch claims all complete', () => {
        const store = new InMemoryIdempotencyStore();
        const eventId = 'evt_2026_09_05';

        expect(store.claim({ key: eventId, operation: 'PROCUREMENT_PLAN' }).claimed).toBe(true);

        expect(store.claim({ key: 'po_1', operation: 'DISPATCH_PO' }).claimed).toBe(true);
        store.complete({ key: 'po_1', operation: 'DISPATCH_PO' });

        expect(store.claim({ key: 'po_2', operation: 'DISPATCH_PO' }).claimed).toBe(true);
        store.complete({ key: 'po_2', operation: 'DISPATCH_PO' });

        store.complete({ key: eventId, operation: 'PROCUREMENT_PLAN' });

        expect(store.peek({ key: eventId, operation: 'PROCUREMENT_PLAN' })).toBe('COMPLETED');
        expect(store.peek({ key: 'po_1', operation: 'DISPATCH_PO' })).toBe('COMPLETED');
        expect(store.peek({ key: 'po_2', operation: 'DISPATCH_PO' })).toBe('COMPLETED');
    });

    it('one PO dispatch fails, outer plan still completes -- independent idempotency keys per PO', () => {
        const store = new InMemoryIdempotencyStore();
        const eventId = 'evt_2026_09_05';

        store.claim({ key: eventId, operation: 'PROCUREMENT_PLAN' });

        store.claim({ key: 'po_1', operation: 'DISPATCH_PO' });
        store.fail({ key: 'po_1', operation: 'DISPATCH_PO' }); // dispatch selhal (network chyba apod.)

        store.claim({ key: 'po_2', operation: 'DISPATCH_PO' });
        store.complete({ key: 'po_2', operation: 'DISPATCH_PO' });

        // Plán jako celek se přesto dokončí -- per-PO selhání neblokuje
        // ostatní PO ani outer PLAN claim (odpovídá per-PO try/catch v AIE zdroji).
        store.complete({ key: eventId, operation: 'PROCUREMENT_PLAN' });

        expect(store.peek({ key: eventId, operation: 'PROCUREMENT_PLAN' })).toBe('COMPLETED');
        expect(store.peek({ key: 'po_1', operation: 'DISPATCH_PO' })).toBe('FAILED');
        expect(store.peek({ key: 'po_2', operation: 'DISPATCH_PO' })).toBe('COMPLETED');
    });

    it('duplicate event (same eventId re-delivered, e.g. webhook retry) is skipped entirely -- matches Workflow.ts:18-21 early return', () => {
        const store = new InMemoryIdempotencyStore();
        const eventId = 'evt_2026_09_05';

        const firstDelivery = store.claim({ key: eventId, operation: 'PROCUREMENT_PLAN' });
        expect(firstDelivery.claimed).toBe(true);
        store.complete({ key: eventId, operation: 'PROCUREMENT_PLAN' });

        // Webhook re-delivery se stejným eventId -- Workflow.ts by zde
        // udělal `if (!claim) { log skip; return undefined; }` bez jakékoliv
        // další práce.
        const redelivery = store.claim({ key: eventId, operation: 'PROCUREMENT_PLAN' });
        expect(redelivery.claimed).toBe(false);
    });
});
