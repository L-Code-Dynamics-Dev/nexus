// TenantSubscriptionPlanFlow -- Fáze 6.4 business flow (Josovo zadání
// 2026-09-05: "Tenant -> Subscription -> Plan" flow, "teď už bych nepřidával
// další abstrakce. Začal bych propojovat to, co jsme právě definovali, do
// reálných NEXUS use-caseů.").
//
// Tento soubor NEPŘIDÁVÁ žádné nové business rozhodnutí -- je to ČISTÁ
// KOMPOZICE dvou existujících stavebních kamenů z domains/billing/
// SubscriptionLifecycleRule.ts (Fáze 6.2/6.3):
//   1. SubscriptionLifecycleRule.evaluate() -- je požadovaný lifecycle
//      přechod povolený? Je planTier platný?
//   2. isConsistentWithTenantPlan() -- je Subscription.status v souladu
//      s TenantPlan.status (Fáze 6.3 bod 5 konzistenční kontrola)?
//
// KRITICKÉ (Jose): nekonzistence Subscription <-> TenantPlan je Fáze 6.3
// "konzistenční kontrola", NE blokující gate. Tenhle flow proto
// nekonzistenci nikdy nepoužívá k tomu, aby sám zamítl přechod (`allowed`
// pochází VÝHRADNĚ z SubscriptionLifecycleRule) -- jen ji REPORTUJE vedle
// lifecycle výsledku, aby volající měl obě informace pohromadě. Přidat
// blokování by bylo nové business rozhodnutí, které Jose nezadal.
//
// EXPLICITNĚ MIMO SCOPE (Jose "zatím vůbec neřešit"): subscription payment
// flow, TRIAL mapping, PAST_DUE/GRACE_PERIOD přesnost -- tenhle flow jen
// VOLÁ existující isConsistentWithTenantPlan(), nerozšiřuje ani neopravuje
// jeho známé UNRESOLVED chování (viz SubscriptionLifecycleRule.ts).

import type { RuleContext } from '../../core/canonical/rules/Rule.js';
import { SubscriptionLifecycleRule, isConsistentWithTenantPlan } from './SubscriptionLifecycleRule.js';
import type { SubscriptionLifecycleState } from '../../core/canonical/entities/Billing.js';
import type { PlanTier, TenantPlan } from '../../core/tenant/types.js';

export interface TenantSubscriptionPlanFlowInput {
    readonly currentStatus: SubscriptionLifecycleState;
    readonly targetStatus: SubscriptionLifecycleState;
    readonly planTier: PlanTier;
    /** Aktuální TenantPlan.status pro konzistenční kontrolu (core/tenant/types.ts). Volající dodává explicitně -- žádné I/O zde. */
    readonly tenantPlanStatus: TenantPlan['status'];
}

export interface TenantSubscriptionPlanFlowResult {
    /** Je požadovaný lifecycle přechod (+ planTier validace) povolený -- POCHÁZÍ VÝHRADNĚ z SubscriptionLifecycleRule, konzistence ho nikdy neovlivňuje. */
    readonly allowed: boolean;
    readonly reason?: string;
    /** Je Subscription.status v souladu s aktuálním TenantPlan.status -- Fáze 6.3 bod 5, čistě informační. */
    readonly consistentWithTenantPlan: boolean;
}

/**
 * Skládá SubscriptionLifecycleRule + isConsistentWithTenantPlan() do jednoho
 * use-case výsledku pro přechod Subscription v kontextu daného Tenant/Plan.
 * Čistá funkce, žádné I/O -- Tenant/TenantPlan záznamy dodává volající.
 */
export function evaluateTenantSubscriptionPlanFlow(
    context: RuleContext,
    input: TenantSubscriptionPlanFlowInput
): TenantSubscriptionPlanFlowResult {
    const lifecycleRule = new SubscriptionLifecycleRule(context);
    const lifecycleResult = lifecycleRule.evaluate({
        currentStatus: input.currentStatus,
        targetStatus: input.targetStatus,
        planTier: input.planTier,
    });

    // Konzistence se počítá vůči CÍLOVÉMU (target) stavu -- to je stav, ve
    // kterém by Subscription byla PO přechodu, tedy ten, co se má porovnávat
    // s aktuálním TenantPlan.status. Konzistence NIKDY neovlivňuje `allowed`
    // (viz hlavička souboru) -- jen se reportuje vedle lifecycle výsledku.
    const consistentWithTenantPlan = isConsistentWithTenantPlan(input.targetStatus, input.tenantPlanStatus);

    return {
        allowed: lifecycleResult.allowed,
        reason: lifecycleResult.reason,
        consistentWithTenantPlan,
    };
}
