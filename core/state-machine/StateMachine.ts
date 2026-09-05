// State Machine Framework -- core/state-machine/, Fáze 0 (docs/MIGRATION_PLAN.md).
// Sjednocuje dva nezávislé referenční vzory:
//   Omega SyncJob/JobState (~/omega-bridge/src/core/sync/SyncJob.ts) --
//     LINEÁRNÍ sekvence s failure branches: RECEIVED -> ... -> COMPLETED,
//     nebo REJECTED/FAILED/HOLD/QUARANTINED/UNKNOWN kdykoliv po cestě.
//   AIE PurchaseOrder.status (~/availability-intelligence-engine/src/core/
//     procurement/types.ts:108) -- DRAFT/PENDING_APPROVAL/SENT/CANCELLED/
//     COMPLETED/RECEIVED/PARTIALLY_RECEIVED jako JEDEN sloupec.
//
// TVRDÝ POŽADAVEK z core/canonical/CANONICAL-MODEL-CONTRACT.md §6 bod 1:
// "PurchaseOrder.status musí se rozdělit na nezávislé osy (lifecycle /
// cancellationState / supplierEcho), ne jeden sloupec." Tenhle framework
// proto NENÍ jen "enum + dovolené přechody" -- podporuje MULTI-AXIS stav
// od začátku, protože single-axis návrh by zopakoval přesně tu chybu,
// kterou kontrakt už identifikoval a zakázal.
//
// Lineární state stroj (SyncJob-like) je čistě speciální případ multi-axis
// s jedinou osou -- viz core/state-machine/examples/ pro oba vzory jako
// dokumentaci/test, ŽÁDNÝ z nich není napojen na produkční kód.

/**
 * Jedna nezávislá osa stavu (např. "lifecycle", "cancellationState",
 * "supplierEcho" u PurchaseOrder). `TState` je union stringových hodnot
 * dané osy -- konkrétní doména definuje svůj vlastní typ, framework
 * nezná konkrétní hodnoty.
 */
export interface StateAxis<TState extends string> {
    readonly axisName: string;
    readonly currentState: TState;
}

/**
 * Deklarace dovolených přechodů pro jednu osu. `transitions` mapuje
 * `fromState -> Set dovolených toState` -- přechod, který zde není
 * uveden, je zakázaný (fail-closed, ne fail-open).
 */
export interface StateAxisDefinition<TState extends string> {
    readonly axisName: string;
    readonly initialState: TState;
    readonly transitions: Record<TState, readonly TState[]>;
    /** Stavy, ze kterých už NENÍ možný žádný další přechod (terminální). */
    readonly terminalStates: readonly TState[];
}

export interface TransitionResult<TState extends string> {
    readonly allowed: boolean;
    readonly fromState: TState;
    readonly toState: TState;
    readonly reason?: string;
}

/**
 * Vyhodnotí, zda je přechod `from -> to` na dané ose dovolený, podle
 * `StateAxisDefinition.transitions`. Čistá funkce, žádný side effect --
 * volající je zodpovědný za perzistenci nového stavu, framework jen
 * rozhoduje o dovolenosti přechodu.
 */
export function evaluateTransition<TState extends string>(
    definition: StateAxisDefinition<TState>,
    from: TState,
    to: TState
): TransitionResult<TState> {
    if (definition.terminalStates.includes(from)) {
        return { allowed: false, fromState: from, toState: to, reason: `"${from}" is terminal on axis "${definition.axisName}" -- no transitions allowed` };
    }

    const allowedTargets = definition.transitions[from] ?? [];
    if (!allowedTargets.includes(to)) {
        return {
            allowed: false,
            fromState: from,
            toState: to,
            reason: `"${from}" -> "${to}" not declared as allowed on axis "${definition.axisName}" (allowed: ${allowedTargets.join(', ') || '(none)'})`,
        };
    }

    return { allowed: true, fromState: from, toState: to };
}

/**
 * Entita s MULTI-AXIS stavem -- např. PurchaseOrder má lifecycle +
 * cancellationState + supplierEcho jako tři nezávislé osy, každá se svým
 * vlastním `StateAxisDefinition`. `axes` je typovaný záznam axisName ->
 * currentState, konkrétní entita definuje svůj vlastní shape.
 */
export type MultiAxisState<TAxes> = {
    readonly [K in keyof TAxes]: TAxes[K];
};

/**
 * Vyhodnotí přechod na JEDNÉ ose v rámci multi-axis entity, beze změny
 * ostatních os -- to je klíčový rozdíl oproti single-column enum: zrušení
 * objednávky (cancellationState) nesmí implicitně měnit lifecycle nebo
 * supplierEcho, musí to být samostatný, explicitně validovaný přechod.
 */
export function evaluateAxisTransition<TAxes extends Record<keyof TAxes, string>, TAxisName extends keyof TAxes & string>(
    definitions: { [K in keyof TAxes]: StateAxisDefinition<TAxes[K]> },
    currentState: MultiAxisState<TAxes>,
    axisName: TAxisName,
    toState: TAxes[TAxisName]
): TransitionResult<TAxes[TAxisName]> {
    const definition = definitions[axisName];
    const fromState = currentState[axisName];
    return evaluateTransition(definition, fromState, toState);
}
