// Execution -- odděluje Decision od skutečného zápisu. Referenční vzor:
// Pricing Engine PricelistWriter (post-write verifikace), jediné plně
// runtime-verified execution v legacy portfoliu.
//
// TVRDÉ PRAVIDLO: Execution se NESMÍ považovat za úspěšnou jen proto, že
// connector nevrátil chybu. Shoptet support (dnešní ticket) potvrdil:
// HTTP 200 negarantuje persistovanou změnu. Úspěch potvrzuje AŽ
// POST/Outcome + Reconciliation (viz reconciliation/Reconciliation.ts).

export type ExecutionStatus =
    | 'PENDING'
    | 'SENT' // connector nevrátil chybu -- NENÍ totéž jako CONFIRMED
    | 'CONFIRMED' // reconciliation potvrdila Expected == Actual
    | 'FAILED'
    | 'RETRYING';

export type RetryPolicy = 'RETRYABLE' | 'NON_RETRYABLE' | 'MANUAL_REQUIRED';

export interface Execution<TExpected = unknown, TActual = unknown> {
    readonly executionId: string;
    readonly tenantId: string;
    readonly decisionId: string;
    readonly connectorId: string;
    readonly attempt: number;
    status: ExecutionStatus;
    readonly startedAt: string;
    completedAt?: string;
    /** Determinismus a idempotence -- stejný Decision + attempt musí dát stejný fingerprint. */
    readonly requestFingerprint: string;
    /** Reference vrácená connectorem (Shoptet requestId, apod.), NE důkaz úspěchu. */
    externalReference?: string;
    error?: string;
    readonly retryPolicy: RetryPolicy;

    readonly expected?: TExpected;
    actual?: TActual;
}

/**
 * SENT != CONFIRMED. Toto rozlišení je architektonicky vynucené typem --
 * kód, co čte Execution.status, se NESMÍ spokojit s 'SENT' jako důkazem
 * úspěchu (přesně ten bug, co dnešní Shoptet ticket popisuje).
 */
export function isConfirmedSuccess(execution: Execution): boolean {
    return execution.status === 'CONFIRMED';
}
