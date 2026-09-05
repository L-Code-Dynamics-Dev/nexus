// Billing / Subscription -- Fáze 6 doménová kostra (docs/MIGRATION_PLAN.md,
// Josovo zadání 2026-09-05: "Další kroky Fáze 6"). Čistě NEW BUILD.
//
// ROZHODNUTO (Jose 2026-09-05):
//   - Billing -> Tenant / TenantPlan (core/tenant/types.ts) -- NENÍ totéž
//     jako fakturace/Invoice.ts. Billing = SaaS platba za používání
//     samotného Nexusu, Invoice = doklad k zákaznické Order. Oddělené
//     domény ("Invoice není SaaS Billing", Jose bod 3).
//   - `TenantPlan` (core/tenant/types.ts) už existuje jako tenant-scoped
//     plán/limity -- Subscription zde je DOPLŇKOVÁ entita: platební
//     historie/stav konkrétní platby, ne duplicitní verze TenantPlan.
//     TenantPlan zůstává zdrojem pravdy pro plán/limity samotné.
//
// SCOPE (Jose): jen základní kontrakt. Žádné vlastní účetnictví, žádné
// automatické fakturační workflow (bod 5 zadání).

import type { CanonicalEntity, EntityId, Money, TenantId } from './base.js';

/**
 * Subscription -- jedna platební perioda/instance vůči TenantPlan.
 * `tenantId` dědí z CanonicalEntity (TenantScoped) -- žádné duplicitní pole.
 * ROZHODNUTO: váže se na existující core/tenant/types.ts TenantPlan přes
 * `tenantId` (TenantPlan je 1:1 s Tenant, ne samostatná entita s vlastním ID
 * -- viz core/tenant/types.ts, TenantPlan nemá `id` pole, jen `tenantId`).
 */
export interface Subscription extends CanonicalEntity {
    /** TBD: lifecycle states (ACTIVE/PAST_DUE/CANCELED?) -- TenantPlan.status už má
     * podobný enum ('ACTIVE'|'GRACE_PERIOD'|'SUSPENDED'|'CANCELED'), vztah mezi
     * Subscription.status a TenantPlan.status NEROZHODNUT -- nezaměňovat, ne
     * automaticky sloučit. */
    status: string;
    amount: Money;
    periodStart: string;
    periodEnd: string;
}

/**
 * BillingEvent -- jednotlivá platební transakce (charge/refund) vůči
 * Subscription. Append-only vzor stejně jako core/audit/AuditRecord.ts --
 * historie plateb se nikdy nemaže/nepřepisuje.
 */
export interface BillingEvent extends CanonicalEntity {
    readonly subscriptionId: EntityId;
    /** TBD: konkrétní typ hodnot (CHARGE/REFUND/ADJUSTMENT?) -- nerozhodnuto. */
    eventType: string;
    amount: Money;
    occurredAt: string;
}

/**
 * ROZHODNUTO (Jose 2026-09-05): Billing -> Tenant/TenantPlan, Billing !=
 * Invoice (viz Invoice.ts). Zbývající OPEN QUESTIONS (business rule detail,
 * mimo scope Fáze 6 kostry):
 *
 * 1. Vztah Subscription.status <-> TenantPlan.status -- jsou to nezávislé
 *    osy, nebo Subscription.status je odvozený z TenantPlan.status?
 * 2. Kdo Subscription/BillingEvent vytváří (platební brána webhook?
 *    manuální zápis?) -- EXPLICITNĚ MIMO SCOPE (Jose bod 5: "žádné vlastní
 *    účetnictví", analogicky žádné platební workflow bez dalšího zadání).
 * 3. eventType konkrétní hodnoty -- nerozhodnuto.
 */
