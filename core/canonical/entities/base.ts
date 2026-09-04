// Entity Contract kostra (CANONICAL-MODEL-CONTRACT.md §5). Společná pro
// všechny Entity — ne každá musí mít VYPLNĚNO vše (Order nemá Version,
// je read-only zrcadlo), ale všechny musí tyto prvky mít DEFINOVANÉ.

import Decimal from 'decimal.js';

export type TenantId = string;
export type EntityId = string;
export type ISODateTime = string;

/** Peníze vždy jako Decimal, nikdy float -- konvence potvrzená v Pricing Engine i Omega. */
export interface Money {
    amount: Decimal;
    currency: string;
}

/** Identity — Nexus-generated, NIKDY totéž jako external identity (§3 Synthesis). */
export interface CanonicalIdentity {
    readonly id: EntityId;
}

/** Source references — pro entity s external mirror (Order, Product, Customer). */
export interface ExternalIdentity {
    readonly connectorType: string; // 'shoptet' | 'shopify' | ... -- NIKDY hardcoded if/else v core
    readonly externalId: string;
    readonly externalGuid?: string;
}

/** Tenant scope — povinné pro všechny entity, vynucené přes assertTenantOwnership(). */
export interface TenantScoped {
    readonly tenantId: TenantId;
}

/** Audit contract — povinný pro všechny mutace (§5). */
export interface AuditableTimestamps {
    readonly createdAt: ISODateTime;
    readonly updatedAt: ISODateTime;
}

/**
 * Základní entity kostra. Konkrétní entita rozšiřuje o Business data,
 * Relationships, Lifecycle, Invariants, Source-of-truth per pole, Version
 * (jen pokud je mutovatelná v čase), Reconciliation contract (jen pokud
 * Expected≠Actual je možné) -- viz CANONICAL-MODEL-CONTRACT.md §5 tabulka.
 */
export interface CanonicalEntity extends CanonicalIdentity, TenantScoped, AuditableTimestamps {}
