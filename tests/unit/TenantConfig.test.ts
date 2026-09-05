// core/tenant/types.ts -- TenantPolicy/TenantPlan/TenantScopedTierConfig
// testy. Zdroj: ~/safeorder-3.0/migrations/0001_initial_schema.sql
// (tenants, tenant_policies) + 0008_saas_onboarding_plans_and_lifecycle.sql
// (tenant_plans, tenant_policy_history) -- ověřeno přímo v SQL, ne podle
// MIGRATION_PLAN.md popisu (ten byl v jednom detailu nepřesný, viz commit
// historie: zmiňoval "tenant_policies/tenant_plans" bez rozlišení, že jde
// o dvě různé migrace, ne jednu).

import { describe, it, expect } from 'vitest';
import type { Tenant, TenantPlan, TenantPolicy, TenantPolicyHistoryEntry, TenantScopedTierConfig } from '../../core/tenant/types.js';

describe('core/tenant — Tenant + TenantPolicy + TenantPlan sestavení', () => {
    it('sestaví validní Tenant + TenantPolicy + TenantPlan trojici', () => {
        const tenant: Tenant = {
            id: 'ten_01H8X',
            tenantId: 'ten_01H8X',
            platform: 'shoptet',
            platformShopId: '812679',
            status: 'ACTIVE',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
        };

        const policy: TenantPolicy = {
            tenantId: tenant.id,
            policyVersion: 'policy-v1',
            reviewThreshold: 0.8,
            restrictThreshold: 1.8,
            signalRetentionDays: 90,
            codPolicyAction: 'RESTRICT_COD',
            networkEnabled: false,
        };

        const plan: TenantPlan = {
            tenantId: tenant.id,
            planTier: 'GROWTH',
            monthlyEvaluationLimit: 5000,
            monthlyEvaluationsUsed: 120,
            historyRetentionDays: 90,
            networkAccessAllowed: true,
            customRulesAllowed: false,
            status: 'ACTIVE',
            billingPeriodStart: '2026-09-01T00:00:00Z',
            billingPeriodEnd: '2026-10-01T00:00:00Z',
        };

        expect(policy.tenantId).toBe(tenant.id);
        expect(plan.tenantId).toBe(tenant.id);
        expect(plan.planTier).toBe('GROWTH');
    });

    it('TenantPolicyHistoryEntry zaznamenává diff, ne jen aktuální hodnotu', () => {
        const entry: TenantPolicyHistoryEntry = {
            id: 'hist_1',
            tenantId: 'ten_01H8X',
            policyVersion: 'policy-v2',
            configurationDiff: { restrictThreshold: { from: 1.8, to: 2.0 } },
            updatedBy: 'admin@l-code-dynamics.com',
            createdAt: '2026-09-05T00:00:00Z',
        };

        expect(entry.configurationDiff).toHaveProperty('restrictThreshold');
    });
});

describe('core/tenant — TenantScopedTierConfig nahrazuje hardcoded TIER_PRICELIST_MAP', () => {
    it('dva tenanti mají pro stejný tierKey jiné externí pricelist ID', () => {
        const tenantA: TenantScopedTierConfig = {
            tenantId: 'ten_A',
            tierToExternalPricelistId: { ZR20: '29', ZR4: '2' },
        };
        const tenantB: TenantScopedTierConfig = {
            tenantId: 'ten_B',
            tierToExternalPricelistId: { ZR20: '104', ZR4: '87' },
        };

        expect(tenantA.tierToExternalPricelistId.ZR20).toBe('29');
        expect(tenantB.tierToExternalPricelistId.ZR20).toBe('104');
        expect(tenantA.tierToExternalPricelistId.ZR20).not.toBe(tenantB.tierToExternalPricelistId.ZR20);
    });

    it('je čistě datový typ -- žádná platformová/business logika, jen mapování', () => {
        const config: TenantScopedTierConfig = { tenantId: 'ten_C', tierToExternalPricelistId: {} };
        expect(Object.keys(config.tierToExternalPricelistId)).toHaveLength(0);
    });
});
