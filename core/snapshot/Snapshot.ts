// Snapshot/Rollback Framework -- core/snapshot/, Fáze 0 (docs/MIGRATION_PLAN.md).
// NEW BUILD s explicitní opravou root cause, ne migrace 1:1.
//
// Legacy vzor (~/okfish-pricing-engine/cloudflare-worker/src/cli/
// backup-all-pricelists.ts:5,47-50 a reset-cap-outside-brandlist.ts:103-109):
// CLI skript zapíše `JSON.stringify(stav)` do `./.snapshots/<jméno>_<timestamp>.json`
// PŘED rizikovou operací. Kontrakt je: (1) create snapshot, (2) proveď
// riskantní zápis, (3) pokud něco selže, ČLOVĚK ručně otevře JSON soubor
// a ručně obrátí zápis -- v repu NIKDE není programový `restore()`, jen
// `create()`. Fingovanost (viz project_okfish_pricing_engine_inc012 paměť):
// `./.snapshots` je CWD-relative cesta, na CI/Cloudflare Workeru je to
// efemérní disk -- po skončení běhu snapshot zmizí, "rollback point" tedy
// ve skutečnosti neexistuje, jakmile proces skončí.
//
// TVRDÉ ARCHITEKTONICKÉ PRAVIDLO: core/snapshot/ definuje jen KONTRAKT
// (SnapshotStore interface). Žádná konkrétní implementace zde nesmí psát
// na lokální/efemérní disk. Produkční implementace (R2, nebo ekvivalentní
// perzistentní object storage) patří do connectors/ nebo platform vrstvy,
// NIKDY do core/ -- stejné pravidlo jako core/tenant "Core nesmí obsahovat
// if ERP === ...": core nezná konkrétní storage backend, jen kontrakt.
//
// Fingerprint konvence konzistentní s Decision.fingerprint,
// Execution.requestFingerprint a AuditHashSet (core/audit/AuditRecord.ts).
// Snapshot lifecycle je stavový -- postaveno na core/state-machine
// StateAxisDefinition, stejný vzor jako core/idempotency
// IDEMPOTENCY_STATE_DEFINITION.

import type { StateAxisDefinition } from '../state-machine/StateMachine.js';

/**
 * Lifecycle jednoho snapshotu. `CREATED` -- zapsán, ještě neověřen.
 * `VERIFIED` -- integrita (hash) ověřena po zápisu, bezpečné k restore.
 * `RESTORED` -- byl použit k rollbacku (terminální -- jednou použitý
 * snapshot k rollbacku se znovu nepoužívá, vytvoří se nový před další
 * rizikovou operací). `EXPIRED` -- překročil retenci, k dispozici jen
 * pro audit, ne pro restore.
 */
export type SnapshotState = 'CREATED' | 'VERIFIED' | 'RESTORED' | 'EXPIRED';

export const SNAPSHOT_STATE_DEFINITION: StateAxisDefinition<SnapshotState> = {
    axisName: 'snapshotState',
    initialState: 'CREATED',
    terminalStates: ['RESTORED', 'EXPIRED'],
    transitions: {
        CREATED: ['VERIFIED', 'EXPIRED'],
        VERIFIED: ['RESTORED', 'EXPIRED'],
        RESTORED: [],
        EXPIRED: [],
    },
};

/**
 * Jeden snapshot stavu `T` PŘED rizikovou operací. `retainUntil` je
 * POVINNÉ a EXPLICITNÍ (na rozdíl od legacy, kde retence byla implicitně
 * "dokud někdo ručně nesmaže .snapshots/ adresář") -- volající musí vždy
 * vědomě rozhodnout, jak dlouho se snapshot má uchovat.
 */
export interface Snapshot<T> {
    readonly snapshotId: string;
    readonly tenantId: string;
    readonly label: string; // lidsky čitelný účel, ekvivalent legacy "full_backup"/"reset_cap_rollback" prefixu
    readonly payload: T;
    readonly payloadHash: string; // integrita -- ne důkaz autorství, jen detekce poškození/driftu
    readonly createdAt: string; // ISO 8601
    readonly retainUntil: string; // ISO 8601 -- POVINNÉ, nahrazuje legacy "navždy dokud nesmažeš ručně"
    state: SnapshotState;
}

/**
 * SnapshotStore -- kontrakt, který MUSÍ implementovat perzistentní storage
 * (R2 nebo ekvivalent). ŽÁDNÁ implementace v core/ nesmí zapisovat na
 * lokální/efemérní disk (CWD-relative cesta, /tmp, CI runner disk) --
 * to by přesně reprodukovalo INC-012 root cause. `restore()` je záměrně
 * SOUČÁST kontraktu (na rozdíl od legacy, kde restore byl jen manuální
 * postup člověka) -- rollback musí být programově proveditelný a testovaný,
 * ne "otevři JSON a oprav to ručně".
 */
export interface SnapshotStore {
    create<T>(tenantId: string, label: string, payload: T, retainUntil: string): Promise<Snapshot<T>>;
    get<T>(tenantId: string, snapshotId: string): Promise<Snapshot<T> | undefined>;
    /**
     * Vrátí payload snapshotu jako "co se má obnovit" a přepne stav na
     * `RESTORED` (terminální). NESMÍ sám provádět zápis zpět do cílového
     * systému (Shoptet apod.) -- to je odpovědnost volajícího/connectoru,
     * SnapshotStore jen poskytuje ověřená data a mění lifecycle stav.
     */
    restore<T>(tenantId: string, snapshotId: string): Promise<Snapshot<T>>;
    list(tenantId: string, options?: { includeExpired?: boolean }): Promise<readonly Snapshot<unknown>[]>;
}

/**
 * IN-MEMORY REFERENČNÍ IMPLEMENTACE -- VÝHRADNĚ PRO TESTY.
 *
 * NIKDY nenasazovat do produkce. In-memory snapshot store nepřežije
 * restart procesu/Workeru -- to je PŘESNĚ ta samá třída chyby jako
 * legacy `.snapshots/` na efemérním CI disku (INC-012), jen jiná
 * konkrétní podoba "storage, co zmizí, když ho nejvíc potřebuješ".
 * `isProductionSafe: false` je typový marker, ne jen komentář --
 * volající kód (např. deploy check) může na tomhle poli explicitně
 * selhat, pokud se tahle třída omylem dostane do produkční konfigurace.
 */
export class InMemorySnapshotStore implements SnapshotStore {
    public readonly isProductionSafe = false as const;

    private snapshots = new Map<string, Snapshot<unknown>>();

    async create<T>(tenantId: string, label: string, payload: T, retainUntil: string): Promise<Snapshot<T>> {
        const snapshotId = `snap_${tenantId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const snapshot: Snapshot<T> = {
            snapshotId,
            tenantId,
            label,
            payload,
            payloadHash: await hashPayload(payload),
            createdAt: new Date().toISOString(),
            retainUntil,
            state: 'CREATED',
        };
        this.snapshots.set(snapshotId, snapshot as Snapshot<unknown>);
        return snapshot;
    }

    async get<T>(tenantId: string, snapshotId: string): Promise<Snapshot<T> | undefined> {
        const snapshot = this.snapshots.get(snapshotId);
        if (!snapshot || snapshot.tenantId !== tenantId) return undefined;
        return snapshot as Snapshot<T>;
    }

    async restore<T>(tenantId: string, snapshotId: string): Promise<Snapshot<T>> {
        const snapshot = await this.get<T>(tenantId, snapshotId);
        if (!snapshot) {
            throw new Error(`Snapshot "${snapshotId}" not found for tenant "${tenantId}"`);
        }
        if (snapshot.state === 'RESTORED') {
            throw new Error(`Snapshot "${snapshotId}" was already restored -- terminal state, create a new snapshot before the next risky operation`);
        }
        if (snapshot.state === 'EXPIRED') {
            throw new Error(`Snapshot "${snapshotId}" is expired (retainUntil passed) -- not safe to restore, audit-only`);
        }
        const restored: Snapshot<T> = { ...snapshot, state: 'RESTORED' };
        this.snapshots.set(snapshotId, restored as Snapshot<unknown>);
        return restored;
    }

    async list(tenantId: string, options?: { includeExpired?: boolean }): Promise<readonly Snapshot<unknown>[]> {
        const all = [...this.snapshots.values()].filter((s) => s.tenantId === tenantId);
        if (options?.includeExpired) return all;
        return all.filter((s) => s.state !== 'EXPIRED');
    }

    /**
     * Testovací pomocná metoda -- ne součást SnapshotStore kontraktu.
     * Reálná implementace by expiraci vyhodnocovala podle `retainUntil`
     * vs. aktuální čas (např. cron/scheduled worker), ne ručním voláním.
     */
    async expireIfPastRetention(tenantId: string, snapshotId: string, now: Date): Promise<void> {
        const snapshot = await this.get(tenantId, snapshotId);
        if (!snapshot) return;
        if (snapshot.state === 'RESTORED') return; // terminální, expirace se netýká
        if (new Date(snapshot.retainUntil).getTime() <= now.getTime()) {
            this.snapshots.set(snapshotId, { ...snapshot, state: 'EXPIRED' });
        }
    }
}

async function hashPayload(payload: unknown): Promise<string> {
    const json = JSON.stringify(payload);
    const encoder = new TextEncoder();
    const data = encoder.encode(json);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
