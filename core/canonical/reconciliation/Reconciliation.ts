// Reconciliation -- referenční vzor: Pricing Engine Stage 5
// (reconcile-pricelist-drift.ts), jediné plně runtime-verified
// reconciliation v legacy portfoliu.
//
// SOURCE -> DECISION -> EXPECTED -> EXECUTION -> ACTUAL -> RECONCILIATION
//
// TVRDÉ PRAVIDLO (Error Isolation, master prompt §8, potvrzeno napříč
// auditem): chyba JEDNÉ položky nesmí shodit celý batch.
//   10 000 položek, 9997 OK, 2 FAILED, 1 MANUAL_REVIEW
//     -> batch COMPLETE_WITH_ERRORS, NIKDY "1 chyba -> STOP".

export type ReconciliationOutcome =
    | 'MATCHED'
    | 'DIFF'
    | 'FAILED'
    | 'UNKNOWN'
    | 'MANUAL_REVIEW'
    | 'RESOLVED';

export interface ReconciliationItemResult<T = unknown> {
    readonly itemId: string;
    readonly expected: T;
    readonly actual: T | null;
    readonly outcome: ReconciliationOutcome;
    readonly diff?: string;
}

export type BatchStatus = 'COMPLETE' | 'COMPLETE_WITH_ERRORS' | 'FAILED_SYSTEMIC';

export interface ReconciliationBatchResult<T = unknown> {
    readonly tenantId: string;
    readonly items: ReconciliationItemResult<T>[];
    readonly status: BatchStatus;
}

/**
 * Agreguje per-item výsledky na batch status. Per-item FAILED/MANUAL_REVIEW
 * NIKDY nezpůsobí FAILED_SYSTEMIC -- to je vyhrazeno pro systémovou chybu
 * (poškozený export, tenant isolation breach, atd. -- master prompt §8),
 * ne pro součet jednotlivých položkových chyb.
 */
export function aggregateBatchStatus<T>(items: ReconciliationItemResult<T>[]): BatchStatus {
    const hasErrors = items.some((i) => i.outcome === 'FAILED' || i.outcome === 'MANUAL_REVIEW' || i.outcome === 'DIFF');
    return hasErrors ? 'COMPLETE_WITH_ERRORS' : 'COMPLETE';
}
