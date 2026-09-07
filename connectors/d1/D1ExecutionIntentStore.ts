// D1ExecutionIntentStore -- produkční D1 implementace `ExecutionIntentStore`
// (P1 Execution vrstva, migrations/0003_execution_intents.sql).
//
// UMÍSTĚNÍ: `connectors/d1/`, ne `core/canonical/outcomes/`. Kontrakt to říká
// výslovně -- stejné pravidlo jako u `IdempotencyStore` a `CreditVoucherStore`:
// core drží rozhraní a in-memory referenční implementaci, produkční I/O žije
// v Connector vrstvě.
//
// ============================================================================
// ATOMICITA `claimForExecution` -- proč to není "načti, změň, ulož"
// ============================================================================
// Nárokování Intentu k provedení MUSÍ být jedno atomické UPDATE. Kdyby to byly
// tři kroky, dva paralelní běhy (dva Workery, cron + webhook) by si Intent
// nárokovaly obě a ZAPSALY DO VNĚJŠÍHO SYSTÉMU DVAKRÁT. U faktury nebo kreditu
// je to ta nejdražší možná chyba.
//
// Řeší se stejným vzorem, který CI prokázalo u voucheru:
//   UPDATE ... WHERE state IN (<očekávané>) + kontrola `meta.changes === 1`
// Optimistický zámek je tu na sloupci `state` místo `version` -- Intent nemá
// verzi, ale stav sám je dostatečně diskriminující: z EXECUTING už nikdo
// druhý nárokovat nemůže.
//
// POZOR NA `batch()`: platí tentýž nález jako u voucheru (prokázáno
// `tests/workers/schema.test.ts` blok 8) -- D1 batch se rollbackuje POUZE při
// SQL chybě, a UPDATE, který nematchne žádný řádek, SQL chyba NENÍ. Proto se
// tady nikde nekombinuje podmíněný UPDATE s dalším statementem v jednom batchi.
//
// ============================================================================
// CO TENHLE STORE NEDĚLÁ
// ============================================================================
//   - NEČTE SYSTÉMOVÉ HODINY. Časy jsou vstupy (`plannedAt`, `recordedAt`) --
//     determinismus a testovatelnost, stejně jako u D1CreditVoucherStore.
//   - NEINTERPRETUJE `payload` ani `expectedState`. Ukládá je jako JSON
//     a vrací zpět. Kdyby je četl, skončil by tu `if (connectorType === ...)`,
//     což CANONICAL-MODEL-CONTRACT §15 zakazuje.
//   - NERETRYUJE a NEROZHODUJE o provedení. To je věc volajícího a
//     `IntentExecutor`.

import { assertTenantContext, type TenantContext } from '../../core/tenant/types.js';
import type { EntityId } from '../../core/canonical/entities/base.js';
import type {
    ExecutionIntent,
    ExecutionIntentState,
    ExecutionConfirmationQuality,
} from '../../core/canonical/outcomes/ExecutionIntent.js';
import { canTransitionIntent } from '../../core/canonical/outcomes/ExecutionIntent.js';
import type {
    ExecutionIntentStore,
    PlanIntentInput,
    PlanIntentResult,
    ClaimIntentOutcome,
    RecordOutcomeInput,
} from '../../core/canonical/outcomes/ExecutionIntentStore.js';

/** Minimální tvar D1, strukturálně kompatibilní s reálným `D1Database`. */
interface D1MetaLike {
    readonly changes: number;
}
interface D1ResultLike<T = Record<string, unknown>> {
    readonly results: T[];
    readonly meta: D1MetaLike;
}
interface D1PreparedLike {
    bind(...values: unknown[]): D1PreparedLike;
    first<T = Record<string, unknown>>(): Promise<T | null>;
    run<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
    all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
}
export interface D1DatabaseLike {
    prepare(query: string): D1PreparedLike;
}

/** Řádek tabulky `execution_intents`. */
interface IntentRow {
    readonly id: string;
    readonly tenant_id: string;
    readonly decision_id: string;
    readonly domain: string;
    readonly connector_type: string;
    readonly operation: string;
    readonly target_ref: string;
    readonly payload_json: string;
    readonly expected_state_json: string;
    readonly state: string;
    readonly idempotency_key: string;
    readonly attempt: number;
    readonly confirmation_quality: string | null;
    readonly execution_reference: string | null;
    readonly failure_reason: string | null;
    readonly created_at: string;
    readonly updated_at: string;
}

const COLUMNS = `id, tenant_id, decision_id, domain, connector_type, operation,
    target_ref, payload_json, expected_state_json, state, idempotency_key,
    attempt, confirmation_quality, execution_reference, failure_reason,
    created_at, updated_at`;

/**
 * Stavy, ze kterých lze Intent nárokovat. Odvozeno z
 * `EXECUTION_INTENT_TRANSITIONS` -- držet to ručně synchronizované by se
 * dřív nebo později rozešlo, proto se to i tak ověřuje přes
 * `canTransitionIntent` níž.
 */
const CLAIMABLE_STATES = ['PLANNED', 'APPROVED', 'FAILED', 'UNKNOWN'] as const;

/**
 * Stavy, po kterých se `attempt` inkrementuje. Retry NEZAKLÁDÁ nový Intent --
 * historie pokusů má zůstat na jednom záznamu.
 */
const RETRY_STATES = new Set<ExecutionIntentState>(['FAILED', 'UNKNOWN']);

export class VoucherIntentStorageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'VoucherIntentStorageError';
    }
}

export class D1ExecutionIntentStore implements ExecutionIntentStore {
    constructor(private readonly db: D1DatabaseLike) {}

    async plan<TPayload, TExpected>(
        context: TenantContext,
        input: PlanIntentInput<TPayload, TExpected>,
    ): Promise<PlanIntentResult<TPayload, TExpected>> {
        assertTenantContext(context, 'D1ExecutionIntentStore.plan');

        // `ON CONFLICT DO NOTHING` + `meta.changes` -- atomicita řešená
        // DB constraintem, ne aplikační kontrolou. Vzor z IdempotencyStore
        // (AIE `INSERT ... ON CONFLICT DO NOTHING`, úspěch = rowCount === 1).
        // Předsazený SELECT by otevřel TOCTOU okno mezi kontrolou a zápisem.
        const inserted = await this.db
            .prepare(
                `INSERT INTO execution_intents
                    (id, tenant_id, decision_id, domain, connector_type, operation,
                     target_ref, payload_json, expected_state_json, state,
                     idempotency_key, attempt, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'PLANNED', ?10, 1, ?11, ?11)
                 ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
            )
            .bind(
                input.id,
                context.tenantId,
                input.decisionId,
                input.domain,
                input.connectorType,
                input.operation,
                input.targetRef,
                JSON.stringify(input.payload),
                JSON.stringify(input.expectedState),
                input.idempotencyKey,
                input.plannedAt,
            )
            .run();

        if (inserted.meta.changes === 1) {
            const created = await this.findById<TPayload, TExpected>(context.tenantId, input.id);
            if (created === undefined) {
                throw new VoucherIntentStorageError(
                    `plan: Intent ${input.id} se zapsal, ale nedá se přečíst zpět.`,
                );
            }
            return { intent: created, alreadyPlanned: false };
        }

        // Konflikt na `uq_intent_idempotency` -- tentýž zápis už je
        // naplánovaný. Není to chyba, je to idempotence.
        const existing = await this.findByIdempotencyKey<TPayload, TExpected>(
            context.tenantId,
            input.idempotencyKey,
        );
        if (existing === undefined) {
            // Konflikt nastal, ale řádek se nenašel -> konflikt byl na
            // PRIMARY KEY (stejné `id`, jiný idempotency klíč). To je
            // kolize identifikátorů, ne idempotence -- volající generuje
            // id špatně.
            throw new VoucherIntentStorageError(
                `plan: konflikt na id "${input.id}", ale idempotency klíč ` +
                    `"${input.idempotencyKey}" v úložišti není. Kolize identifikátorů.`,
            );
        }
        return { intent: existing, alreadyPlanned: true };
    }

    async claimForExecution<TPayload, TExpected>(
        context: TenantContext,
        intentId: EntityId,
        claimedAt: string,
    ): Promise<ClaimIntentOutcome<TPayload, TExpected>> {
        assertTenantContext(context, 'D1ExecutionIntentStore.claimForExecution');

        // JEDNO atomické UPDATE. Dva paralelní běhy: právě jeden dostane
        // `changes === 1`, druhý nulu. Kdyby se stav četl předem a měnil
        // potom, oba by prošly a zapsaly dvakrát.
        const claimed = await this.db
            .prepare(
                `UPDATE execution_intents
                    SET state = 'EXECUTING',
                        attempt = CASE WHEN state IN ('FAILED','UNKNOWN')
                                       THEN attempt + 1 ELSE attempt END,
                        updated_at = ?3
                  WHERE id = ?1
                    AND tenant_id = ?2
                    AND state IN (${CLAIMABLE_STATES.map((s) => `'${s}'`).join(',')})`,
            )
            .bind(intentId, context.tenantId, claimedAt)
            .run();

        if (claimed.meta.changes === 1) {
            const intent = await this.findById<TPayload, TExpected>(context.tenantId, intentId);
            if (intent === undefined) {
                throw new VoucherIntentStorageError(
                    `claimForExecution: Intent ${intentId} se nárokoval, ale zmizel.`,
                );
            }
            return { outcome: 'CLAIMED', intent };
        }

        // `changes === 0` -- rozliš proč. Bez toho by volající nevěděl,
        // jestli má počkat (někdo jiný pracuje) nebo přestat (hotovo).
        const current = await this.findById(context.tenantId, intentId);
        if (current === undefined) {
            // Cizí tenant i neexistující Intent dostanou totéž -- rozdíl
            // v odpovědi by prozradil existenci Intentů napříč tenanty.
            return { outcome: 'NOT_FOUND' };
        }
        if (current.state === 'EXECUTING') {
            return { outcome: 'ALREADY_EXECUTING' };
        }
        return { outcome: 'WRONG_STATE', currentState: current.state };
    }

    async recordOutcome(context: TenantContext, input: RecordOutcomeInput): Promise<void> {
        assertTenantContext(context, 'D1ExecutionIntentStore.recordOutcome');

        if (input.nextState === 'EXECUTED' && input.confirmationQuality === undefined) {
            // Odpovídá CHECK `ck_intent_executed_has_quality` v migraci 0003.
            // Kontroluje se i tady, aby chyba padla s čitelnou hláškou dřív,
            // než ji vrátí SQLite jako constraint violation.
            throw new VoucherIntentStorageError(
                `recordOutcome: EXECUTED vyžaduje confirmationQuality -- bez ní se neví, ` +
                    `jestli výsledek potřebuje reconciliaci (LOG_INFERRED ji potřebuje vždy).`,
            );
        }

        const current = await this.findById(context.tenantId, input.intentId);
        if (current === undefined) {
            throw new VoucherIntentStorageError(
                `recordOutcome: Intent ${input.intentId} neexistuje pro tohoto tenanta.`,
            );
        }
        if (!canTransitionIntent(current.state, input.nextState)) {
            throw new VoucherIntentStorageError(
                `recordOutcome: přechod ${current.state} -> ${input.nextState} není dovolený ` +
                    `(fail-closed).`,
            );
        }

        // Podmínka na `state` v WHERE je optimistický zámek: kdyby mezi
        // čtením a zápisem někdo stav změnil, tenhle UPDATE nematchne
        // a chyba se ohlásí místo tichého přepsání cizí změny.
        const updated = await this.db
            .prepare(
                `UPDATE execution_intents
                    SET state = ?3,
                        confirmation_quality = ?4,
                        execution_reference = ?5,
                        failure_reason = ?6,
                        updated_at = ?7
                  WHERE id = ?1 AND tenant_id = ?2 AND state = ?8`,
            )
            .bind(
                input.intentId,
                context.tenantId,
                input.nextState,
                input.confirmationQuality ?? null,
                input.executionReference ?? null,
                input.failureReason ?? null,
                input.recordedAt,
                current.state,
            )
            .run();

        if (updated.meta.changes !== 1) {
            throw new VoucherIntentStorageError(
                `recordOutcome: Intent ${input.intentId} mezitím změnil stav ` +
                    `(očekáván ${current.state}). Výsledek NEBYL zapsán.`,
            );
        }
    }

    async findById<TPayload, TExpected>(
        tenantId: string,
        intentId: EntityId,
    ): Promise<ExecutionIntent<TPayload, TExpected> | undefined> {
        const row = await this.db
            .prepare(`SELECT ${COLUMNS} FROM execution_intents WHERE id = ?1 AND tenant_id = ?2`)
            .bind(intentId, tenantId)
            .first<IntentRow>();

        return row === null ? undefined : mapRow<TPayload, TExpected>(row);
    }

    async findRequiringReconciliation(
        tenantId: string,
        limit: number,
    ): Promise<ExecutionIntent[]> {
        // Podmínka se MUSÍ shodovat s `requiresReconciliation()` v
        // ExecutionIntent.ts a s partial indexem
        // `idx_intent_needs_reconciliation` v migraci 0003. Rozejít se
        // nesmí -- jinak by index přestal platit a fronta by tiše
        // vynechávala Omega zápisy potvrzené jen z logu.
        const rows = await this.db
            .prepare(
                `SELECT ${COLUMNS} FROM execution_intents
                  WHERE tenant_id = ?1
                    AND (state = 'UNKNOWN'
                         OR (state = 'EXECUTED' AND confirmation_quality = 'LOG_INFERRED'))
                  ORDER BY updated_at ASC
                  LIMIT ?2`,
            )
            .bind(tenantId, limit)
            .all<IntentRow>();

        return rows.results.map((r) => mapRow(r));
    }

    async findPending(tenantId: string, limit: number): Promise<ExecutionIntent[]> {
        const rows = await this.db
            .prepare(
                `SELECT ${COLUMNS} FROM execution_intents
                  WHERE tenant_id = ?1 AND state IN ('PLANNED','APPROVED')
                  ORDER BY created_at ASC
                  LIMIT ?2`,
            )
            .bind(tenantId, limit)
            .all<IntentRow>();

        return rows.results.map((r) => mapRow(r));
    }

    private async findByIdempotencyKey<TPayload, TExpected>(
        tenantId: string,
        idempotencyKey: string,
    ): Promise<ExecutionIntent<TPayload, TExpected> | undefined> {
        const row = await this.db
            .prepare(
                `SELECT ${COLUMNS} FROM execution_intents
                  WHERE tenant_id = ?1 AND idempotency_key = ?2`,
            )
            .bind(tenantId, idempotencyKey)
            .first<IntentRow>();

        return row === null ? undefined : mapRow<TPayload, TExpected>(row);
    }
}

function mapRow<TPayload, TExpected>(row: IntentRow): ExecutionIntent<TPayload, TExpected> {
    return {
        id: row.id,
        tenantId: row.tenant_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        decisionId: row.decision_id,
        domain: row.domain,
        connectorType: row.connector_type,
        operation: row.operation,
        targetRef: row.target_ref,
        payload: parseJson<TPayload>(row.payload_json, row.id, 'payload_json'),
        expectedState: parseJson<TExpected>(row.expected_state_json, row.id, 'expected_state_json'),
        state: row.state as ExecutionIntentState,
        idempotencyKey: row.idempotency_key,
        attempt: row.attempt,
        ...(row.confirmation_quality !== null
            ? { confirmationQuality: row.confirmation_quality as ExecutionConfirmationQuality }
            : {}),
        ...(row.execution_reference !== null
            ? { executionReference: row.execution_reference }
            : {}),
        ...(row.failure_reason !== null ? { failureReason: row.failure_reason } : {}),
    };
}

/**
 * Fail-closed parsování. Nečitelný JSON znamená poškozený řádek -- vracet
 * místo něj `{}` by vedlo k zápisu prázdného payloadu do vnějšího systému,
 * což je horší než hlasitá chyba.
 */
function parseJson<T>(raw: string, intentId: string, column: string): T {
    try {
        return JSON.parse(raw) as T;
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new VoucherIntentStorageError(
            `Intent ${intentId}: sloupec ${column} není platný JSON (${reason}).`,
        );
    }
}
