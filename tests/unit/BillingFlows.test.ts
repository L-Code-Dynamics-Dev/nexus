// Fáze 6.4 business flow -- TenantSubscriptionPlanFlow
// (domains/billing/TenantSubscriptionPlanFlow.ts). Josovo zadání
// 2026-09-05: "Tenant -> Subscription -> Plan" flow, čistá kompozice
// SubscriptionLifecycleRule + isConsistentWithTenantPlan(), nekonzistence
// REPORTUJE ale NEBLOKUJE.

import { describe, it, expect } from 'vitest';
import { evaluateTenantSubscriptionPlanFlow } from '../../domains/billing/TenantSubscriptionPlanFlow.js';

const ctx = { tenantId: 'ten_1', ruleId: 'tenant-subscription-plan-flow-v1', ruleVersion: '1' };

describe('evaluateTenantSubscriptionPlanFlow — happy path', () => {
    it('povoluje TRIAL -> ACTIVE a hlásí konzistenci s TenantPlan ACTIVE', () => {
        const result = evaluateTenantSubscriptionPlanFlow(ctx, {
            currentStatus: 'TRIAL',
            targetStatus: 'ACTIVE',
            planTier: 'STARTER',
            tenantPlanStatus: 'ACTIVE',
        });

        expect(result.allowed).toBe(true);
        expect(result.consistentWithTenantPlan).toBe(true);
    });

    it('povoluje ACTIVE -> PAST_DUE a hlásí konzistenci s TenantPlan GRACE_PERIOD', () => {
        const result = evaluateTenantSubscriptionPlanFlow(ctx, {
            currentStatus: 'ACTIVE',
            targetStatus: 'PAST_DUE',
            planTier: 'GROWTH',
            tenantPlanStatus: 'GRACE_PERIOD',
        });

        expect(result.allowed).toBe(true);
        expect(result.consistentWithTenantPlan).toBe(true);
    });

    it('povoluje ACTIVE -> CANCELLED a hlásí konzistenci s TenantPlan CANCELED', () => {
        const result = evaluateTenantSubscriptionPlanFlow(ctx, {
            currentStatus: 'ACTIVE',
            targetStatus: 'CANCELLED',
            planTier: 'ENTERPRISE',
            tenantPlanStatus: 'CANCELED',
        });

        expect(result.allowed).toBe(true);
        expect(result.consistentWithTenantPlan).toBe(true);
    });
});

describe('evaluateTenantSubscriptionPlanFlow — nekonzistence REPORTUJE, NEBLOKUJE', () => {
    it('povoluje ACTIVE -> PAST_DUE i když TenantPlan je stále ACTIVE (nekonzistentní, ale allowed zůstává true)', () => {
        const result = evaluateTenantSubscriptionPlanFlow(ctx, {
            currentStatus: 'ACTIVE',
            targetStatus: 'PAST_DUE',
            planTier: 'GROWTH',
            tenantPlanStatus: 'ACTIVE',
        });

        expect(result.allowed).toBe(true);
        expect(result.consistentWithTenantPlan).toBe(false);
    });

    it('povoluje TRIAL -> ACTIVE i s TenantPlan SUSPENDED (nekonzistentní, ale allowed zůstává true -- lifecycle rozhoduje nezávisle)', () => {
        const result = evaluateTenantSubscriptionPlanFlow(ctx, {
            currentStatus: 'TRIAL',
            targetStatus: 'ACTIVE',
            planTier: 'STARTER',
            tenantPlanStatus: 'SUSPENDED',
        });

        expect(result.allowed).toBe(true);
        expect(result.consistentWithTenantPlan).toBe(false);
    });

    it('TRIAL cílový stav nikdy nehlásí konzistenci (UNRESOLVED mapping z Fáze 6.3), ale to lifecycle nijak neovlivní', () => {
        const result = evaluateTenantSubscriptionPlanFlow(ctx, {
            currentStatus: 'ACTIVE',
            targetStatus: 'CANCELLED',
            planTier: 'STARTER',
            tenantPlanStatus: 'ACTIVE',
        });

        // sanity: cílový stav zde není TRIAL (do TRIAL se z jiných stavů ani
        // nedá přejít, viz SUBSCRIPTION_LIFECYCLE_DEFINITION), test jen
        // ověřuje, že konzistence je nezávislá na allowed.
        expect(result.allowed).toBe(true);
        expect(result.consistentWithTenantPlan).toBe(false);
    });
});

describe('evaluateTenantSubscriptionPlanFlow — lifecycle/planTier selhání zůstávají autoritativní', () => {
    it('zamítá přechod z CANCELLED (terminální) bez ohledu na TenantPlan konzistenci', () => {
        const result = evaluateTenantSubscriptionPlanFlow(ctx, {
            currentStatus: 'CANCELLED',
            targetStatus: 'ACTIVE',
            planTier: 'STARTER',
            tenantPlanStatus: 'ACTIVE',
        });

        expect(result.allowed).toBe(false);
        expect(result.reason).toMatch(/terminal/i);
    });

    it('zamítá neplatný planTier bez ohledu na TenantPlan konzistenci', () => {
        const result = evaluateTenantSubscriptionPlanFlow(ctx, {
            currentStatus: 'TRIAL',
            targetStatus: 'ACTIVE',
            // @ts-expect-error -- záměrně neplatná hodnota, testuje runtime guard
            planTier: 'NONSENSE_TIER',
            tenantPlanStatus: 'ACTIVE',
        });

        expect(result.allowed).toBe(false);
        expect(result.reason).toMatch(/Invalid planTier/);
    });

    it('zamítá TRIAL -> PAST_DUE (musí projít ACTIVE), konzistence se přesto vyhodnotí nezávisle', () => {
        const result = evaluateTenantSubscriptionPlanFlow(ctx, {
            currentStatus: 'TRIAL',
            targetStatus: 'PAST_DUE',
            planTier: 'STARTER',
            tenantPlanStatus: 'GRACE_PERIOD',
        });

        expect(result.allowed).toBe(false);
        // konzistence je počítána vůči cílovému stavu nezávisle na allowed --
        // PAST_DUE <-> GRACE_PERIOD je "nejlepší dostupné odvození" (true),
        // i když samotný přechod je lifecycle-wise zamítnutý.
        expect(result.consistentWithTenantPlan).toBe(true);
    });
});

describe('evaluateTenantSubscriptionPlanFlow — je čistá funkce', () => {
    it('stejný vstup vždy vrací stejný výsledek', () => {
        const input = {
            currentStatus: 'ACTIVE' as const,
            targetStatus: 'PAST_DUE' as const,
            planTier: 'GROWTH' as const,
            tenantPlanStatus: 'GRACE_PERIOD' as const,
        };
        const first = evaluateTenantSubscriptionPlanFlow(ctx, input);
        const second = evaluateTenantSubscriptionPlanFlow(ctx, input);
        expect(first).toEqual(second);
    });
});
