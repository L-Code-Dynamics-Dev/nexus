// core/snapshot/Snapshot.ts testy. Reprodukuje legacy kontrakt
// (~/okfish-pricing-engine/cloudflare-worker/src/cli/backup-all-pricelists.ts,
// reset-cap-outside-brandlist.ts) -- create PŘED riskantní operací,
// ale s programovým restore() a explicitní retencí, ne manuální JSON
// editací a implicitní "dokud nesmažeš .snapshots/ adresář".

import { describe, it, expect } from 'vitest';
import { InMemorySnapshotStore } from '../../core/snapshot/Snapshot.js';

describe('InMemorySnapshotStore — create + restore cyklus', () => {
    it('create uloží payload a vrátí snapshot ve stavu CREATED', async () => {
        const store = new InMemorySnapshotStore();
        const retainUntil = new Date(Date.now() + 86400_000).toISOString();

        const snapshot = await store.create('ten_1', 'full_backup', { pricelists: { ZR20: '29' } }, retainUntil);

        expect(snapshot.state).toBe('CREATED');
        expect(snapshot.tenantId).toBe('ten_1');
        expect(snapshot.label).toBe('full_backup');
        expect(snapshot.payloadHash).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex
    });

    it('restore vrátí payload a přepne stav na RESTORED (rollback point)', async () => {
        const store = new InMemorySnapshotStore();
        const retainUntil = new Date(Date.now() + 86400_000).toISOString();
        const original = { pricelists: { ZR20: '29' } };

        const created = await store.create('ten_1', 'reset_cap_rollback', original, retainUntil);
        const restored = await store.restore<typeof original>('ten_1', created.snapshotId);

        expect(restored.payload).toEqual(original);
        expect(restored.state).toBe('RESTORED');
    });

    it('restore na už RESTORED snapshotu odmítne (terminální stav)', async () => {
        const store = new InMemorySnapshotStore();
        const retainUntil = new Date(Date.now() + 86400_000).toISOString();
        const created = await store.create('ten_1', 'test', { a: 1 }, retainUntil);

        await store.restore('ten_1', created.snapshotId);

        await expect(store.restore('ten_1', created.snapshotId)).rejects.toThrow(/already restored/);
    });

    it('cross-tenant get/restore nevrátí cizí snapshot (tenant isolation)', async () => {
        const store = new InMemorySnapshotStore();
        const retainUntil = new Date(Date.now() + 86400_000).toISOString();
        const created = await store.create('ten_A', 'secret', { data: 'A-only' }, retainUntil);

        const wrongTenantGet = await store.get('ten_B', created.snapshotId);
        expect(wrongTenantGet).toBeUndefined();

        await expect(store.restore('ten_B', created.snapshotId)).rejects.toThrow(/not found/);
    });
});

describe('InMemorySnapshotStore — expirace/TTL', () => {
    it('expireIfPastRetention přepne stav na EXPIRED, pokud retainUntil uplynul', async () => {
        const store = new InMemorySnapshotStore();
        const alreadyPast = new Date(Date.now() - 1000).toISOString();
        const created = await store.create('ten_1', 'old_backup', { a: 1 }, alreadyPast);

        await store.expireIfPastRetention('ten_1', created.snapshotId, new Date());

        const fetched = await store.get('ten_1', created.snapshotId);
        expect(fetched?.state).toBe('EXPIRED');
    });

    it('restore na EXPIRED snapshotu odmítne (audit-only, ne bezpečné k obnově)', async () => {
        const store = new InMemorySnapshotStore();
        const alreadyPast = new Date(Date.now() - 1000).toISOString();
        const created = await store.create('ten_1', 'old_backup', { a: 1 }, alreadyPast);
        await store.expireIfPastRetention('ten_1', created.snapshotId, new Date());

        await expect(store.restore('ten_1', created.snapshotId)).rejects.toThrow(/expired/);
    });

    it('list bez includeExpired vynechá expirované snapshoty, s ním je zahrne', async () => {
        const store = new InMemorySnapshotStore();
        const alreadyPast = new Date(Date.now() - 1000).toISOString();
        const stillValid = new Date(Date.now() + 86400_000).toISOString();

        const expired = await store.create('ten_1', 'old', { a: 1 }, alreadyPast);
        await store.create('ten_1', 'fresh', { b: 2 }, stillValid);
        await store.expireIfPastRetention('ten_1', expired.snapshotId, new Date());

        const activeOnly = await store.list('ten_1');
        expect(activeOnly).toHaveLength(1);
        expect(activeOnly[0]?.label).toBe('fresh');

        const withExpired = await store.list('ten_1', { includeExpired: true });
        expect(withExpired).toHaveLength(2);
    });
});

describe('InMemorySnapshotStore — production-safety marker', () => {
    it('isProductionSafe je typový marker false -- deploy check může na tomhle poli explicitně selhat', () => {
        const store = new InMemorySnapshotStore();
        expect(store.isProductionSafe).toBe(false);
    });
});
