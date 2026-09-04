// Tenant Core — základ multi-tenant izolace (master prompt §5: "Tenant izolace
// je kritický bezpečnostní invariant"). Sjednocuje nejzralejší existující vzory:
// SafeOrder migrations/0001 (tenants/tenant_policies/tenant_plans tabulky) +
// AIE src/tenants/configuration.ts (TenantConfig, platform-agnostic core).
//
// Žádný modul v core/ ani domains/ nesmí importovat konkrétní platformu
// (Shoptet/Shopify) přímo — jen přes Tenant.platform jako string klíč do
// Connector Layer (§15: "Core nesmí obsahovat if ERP === ...").

import type { CanonicalEntity, EntityId, ISODateTime, TenantId } from '../canonical/types.js';

export type TenantStatus = 'ACTIVE' | 'SUSPENDED' | 'UNINSTALLED';
export type PlanTier = 'STARTER' | 'GROWTH' | 'ENTERPRISE' | 'CUSTOM';

/**
 * Root tenant entity. `platform` + `platformShopId` je unique pair (viz
 * SafeOrder migrations/0001 UNIQUE constraint) — jeden Shoptet/Shopify shop
 * = jeden tenant, nikdy naopak.
 */
export interface Tenant extends CanonicalEntity {
    id: TenantId;
    platform: string;
    platformShopId: string;
    status: TenantStatus;
}

/**
 * Konfigurace integrace pro daného tenanta — přenáší AIE `TenantConfig`
 * koncept (§15: core neví, jestli je to Shoptet CSV export nebo REST API,
 * ví jen "api" nebo "import").
 */
export interface TenantIntegrationConfig {
    tenantId: TenantId;
    integrationMode: 'api' | 'import';
    enabled: boolean;
}

/**
 * Plán/limity SaaS tenanta (§5, §14 billing vazba). Vychází ze SafeOrder
 * migrations/0008 — jediný zdrojový systém, který měl plán tiers hotové.
 */
export interface TenantPlan {
    tenantId: TenantId;
    planTier: PlanTier;
    monthlyEvaluationLimit: number;
    monthlyEvaluationsUsed: number;
    status: 'ACTIVE' | 'GRACE_PERIOD' | 'SUSPENDED' | 'CANCELED';
    billingPeriodStart: ISODateTime;
    billingPeriodEnd: ISODateTime;
}

/**
 * Kontext, který se musí protáhnout skrz KAŽDÉ volání core/domains modulu.
 * Nikdy nesmí být odvozen z klientského vstupu (SafeOrder "Zero Trust"
 * princip — klient nikdy nerozhoduje o identitě/tenantu).
 */
export interface TenantContext {
    readonly tenantId: TenantId;
    readonly platform: string;
}

/** Porušení tenant izolace je bezpečnostní incident, ne běžná chyba. */
export class TenantIsolationViolation extends Error {
    constructor(
        public readonly expectedTenantId: TenantId,
        public readonly actualTenantId: TenantId,
        public readonly entity: string,
        public readonly entityId: EntityId
    ) {
        super(
            `Tenant isolation violation: expected tenant ${expectedTenantId}, ` +
            `got ${actualTenantId} for ${entity}#${entityId}`
        );
        this.name = 'TenantIsolationViolation';
    }
}

/**
 * Vynucuje, že entita skutečně patří danému tenantovi, PŘED jakoukoli
 * mutací. Přímá reakce na nalezenou bezpečnostní mezeru v AIE audit
 * (`PostgresProcurementRepository.updateLineQuantity()` nefiltrovalo
 * WHERE přes tenant_id) — v NEXUS musí tahle kontrola být explicitní
 * a nezapomenutelná, ne implicitní v SQL WHERE klauzuli, kterou lze
 * omylem vynechat.
 */
export function assertTenantOwnership(
    context: TenantContext,
    entity: { tenantId: TenantId },
    entityName: string,
    entityId: EntityId
): void {
    if (entity.tenantId !== context.tenantId) {
        throw new TenantIsolationViolation(context.tenantId, entity.tenantId, entityName, entityId);
    }
}
