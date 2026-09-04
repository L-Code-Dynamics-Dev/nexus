// StageResult<T> -- společný kontrakt pro všech 5 stages. Viz ValidationFramework.md.

export type StageName = 'INPUT' | 'PARSER' | 'CORE' | 'OUTPUT' | 'POST';
export type StageStatus = 'SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILED' | 'SKIPPED';
export type OutcomeStatus = 'SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILED' | 'MISMATCH' | 'MANUAL_REVIEW' | 'UNKNOWN';

export type ErrorClass = 'RETRYABLE' | 'NON_RETRYABLE' | 'MANUAL_REQUIRED';

export interface StageError {
    readonly recordId: string;
    readonly message: string;
    readonly errorClass: ErrorClass;
}

export interface StageResult<T = unknown> {
    readonly stage: StageName;
    readonly status: StageStatus;
    readonly inputReference: string;
    readonly outputReference?: string;
    readonly processedCount: number;
    readonly successCount: number;
    readonly errorCount: number;
    readonly errors: StageError[];
    readonly warnings: string[];
    readonly startedAt: string;
    readonly completedAt: string;
    /** Determinismus -- hash(input + ruleVersion + tenantConfig). */
    readonly fingerprint: string;
    readonly data?: T;
}

/** Idempotence identita (§9) -- povinná napříč batch i jednotlivým recordem. */
export interface IdempotencyKey {
    readonly tenantId: string;
    readonly batchId: string;
    readonly recordId: string;
    readonly sourceFingerprint: string;
    readonly ruleVersion: string;
}

/** Manual override (§11) -- explicitní, auditovaná, tenant-scoped, idempotentní. */
export interface ManualOverride {
    readonly tenantId: string;
    readonly recordId: string;
    readonly actor: string;
    readonly resolution: string;
    readonly resolvedAt: string;
    /** NIKDY nepřepisuje původní auditní záznam -- jen ho doplňuje. */
    readonly originalErrorReference: string;
}
