// GenericReconciliation -- rozšíření core/canonical/reconciliation/
// Reconciliation.ts (Fáze 0, docs/MIGRATION_PLAN.md). Ten zůstává BEZE
// ZMĚNY -- existující Pricing testy (tests/unit/Reconciliation.test.ts,
// tests/integration/PricingEndToEnd.test.ts) na jeho přesném shape závisí.
// Tento modul stojí VEDLE něj jako obecnější vrstva -- stejný vztah jako
// core/error-isolation/ErrorIsolation.ts vs core/validation/errorIsolation.ts.
//
// Zdroj: ~/okfish-pricing-engine/cloudflare-worker/src/cli/
// reconcile-coupon-drift.ts (Stage 5 vzor, INC-011) -- dva netriviální
// prvky, co core/canonical/reconciliation/Reconciliation.ts nepokrývá:
//
//   1. TOLERANCE-BASED DRIFT: numerické porovnání nesmí být exaktní
//      rovnost -- `RATIO_TOLERANCE = 0.001` kryje zaokrouhlovací chybu
//      (hodnoty psány s `.toFixed(4)`), ne skutečně odlišnou hodnotu.
//      Klasifikace na MATCHED/DRIFT_MINOR/DRIFT_MAJOR, ne jen MATCHED/DIFF.
//
//   2. DEBOUNCE: hodnotový mismatch (ne úplně chybějící položka, ne
//      zamčené pravidlo s nulovou legitimní výjimkou) alertuje AŽ po
//      přetrvání přes DVA samostatné běhy (`.coupon_reconciliation_state.json`
//      vzor) -- hodnota, co se změnila před 10 minutami a ještě ji
//      nestihl vyzvednout příští sync, není bug. Úplně chybějící položka
//      nebo porušení zamčeného pravidla alertuje OKAMŽITĚ, bez debounce.

import type { ReconciliationOutcome, ReconciliationItemResult, BatchStatus } from '../canonical/reconciliation/Reconciliation.js';
import { aggregateBatchStatus } from '../canonical/reconciliation/Reconciliation.js';

export type DriftSeverity = 'MATCHED' | 'DRIFT_MINOR' | 'DRIFT_MAJOR';

/**
 * Klasifikuje numerický rozdíl podle tolerance -- `MATCHED` uvnitř
 * tolerance (zaokrouhlovací šum), `DRIFT_MINOR` mimo toleranci, ale pod
 * `majorThreshold`, `DRIFT_MAJOR` nad ním. Reprodukuje
 * reconcile-coupon-drift.ts `RATIO_TOLERANCE` vzor jako reusable funkci.
 */
export function classifyDrift(expected: number, actual: number, tolerance: number, majorThreshold: number): DriftSeverity {
    const diff = Math.abs(expected - actual);
    if (diff <= tolerance) return 'MATCHED';
    return diff <= majorThreshold ? 'DRIFT_MINOR' : 'DRIFT_MAJOR';
}

/**
 * Reprodukuje debounce vzor z `.coupon_reconciliation_state.json`:
 * mismatch se poprvé jen ZAZNAMENÁ (`firstSeenAt`), alertuje se až při
 * druhém po sobě jdoucím běhu se stejným (nebo blížícím se) mismatchem.
 * `immediate: true` obchází debounce úplně -- pro missing item / locked
 * rule violation, kde neexistuje legitimní přechodný stav.
 */
export interface DebouncedMismatch {
    readonly itemKey: string;
    readonly firstSeenAt: string;
    readonly expected: string;
    readonly actual: string;
    readonly immediate: boolean;
}

export type DebounceState = Record<string, DebouncedMismatch>;

export interface DebounceDecision {
    readonly shouldAlert: boolean;
    readonly nextState: DebounceState;
}

/**
 * Vyhodnotí, zda se má mismatch alertovat TEĎ, nebo jen zaznamenat pro
 * příští běh. Čistá funkce -- perzistenci `DebounceState` (soubor, KV,
 * D1, ...) řeší volající, ne tento modul.
 */
export function evaluateDebounce(
    itemKey: string,
    currentMismatch: { expected: string; actual: string; immediate: boolean } | null,
    previousState: DebounceState
): DebounceDecision {
    const nextState: DebounceState = { ...previousState };

    if (currentMismatch === null) {
        // Žádný mismatch v tomto běhu -- vyčistit případný předchozí záznam.
        delete nextState[itemKey];
        return { shouldAlert: false, nextState };
    }

    if (currentMismatch.immediate) {
        // Missing item / locked rule violation -- alert bez debounce, ale
        // i tak zaznamenat (konzistence stavu pro případné budoucí query).
        nextState[itemKey] = { itemKey, firstSeenAt: new Date().toISOString(), ...currentMismatch };
        return { shouldAlert: true, nextState };
    }

    const previous = previousState[itemKey];
    if (previous === undefined) {
        // První výskyt -- zaznamenat, nealertovat.
        nextState[itemKey] = { itemKey, firstSeenAt: new Date().toISOString(), ...currentMismatch };
        return { shouldAlert: false, nextState };
    }

    // Přetrvává přes druhý běh -- alertovat, zachovat původní firstSeenAt.
    nextState[itemKey] = { itemKey, firstSeenAt: previous.firstSeenAt, ...currentMismatch };
    return { shouldAlert: true, nextState };
}

/**
 * Batch napříč VÍCE entity typy najednou (např. jeden sync run
 * reconciliuje Price i Stock položky společně) -- core/canonical/
 * reconciliation/Reconciliation.ts `ReconciliationBatchResult` je vázaný
 * na jeden implicitní typ položky. `entityType` na položce umožňuje
 * agregaci per-typ i celkově, beze změny základního kontraktu.
 */
export interface MultiEntityReconciliationItem<T = unknown> extends ReconciliationItemResult<T> {
    readonly entityType: string;
}

export interface MultiEntityBatchResult<T = unknown> {
    readonly tenantId: string;
    readonly items: MultiEntityReconciliationItem<T>[];
    readonly overallStatus: BatchStatus;
    readonly statusByEntityType: Record<string, BatchStatus>;
}

export function aggregateMultiEntityBatch<T>(tenantId: string, items: MultiEntityReconciliationItem<T>[]): MultiEntityBatchResult<T> {
    const byType = new Map<string, MultiEntityReconciliationItem<T>[]>();
    for (const item of items) {
        const bucket = byType.get(item.entityType) ?? [];
        bucket.push(item);
        byType.set(item.entityType, bucket);
    }

    const statusByEntityType: Record<string, BatchStatus> = {};
    for (const [entityType, bucketItems] of byType) {
        statusByEntityType[entityType] = aggregateBatchStatus(bucketItems);
    }

    return {
        tenantId,
        items,
        overallStatus: aggregateBatchStatus(items),
        statusByEntityType,
    };
}

/**
 * Entita bez perzistovaného baseline (Confirmed Gap #3,
 * core/canonical/CANONICAL-MODEL-CONTRACT.md §7: "Stock/Availability --
 * Projection existuje, ale nikdy se neperzistuje → Reconciliation nemá
 * s čím porovnávat historicky"). `baselineAvailable: false` je explicitní
 * signál -- volající NESMÍ tiše předstírat reconciliaci tam, kde baseline
 * neexistuje; musí to rozlišit od skutečného `MATCHED` výsledku.
 */
export interface HistoricalReconciliationCheckpoint<T = unknown> {
    readonly entityId: string;
    readonly baselineAvailable: boolean;
    readonly baseline?: T;
    readonly current: T;
    readonly checkedAt: string;
}

export function evaluateHistoricalCheckpoint<T>(
    checkpoint: HistoricalReconciliationCheckpoint<T>,
    compare: (baseline: T, current: T) => ReconciliationOutcome
): ReconciliationOutcome {
    if (!checkpoint.baselineAvailable || checkpoint.baseline === undefined) {
        // Bez baseline nelze reconciliovat -- 'UNKNOWN', NIKDY 'MATCHED'.
        return 'UNKNOWN';
    }
    return compare(checkpoint.baseline, checkpoint.current);
}
