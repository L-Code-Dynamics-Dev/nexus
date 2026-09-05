// Fáze 6.2 business rules -- SubscriptionLifecycleRule
// (domains/billing/SubscriptionLifecycleRule.ts). Josovo zadání
// 2026-09-05: "TRIAL -> ACTIVE -> PAST_DUE -> CANCELLED; respektuj
// existující Tenant/Plan model; žádné usage billing ani payment gateway;
// Invoice z objednávky je od Billingu vždy oddělená."

import { describe, it, expect } from 'vitest';
import { SubscriptionLifecycleRule, isConsistentWithTenantPlan } from '../../domains/billing/SubscriptionLifecycleRule.js';
import type { Subscription } from '../../core/canonical/entities/Billing.js';

describe('SubscriptionLifecycleRule — lifecycle přechody', () => {
    const rule = new SubscriptionLifecycleRule({ tenantId: 'ten_1', ruleId: 'subscription-lifecycle-v1', ruleVersion: '1' });

    it('povoluje TRIAL -> ACTIVE', () => {
        const result = rule.evaluate({ currentStatus: 'TRIAL', targetStatus: 'ACTIVE', planTier: 'STARTER' });
        expect(result.allowed).toBe(true);
    });

    it('povoluje ACTIVE -> PAST_DUE', () => {
        const result = rule.evaluate({ currentStatus: 'ACTIVE', targetStatus: 'PAST_DUE', planTier: 'GROWTH' });
        expect(result.allowed).toBe(true);
    });

    it('povoluje PAST_DUE -> ACTIVE (obousměrný návrat po vyrovnání platby)', () => {
        const result = rule.evaluate({ currentStatus: 'PAST_DUE', targetStatus: 'ACTIVE', planTier: 'GROWTH' });
        expect(result.allowed).toBe(true);
    });

    it('povoluje přechod na CANCELLED z libovolného nezterminálního stavu', () => {
        expect(rule.evaluate({ currentStatus: 'TRIAL', targetStatus: 'CANCELLED', planTier: 'STARTER' }).allowed).toBe(true);
        expect(rule.evaluate({ currentStatus: 'ACTIVE', targetStatus: 'CANCELLED', planTier: 'STARTER' }).allowed).toBe(true);
        expect(rule.evaluate({ currentStatus: 'PAST_DUE', targetStatus: 'CANCELLED', planTier: 'STARTER' }).allowed).toBe(true);
    });

    it('zamítá přechod z CANCELLED (terminální stav)', () => {
        const result = rule.evaluate({ currentStatus: 'CANCELLED', targetStatus: 'ACTIVE', planTier: 'STARTER' });
        expect(result.allowed).toBe(false);
        expect(result.reason).toMatch(/terminal/i);
    });

    it('zamítá přechod TRIAL -> PAST_DUE (musí projít ACTIVE)', () => {
        const result = rule.evaluate({ currentStatus: 'TRIAL', targetStatus: 'PAST_DUE', planTier: 'STARTER' });
        expect(result.allowed).toBe(false);
    });

    it('vrací transition detail konzistentní s core/state-machine evaluateTransition', () => {
        const result = rule.evaluate({ currentStatus: 'ACTIVE', targetStatus: 'PAST_DUE', planTier: 'ENTERPRISE' });
        expect(result.transition.fromState).toBe('ACTIVE');
        expect(result.transition.toState).toBe('PAST_DUE');
        expect(result.transition.allowed).toBe(true);
    });
});

describe('SubscriptionLifecycleRule — planTier validace (respektuje core/tenant/types.ts PlanTier, neduplikuje)', () => {
    const rule = new SubscriptionLifecycleRule({ tenantId: 'ten_1', ruleId: 'subscription-lifecycle-v1', ruleVersion: '1' });

    it.each(['STARTER', 'GROWTH', 'ENTERPRISE', 'CUSTOM'] as const)('přijímá platný planTier "%s"', (planTier) => {
        const result = rule.evaluate({ currentStatus: 'TRIAL', targetStatus: 'ACTIVE', planTier });
        expect(result.allowed).toBe(true);
    });

    it('zamítá neplatný planTier, i kdyby byl lifecycle přechod jinak povolený', () => {
        // @ts-expect-error -- záměrně neplatná hodnota mimo PlanTier union, testuje runtime guard
        const result = rule.evaluate({ currentStatus: 'TRIAL', targetStatus: 'ACTIVE', planTier: 'NONSENSE_TIER' });
        expect(result.allowed).toBe(false);
        expect(result.reason).toMatch(/Invalid planTier/);
    });
});

describe('Fáze 6.2 invariant — Subscription je striktně oddělená od Invoice/Order', () => {
    it('Subscription type nemá žádné pole odkazující na Invoice ani Order', () => {
        const subscription: Subscription = {
            id: 'sub_1',
            tenantId: 'ten_1',
            createdAt: '2026-09-05T00:00:00Z',
            updatedAt: '2026-09-05T00:00:00Z',
            status: 'ACTIVE',
            planTier: 'GROWTH',
            billingPeriodStart: '2026-09-01T00:00:00Z',
            billingPeriodEnd: '2026-10-01T00:00:00Z',
        };

        expect('invoiceId' in subscription).toBe(false);
        expect('orderId' in subscription).toBe(false);
        expect('omegaDocumentId' in subscription).toBe(false);
    });
});

describe('isConsistentWithTenantPlan — Fáze 6.3 bod 5 (Subscription <-> TenantPlan konzistence)', () => {
    it('ACTIVE <-> ACTIVE je konzistentní (jistá shoda)', () => {
        expect(isConsistentWithTenantPlan('ACTIVE', 'ACTIVE')).toBe(true);
    });

    it('CANCELLED <-> CANCELED je konzistentní (pozor na pravopis, jistá shoda)', () => {
        expect(isConsistentWithTenantPlan('CANCELLED', 'CANCELED')).toBe(true);
    });

    it('PAST_DUE <-> GRACE_PERIOD je konzistentní (nejlepší dostupné odvození)', () => {
        expect(isConsistentWithTenantPlan('PAST_DUE', 'GRACE_PERIOD')).toBe(true);
    });

    it('TRIAL nikdy nevrací true (UNRESOLVED mapping, fail-safe)', () => {
        expect(isConsistentWithTenantPlan('TRIAL', 'ACTIVE')).toBe(false);
        expect(isConsistentWithTenantPlan('TRIAL', 'GRACE_PERIOD')).toBe(false);
        expect(isConsistentWithTenantPlan('TRIAL', 'SUSPENDED')).toBe(false);
        expect(isConsistentWithTenantPlan('TRIAL', 'CANCELED')).toBe(false);
    });

    it('SUSPENDED (TenantPlan) není konzistentní s žádným Subscription stavem', () => {
        expect(isConsistentWithTenantPlan('ACTIVE', 'SUSPENDED')).toBe(false);
        expect(isConsistentWithTenantPlan('PAST_DUE', 'SUSPENDED')).toBe(false);
        expect(isConsistentWithTenantPlan('CANCELLED', 'SUSPENDED')).toBe(false);
    });

    it('nesprávné kombinace (ACTIVE proti GRACE_PERIOD/CANCELED) nejsou konzistentní', () => {
        expect(isConsistentWithTenantPlan('ACTIVE', 'GRACE_PERIOD')).toBe(false);
        expect(isConsistentWithTenantPlan('ACTIVE', 'CANCELED')).toBe(false);
        expect(isConsistentWithTenantPlan('CANCELLED', 'ACTIVE')).toBe(false);
        expect(isConsistentWithTenantPlan('CANCELLED', 'GRACE_PERIOD')).toBe(false);
        expect(isConsistentWithTenantPlan('PAST_DUE', 'ACTIVE')).toBe(false);
        expect(isConsistentWithTenantPlan('PAST_DUE', 'CANCELED')).toBe(false);
    });

    it('je čistá funkce — stejný vstup vždy vrací stejný výsledek', () => {
        expect(isConsistentWithTenantPlan('PAST_DUE', 'GRACE_PERIOD')).toBe(isConsistentWithTenantPlan('PAST_DUE', 'GRACE_PERIOD'));
    });
});
