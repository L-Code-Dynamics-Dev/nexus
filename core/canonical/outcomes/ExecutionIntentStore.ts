// ExecutionIntentStore -- perzistence Execution vrstvy (P1).
//
// Vzor 1:1 podle `core/idempotency/IdempotencyStore.ts`: kontrakt + in-memory
// referenční implementace tady, produkční (D1) v `connectors/`.
//
// PROČ TO NENÍ JEN "CRUD NAD TABULKOU":
//   Dvě metody nesou pravidla, která se nesmí obejít, a proto jsou v kontraktu,
//   ne v aplikačním kódu volajícího:
//
//   1. `claimForExecution()` -- atomický přechod na EXECUTING. Musí se
//      provést a PERZISTOVAT PŘED voláním vnějšího systému (viz kontrakt
//      `IntentExecutor.executeIntent`). Kdyby to bylo "načti, změň, ulož"
//      ve třech krocích, dva paralelní běhy by si Intent nárokovaly obě
//      a zapsaly by dvakrát -- což je u faktur a kreditu ta nejhorší chyba.
//      Řeší se optimistickým zámkem na `state`, stejně jako zůstatek
//      voucheru na `version` (nález prokázaný na CI: v D1 je jediná
//      spolehlivá atomicita `UPDATE ... WHERE <očekávaný stav>` + kontrola
//      `meta.changes === 1`).
//
//   2. `findRequiringReconciliation()` -- fronta nejistot. Odpovídá
//      `requiresReconciliation()`: UNKNOWN plus EXECUTED s LOG_INFERRED.
//      Kdyby ji kontrakt neměl, každý volající by si podmínku psal znovu
//      a někdo by na LOG_INFERRED zapomněl -- a tím by se "úspěch odvozený
//      regexem z Omega logu" tiše bral jako fakt.

import type { EntityId } from '../entities/base.js';
import type { TenantContext } from '../../tenant/types.js';
import { assertTenantContext } from '../../tenant/types.js';
import type {
    ExecutionIntent,
    ExecutionIntentState,
    ExecutionConfirmationQuality,
} from './ExecutionIntent.js';
import { canTransitionIntent, requiresReconciliation } from './ExecutionIntent.js';

/** Vstup pro naplánování nového Intentu. Stav a pokus si nastaví store sám. */
export interface PlanIntentInput<TPayload = unknown, TExpected = unknown> {
    readonly id: EntityId;
    readonly decisionId: EntityId;
    readonly domain: string;
    readonly connectorType: string;
    readonly operation: string;
    readonly targetRef: string;
    readonly payload: TPayload;
    readonly expectedState: TExpected;
    readonly idempotencyKey: string;
    /** Čas jako VSTUP, ne `Date.now()` uvnitř -- kvůli determinismu a testům. */
    readonly plannedAt: string;
}

export interface PlanIntentResult<TPayload = unknown, TExpected = unknown> {
    readonly intent: ExecutionIntent<TPayload, TExpected>;
    /**
     * `true` = Intent s tímtéž `idempotencyKey` už existoval a vrací se
     * PŮVODNÍ, nový se nezaložil. Není to chyba -- je to idempotence.
     */
    readonly alreadyPlanned: boolean;
}

/**
 * Výsledek pokusu o nárokování Intentu k provedení.
 *
 * `ALREADY_EXECUTING` a `WRONG_STATE` jsou rozlišené schválně: první
 * znamená "někdo jiný to právě dělá, nesahej na to", druhý "tenhle Intent
 * je hotový nebo zahozený". Splácnout je do jednoho by svádělo k tomu
 * počkat a zkusit znovu i tam, kde je práce dávno hotová.
 */
export type ClaimIntentOutcome<TPayload = unknown, TExpected = unknown> =
    | { readonly outcome: 'CLAIMED'; readonly intent: ExecutionIntent<TPayload, TExpected> }
    | { readonly outcome: 'ALREADY_EXECUTING' }
    | { readonly outcome: 'WRONG_STATE'; readonly currentState: ExecutionIntentState }
    | { readonly outcome: 'NOT_FOUND' };

/** Zápis výsledku provedení. */
export interface RecordOutcomeInput {
    readonly intentId: EntityId;
    readonly nextState: ExecutionIntentState;
    readonly confirmationQuality?: ExecutionConfirmationQuality;
    readonly executionReference?: string;
    readonly failureReason?: string;
    readonly recordedAt: string;
}

export interface ExecutionIntentStore {
    /**
     * Naplánuje Intent. Idempotentní na `(tenantId, idempotencyKey)` --
     * vynuceno unique indexem, ne aplikační kontrolou.
     */
    plan<TPayload, TExpected>(
        context: TenantContext,
        input: PlanIntentInput<TPayload, TExpected>,
    ): Promise<PlanIntentResult<TPayload, TExpected>>;

    /**
     * ATOMICKY nárokuje Intent k provedení (→ EXECUTING).
     *
     * Musí proběhnout PŘED voláním vnějšího systému. Dva paralelní běhy
     * nesmí nárokovat tentýž Intent -- právě jeden dostane `CLAIMED`.
     */
    claimForExecution<TPayload, TExpected>(
        context: TenantContext,
        intentId: EntityId,
        /** Čas jako VSTUP, ne `Date.now()` uvnitř -- determinismus a testy. */
        claimedAt: string,
    ): Promise<ClaimIntentOutcome<TPayload, TExpected>>;

    /** Zapíše výsledek provedení a přepne stav. */
    recordOutcome(context: TenantContext, input: RecordOutcomeInput): Promise<void>;

    findById<TPayload, TExpected>(
        tenantId: string,
        intentId: EntityId,
    ): Promise<ExecutionIntent<TPayload, TExpected> | undefined>;

    /**
     * Fronta nejistot -- UNKNOWN + EXECUTED s LOG_INFERRED.
     * Tohle je vstup reconciliační smyčky.
     */
    findRequiringReconciliation(tenantId: string, limit: number): Promise<ExecutionIntent[]>;

    /** Co čeká na provedení (PLANNED / APPROVED). */
    findPending(tenantId: string, limit: number): Promise<ExecutionIntent[]>;
}

/**
 * In-memory referenční implementace -- pro testy a jako živá dokumentace
 * sémantiky, kterou musí D1 verze splnit. Produkční implementace patří do
 * `connectors/d1/`, ne sem (stejné pravidlo jako u `IdempotencyStore`).
 */
export class InMemoryExecutionIntentStore implements ExecutionIntentStore {
    private readonly intents = new Map<string, ExecutionIntent>();
    /** Simuluje unique index `uq_intent_idempotency`. */
    private readonly byIdempotencyKey = new Map<string, string>();

    async plan<TPayload, TExpected>(
        context: TenantContext,
        input: PlanIntentInput<TPayload, TExpected>,
    ): Promise<PlanIntentResult<TPayload, TExpected>> {
        assertTenantContext(context, 'InMemoryExecutionIntentStore.plan');

        const key = `${context.tenantId}::${input.idempotencyKey}`;
        const existingId = this.byIdempotencyKey.get(key);
        if (existingId !== undefined) {
            const existing = this.intents.get(existingId);
            if (existing !== undefined) {
                return {
                    intent: existing as ExecutionIntent<TPayload, TExpected>,
                    alreadyPlanned: true,
                };
            }
        }

        const intent: ExecutionIntent<TPayload, TExpected> = {
            id: input.id,
            tenantId: context.tenantId,
            createdAt: input.plannedAt,
            updatedAt: input.plannedAt,
            decisionId: input.decisionId,
            domain: input.domain,
            connectorType: input.connectorType,
            operation: input.operation,
            targetRef: input.targetRef,
            payload: input.payload,
            expectedState: input.expectedState,
            state: 'PLANNED',
            idempotencyKey: input.idempotencyKey,
            attempt: 1,
        };

        this.intents.set(input.id, intent as ExecutionIntent);
        this.byIdempotencyKey.set(key, input.id);

        return { intent, alreadyPlanned: false };
    }

    async claimForExecution<TPayload, TExpected>(
        context: TenantContext,
        intentId: EntityId,
        claimedAt: string,
    ): Promise<ClaimIntentOutcome<TPayload, TExpected>> {
        assertTenantContext(context, 'InMemoryExecutionIntentStore.claimForExecution');

        const intent = this.intents.get(intentId);
        if (intent === undefined || intent.tenantId !== context.tenantId) {
            // Cizí tenant dostane NOT_FOUND, ne chybu -- jinak by šlo
            // existenci Intentů napříč tenanty zjišťovat podle odpovědi.
            return { outcome: 'NOT_FOUND' };
        }

        if (intent.state === 'EXECUTING') {
            return { outcome: 'ALREADY_EXECUTING' };
        }

        if (!canTransitionIntent(intent.state, 'EXECUTING')) {
            return { outcome: 'WRONG_STATE', currentState: intent.state };
        }

        // Retry inkrementuje `attempt` na EXISTUJÍCÍM Intentu -- nový se
        // nezakládá, jinak by se ztratila historie pokusů.
        const claimed: ExecutionIntent = {
            ...intent,
            state: 'EXECUTING',
            updatedAt: claimedAt,
            attempt: intent.state === 'FAILED' || intent.state === 'UNKNOWN'
                ? intent.attempt + 1
                : intent.attempt,
        };
        this.intents.set(intentId, claimed);

        return { outcome: 'CLAIMED', intent: claimed as ExecutionIntent<TPayload, TExpected> };
    }

    async recordOutcome(context: TenantContext, input: RecordOutcomeInput): Promise<void> {
        assertTenantContext(context, 'InMemoryExecutionIntentStore.recordOutcome');

        const intent = this.intents.get(input.intentId);
        if (intent === undefined || intent.tenantId !== context.tenantId) {
            throw new Error(`ExecutionIntent ${input.intentId} neexistuje pro tohoto tenanta.`);
        }

        if (!canTransitionIntent(intent.state, input.nextState)) {
            throw new Error(
                `ExecutionIntent ${input.intentId}: přechod ${intent.state} -> ${input.nextState} ` +
                    `není dovolený (fail-closed).`,
            );
        }

        if (input.nextState === 'EXECUTED' && input.confirmationQuality === undefined) {
            // Odpovídá CHECK constraintu v migraci 0003: bez kvality
            // potvrzení by se nevědělo, jestli výsledek vyžaduje reconciliaci.
            throw new Error(
                `ExecutionIntent ${input.intentId}: EXECUTED vyžaduje confirmationQuality.`,
            );
        }

        this.intents.set(input.intentId, {
            ...intent,
            state: input.nextState,
            updatedAt: input.recordedAt,
            ...(input.confirmationQuality !== undefined
                ? { confirmationQuality: input.confirmationQuality }
                : {}),
            ...(input.executionReference !== undefined
                ? { executionReference: input.executionReference }
                : {}),
            ...(input.failureReason !== undefined ? { failureReason: input.failureReason } : {}),
        });
    }

    async findById<TPayload, TExpected>(
        tenantId: string,
        intentId: EntityId,
    ): Promise<ExecutionIntent<TPayload, TExpected> | undefined> {
        const intent = this.intents.get(intentId);
        if (intent === undefined || intent.tenantId !== tenantId) return undefined;
        return intent as ExecutionIntent<TPayload, TExpected>;
    }

    async findRequiringReconciliation(
        tenantId: string,
        limit: number,
    ): Promise<ExecutionIntent[]> {
        return [...this.intents.values()]
            .filter((i) => i.tenantId === tenantId && requiresReconciliation(i))
            .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
            .slice(0, limit);
    }

    async findPending(tenantId: string, limit: number): Promise<ExecutionIntent[]> {
        return [...this.intents.values()]
            .filter(
                (i) =>
                    i.tenantId === tenantId && (i.state === 'PLANNED' || i.state === 'APPROVED'),
            )
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
            .slice(0, limit);
    }
}
