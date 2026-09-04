// Connector Contract -- Core nesmí vědět, jestli pracuje přes CSV, REST
// API, nebo ERP. Referenční vzor: pricing-engine-platform
// EcommercePlatformAdapter (nejčistší vzor v celém legacy portfoliu --
// "an adapter NEVER computes a discount, tier, or final price. It only
// translates platform data.").
//
// Dnes: Nexus -> Shoptet CSV Export -> Core -> Shoptet CSV Import
// Později (Shoptet API doplněk schválen): Nexus -> Shoptet REST -> Core
// Core se v obou případech NEMĚNÍ -- jen se vymění Connector implementace.

export type ConnectorType = 'shoptet-csv' | 'shoptet-api' | 'shopify' | 'erp' | 'wms' | 'accounting';

export interface ConnectorCapabilities {
    readonly canRead: boolean;
    readonly canWrite: boolean;
    /** Shoptet V1 (§41 zadání): musí fungovat bez API -- CSV-only connector je plnohodnotný. */
    readonly requiresApi: boolean;
}

/**
 * Read/Write rozhraní, které Core konzumuje. Konkrétní connector
 * (connectors/shoptet/, connectors/erp-generic/, ...) implementuje
 * TExternal podle vlastního externího formátu -- Core zná jen
 * TCanonical, nikdy TExternal napřímo (§16 zadání -- "Core nesmí
 * obsahovat if ERP === ...").
 */
export interface Connector<TExternal, TCanonical> {
    readonly connectorId: string;
    readonly connectorType: ConnectorType;
    readonly capabilities: ConnectorCapabilities;

    /** Adapter NIKDY nepočítá business hodnotu -- jen překládá tvar dat. */
    toCanonical(external: TExternal): TCanonical;
    toExternal(canonical: TCanonical): TExternal;
}

/**
 * Write cesta -- vrací Execution (core/canonical/lifecycle/Execution.ts),
 * NIKDY přímo "success: true". Connector reportuje jen SENT, nikdy
 * CONFIRMED -- to potvrzuje až Reconciliation nad Actual External State.
 */
export interface WritableConnector<TExternal, TCanonical> extends Connector<TExternal, TCanonical> {
    write(canonical: TCanonical): Promise<{ externalReference?: string; error?: string }>;
    read(externalId: string): Promise<TExternal | null>;
}
