// Billing / Subscription -- Fáze 6.1 lifecycle + invariants (Josovo zadání
// 2026-09-05: "Další kroky Fáze 6" + "Fáze 6.1 = lifecycle + základní
// invariants"). Čistě NEW BUILD.
//
// ROZHODNUTO (Jose):
//   - Model: Tenant -> Subscription -> Billing -> Plan. `Tenant` a `Plan`
//     už existují (core/tenant/types.ts: `Tenant`, `TenantPlan`) --
//     NEMĚNIT core/tenant/types.ts, jen se na něj vázat přes `tenantId`.
//   - Subscription lifecycle: TRIAL -> ACTIVE -> PAST_DUE -> CANCELLED.
//   - Billing řeší: který Tenant má jaký Plan (přes Subscription.tenantId
//     + TenantPlan.tenantId), jestli je subscription aktivní (lifecycle
//     status), billing period, stav platby, případně usage/limit.
//   - Invoice (core/canonical/entities/Invoice.ts, vazba na Order) do
//     tohohle VŮBEC nepatří -- STRIKTNĚ oddělené domény (Jose: "Invoice
//     z Order do toho vůbec nepatří"). Tento soubor NESMÍ importovat ani
//     referencovat Invoice.ts.
//   - NEIMPLEMENTOVAT: payment gateway, usage billing, automatickou
//     fakturaci -- jen kontrakt.
//
// SCOPE (Jose Fáze 6.1): lifecycle + invarianty. Žádná business logika,
// žádný trigger/workflow, žádné napojení na platební bránu.

import type { CanonicalEntity, EntityId, Money } from './base.js';
import type { PlanTier } from '../../tenant/types.js';
import type { StateAxisDefinition } from '../../state-machine/StateMachine.js';

/**
 * Subscription lifecycle -- ROZHODNUTO (Jose): TRIAL -> ACTIVE ->
 * PAST_DUE -> CANCELLED. TRIAL je zkušební období bez platby. ACTIVE je
 * platící/aktivní stav. PAST_DUE signalizuje selhanou platbu (obousměrný
 * návrat na ACTIVE povolen -- platba se může dodatečně vyrovnat, viz
 * TenantPlan.status 'GRACE_PERIOD' jako analogický, ale NEZÁVISLÝ koncept,
 * viz Open Questions níže). CANCELLED je terminální.
 */
export type SubscriptionLifecycleState = 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'CANCELLED';

export const SUBSCRIPTION_LIFECYCLE_DEFINITION: StateAxisDefinition<SubscriptionLifecycleState> = {
    axisName: 'subscriptionLifecycle',
    initialState: 'TRIAL',
    terminalStates: ['CANCELLED'],
    transitions: {
        TRIAL: ['ACTIVE', 'CANCELLED'],
        ACTIVE: ['PAST_DUE', 'CANCELLED'],
        PAST_DUE: ['ACTIVE', 'CANCELLED'],
        CANCELLED: [],
    },
};

/**
 * Subscription -- váže Tenant na Plan (přes `planTier`, stejný typ jako
 * `core/tenant/types.ts` `TenantPlan.planTier`) a nese vlastní platební
 * lifecycle nezávislý na `TenantPlan.status`. `tenantId` dědí z
 * CanonicalEntity (TenantScoped) -- žádné duplicitní pole.
 *
 * ROZHODNUTO: Subscription je DOPLŇKOVÁ entita k existujícímu
 * `TenantPlan` (core/tenant/types.ts) -- `TenantPlan` zůstává zdrojem
 * pravdy pro limity/tier konfiguraci, `Subscription` nese platební
 * lifecycle a billing period. Vztah mezi oběma stavovými poli
 * (`Subscription.status` vs. `TenantPlan.status`) je OPEN QUESTION níže,
 * NENÍ automaticky sloučen.
 */
export interface Subscription extends CanonicalEntity {
    status: SubscriptionLifecycleState;
    /** Stejný typ jako TenantPlan.planTier (core/tenant/types.ts) -- který Plan tenant má. */
    planTier: PlanTier;
    billingPeriodStart: string;
    billingPeriodEnd: string;
    /** TBD: přesný usage/limit shape -- TenantPlan už má monthlyEvaluationLimit/monthlyEvaluationsUsed, vztah k tomuto poli nerozhodnut. */
    usageLimit?: number;
    usageCurrent?: number;
}

/**
 * BillingEvent -- jednotlivá platební transakce (charge/refund) vůči
 * Subscription. Append-only vzor stejně jako core/audit/AuditRecord.ts --
 * historie plateb se nikdy nemaže/nepřepisuje. NENÍ napojeno na platební
 * bránu (payment gateway je explicitně mimo scope).
 */
export interface BillingEvent extends CanonicalEntity {
    readonly subscriptionId: EntityId;
    /** TBD: konkrétní typ hodnot (CHARGE/REFUND/ADJUSTMENT?) -- nerozhodnuto. */
    eventType: string;
    amount: Money;
    occurredAt: string;
}

/**
 * ROZHODNUTO (Jose 2026-09-05, Fáze 6.1): Tenant -> Subscription -> Billing
 * -> Plan model, Subscription lifecycle (TRIAL/ACTIVE/PAST_DUE/CANCELLED),
 * Billing striktně odděleno od Invoice/Order. Zbývající OPEN QUESTIONS
 * (business rule detail, EXPLICITNĚ MIMO SCOPE Fáze 6.1):
 *
 * 1. ROZHODNUTO (Fáze 6.3, bod 5): Vztah Subscription.status <->
 *    TenantPlan.status -- konzistenční kontrola (ne sync/přepis), viz
 *    `isConsistentWithTenantPlan()` v domains/billing/SubscriptionLifecycleRule.ts.
 *    Zbytkový UNRESOLVED: TRIAL a PAST_DUE<->GRACE_PERIOD mapování jsou
 *    nejlepší dostupné odvození ze jmen, ne jistota -- viz komentář tam.
 * 2. Kdo Subscription/BillingEvent vytváří (platební brána webhook? manuální
 *    zápis?) -- EXPLICITNĚ MIMO SCOPE (Jose: "žádné vlastní účetnictví",
 *    "žádný payment gateway", "žádné usage billing").
 * 3. usageLimit/usageCurrent přesný vztah k TenantPlan.monthlyEvaluationLimit/
 *    monthlyEvaluationsUsed -- duplicitní pole, nebo jiný typ usage? Nerozhodnuto.
 * 4. eventType konkrétní hodnoty -- nerozhodnuto.
 */
