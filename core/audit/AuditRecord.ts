// Audit Framework -- core/audit/, Fáze 0 (docs/MIGRATION_PLAN.md).
// Sjednocuje TŘI nezávislé zdrojové vzory, které nejsou provázané žádným
// společným typem (opakovaná konvence, ne sdílený kód):
//   Omega PipelineAuditRecord (~/omega-bridge/src/core/orchestrator/
//     PipelineAuditRecord.ts:12-33) -- 4 hashe (sourceHash, canonicalHash,
//     payloadHash, evidenceHash) + stateHistory: StateTransition[]
//     append-only log s {from, to, timestamp, actor, reason?,
//     evidenceReference?} (PipelineAuditRecord.ts:3-10).
//   Omega SyncJob (~/omega-bridge/src/core/sync/SyncJob.ts:29-31) -- jen
//     3 hashe (sourcePayloadHash, canonicalPayloadHash, targetPayloadHash)
//     jako pole přímo na entitě, žádná samostatná historie.
//   AIE procurement_audit_log (~/availability-intelligence-engine/
//     migrations/001_procurement_core.sql:26-29) -- prostá JSONB append-only
//     tabulka (tenant_id, event_type, entity_id, payload, occurred_at),
//     žádné hashe, žádná state historie -- INSERT-only přes
//     PostgresProcurementRepository.append() (žádný UPDATE/DELETE nikde
//     v repu na tuhle tabulku).
//
// POZOR: MIGRATION_PLAN.md (řádek 19) mluví o "hash triádě", ale reálný
// PipelineAuditRecord má 4 hashe, ne 3 -- tenhle framework reflektuje
// realitu (4 pojmenovaná hash pole + obecné key-value rozšíření), ne plán.
//
// Fingerprint konvence konzistentní s existujícím Nexus kódem:
// core/canonical/rules/Decision.ts (`fingerprint: string`) a
// core/canonical/lifecycle/Execution.ts (`requestFingerprint: string`) --
// AuditRecord nepřidává nový pojem, jen ho zobecňuje na "více hashů
// najednou", protože žádný ze tří zdrojů nemá jen jeden hash.
//
// APPEND-ONLY INVARIANT (společný jmenovatel všech tří zdrojů, nejsilněji
// vynucený u AIE): jednou zapsaný AuditRecord se NIKDY nemutuje. Nová
// informace = nový záznam (append), ne UPDATE existujícího. Framework tohle
// vynucuje typem (`readonly` všude) a funkcí, která vrací NOVÝ log, ne
// mutuje starý -- stejný vzor jako core/state-machine evaluateTransition()
// (čistá funkce, žádný side effect, volající řeší perzistenci).

import type { TransitionResult } from '../state-machine/StateMachine.js';

/**
 * Jeden zaznamenaný přechod stavu v rámci pipeline/joblife -- 1:1 tvar
 * Omega StateTransition (PipelineAuditRecord.ts:3-10), rozšířený o
 * kompatibilitu s core/state-machine TransitionResult (odkud se `allowed`/
 * `reason` dá převzít, pokud přechod prošel přes evaluateTransition()).
 */
export interface AuditStateTransition<TState extends string> {
    readonly from: TState | 'START';
    readonly to: TState;
    readonly timestamp: string; // ISO 8601, ne Date -- serializovatelnost (JSONB, jako AIE)
    readonly actor: string;
    readonly reason?: string;
    readonly evidenceReference?: string;
}

/**
 * Sada hashů/fingerprintů na jednu pipeline/operaci. Pojmenovaná pole
 * odpovídají PipelineAuditRecord (4 hashe), `extra` pokrývá jakýkoliv
 * doménově specifický hash navíc (např. budoucí SafeOrder checksum),
 * aniž by se musel měnit tenhle core typ pokaždé, když nějaká doména
 * přidá vlastní hash pole -- viz Confirmed Gap v SafeOrder
 * CalibrationProfile.checksum (state/health mimo checksum, jiný typ
 * problému, ale stejný princip: hash pole musí být explicitně
 * pojmenovaná, ne implicitně odvozená).
 */
export interface AuditHashSet {
    readonly sourceHash?: string;
    readonly canonicalHash?: string;
    readonly payloadHash?: string;
    readonly evidenceHash?: string;
    readonly extra?: Readonly<Record<string, string>>;
}

/**
 * Jeden append-only audit záznam. `TState` -- pokud doména nemá state
 * machine (jako prostý AIE audit log), použije se `never` a
 * `stateHistory` zůstane vždy prázdné pole -- typ to nevynucuje jako
 * povinné, protože ne každá auditovaná operace má lifecycle.
 */
export interface AuditRecord<TState extends string = string> {
    readonly recordId: string;
    readonly tenantId: string;
    readonly entityId: string;
    readonly eventType: string;
    readonly occurredAt: string; // ISO 8601
    readonly payload: unknown; // JSONB-kompatibilní, jako AIE procurement_audit_log.payload
    readonly hashes: AuditHashSet;
    readonly stateHistory: readonly AuditStateTransition<TState>[];
    readonly errors: readonly string[];
    readonly warnings: readonly string[];
}

/**
 * AuditLog -- append-only kolekce AuditRecord. Žádná metoda tady nemutuje
 * `records` in-place -- `append()` vrací NOVOU kolekci (nový pole
 * reference), aby bylo architektonicky nemožné omylem přepsat historii
 * (stejný princip jako Decision/Execution -- immutable snapshoty, ne
 * mutable objekty, co se tichým vedlejším efektem změní pod rukama).
 */
export interface AuditLog<TState extends string = string> {
    readonly tenantId: string;
    readonly records: readonly AuditRecord<TState>[];
}

export function createAuditLog<TState extends string = string>(tenantId: string): AuditLog<TState> {
    return { tenantId, records: [] };
}

/**
 * Přidá nový AuditRecord na konec logu. NIKDY needituje existující
 * záznam -- vrací nový AuditLog s novým polem `records`. Pokud `record`
 * patří jinému tenantovi než `log`, throw (tenant isolation invariant,
 * stejné pravidlo jako core/tenant/assertTenantOwnership -- audit log
 * napříč tenanty by byl bezpečnostní díra, ne jen datová nekonzistence).
 */
export function appendAuditRecord<TState extends string>(
    log: AuditLog<TState>,
    record: AuditRecord<TState>
): AuditLog<TState> {
    if (record.tenantId !== log.tenantId) {
        throw new Error(
            `Tenant mismatch: AuditLog is scoped to tenant "${log.tenantId}", but record belongs to tenant "${record.tenantId}" -- refusing cross-tenant append`
        );
    }
    return { tenantId: log.tenantId, records: [...log.records, record] };
}

/**
 * Přidá jeden state transition záznam k JIŽ EXISTUJÍCÍMU AuditRecord --
 * ale zase NEMUTUJE originál, vrací nový AuditRecord s rozšířeným
 * `stateHistory`. Volající si musí sám nahradit starý záznam v logu
 * (typicky přes appendAuditRecord na NOVÝ záznam s aktualizovanou
 * historií, ne "opravit" ten starý -- append-only znamená, že i "oprava"
 * je nový záznam, ne edit).
 */
export function withStateTransition<TState extends string>(
    record: AuditRecord<TState>,
    transition: AuditStateTransition<TState>
): AuditRecord<TState> {
    return { ...record, stateHistory: [...record.stateHistory, transition] };
}

/**
 * Pomocná funkce: převede TransitionResult z core/state-machine na
 * AuditStateTransition -- most mezi dvěma frameworky, aby se
 * evaluateTransition() výsledek dal rovnou zaznamenat do audit historie
 * bez ručního přemapování polí na volající straně.
 */
export function transitionResultToAuditEntry<TState extends string>(
    result: TransitionResult<TState>,
    actor: string,
    timestamp: string,
    reason?: string
): AuditStateTransition<TState> {
    return {
        from: result.fromState,
        to: result.toState,
        timestamp,
        actor,
        reason: reason ?? result.reason,
    };
}
