// State Model -- CANONICAL-MODEL-CONTRACT.md §4, nejsilnější cross-entity
// princip celé synthesis. Aplikuje se na KAŽDÝ connector (Shoptet dnes,
// Shopify/ERP zítra).
//
// TVRDÉ PRAVIDLO: Canonical State se NESMÍ vytvořit přejmenováním
// External State. NIKDY:
//   Shoptet status "X" -> Nexus status "X"
// VŽDY:
//   External State -> Mapping (tenant/connector config) -> Canonical State
//   (navržený nezávisle, viz Order.ts canonicalStatus TBD)

export interface ExternalState<T = unknown> {
    readonly connectorType: string;
    readonly raw: T;
    readonly observedAt: string;
}

export interface StatusMapping<TExternal, TCanonical> {
    readonly tenantId: string;
    readonly connectorType: string;
    map(external: TExternal): TCanonical | { unresolved: true; preserved: TExternal };
}

export interface CanonicalState<T = unknown> {
    readonly value: T;
    readonly derivedFrom: ExternalState;
    readonly mappingVersion: string;
}

/**
 * Pokračování řetězce (State Taxonomy, CONTRACT §4):
 *   Canonical State -> Decision -> Expected Execution State
 *      -> Actual External State -> Reconciliation -> Outcome
 * Decision/Reconciliation/Outcome typy viz decisions/ a reconciliation/.
 */
export interface ExpectedExecutionState<T = unknown> {
    readonly value: T;
    readonly decisionId: string;
}

export interface ActualExternalState<T = unknown> {
    readonly value: T;
    readonly observedAt: string;
}
