// Fáze 6.4 business flows -- domains/campaign/CampaignFlows.ts. Josovo
// zadání: "Campaign -> PromoGroup -> Product", "Campaign evaluation
// ACTIVE / PAUSED", "PromoGroup conflict resolution", "Creative
// publication" -- čistá kompozice existujících Fáze 6.2/6.3 Rules, žádná
// nová business logika (viz komentáře v CampaignFlows.ts).

import { describe, it, expect } from 'vitest';
import {
    resolveCampaignPromoGroupForProduct,
    evaluateCampaignForProduct,
    publishCreative,
} from '../../domains/campaign/CampaignFlows.js';
import type { Campaign, PromoGroup, Creative } from '../../core/canonical/entities/Campaign.js';

const ctx = { tenantId: 'ten_1', ruleId: 'test', ruleVersion: '1' };
const now = '2026-09-05T00:00:00Z';
const earlier = '2026-09-01T00:00:00Z';

function makeCampaign(overrides: Partial<Campaign> = {}): Campaign {
    return {
        id: 'camp_1',
        tenantId: 'ten_1',
        createdAt: now,
        updatedAt: now,
        name: 'Test Campaign',
        status: 'ACTIVE',
        promoGroupIds: ['promo_a'],
        ...overrides,
    };
}

function makePromoGroup(overrides: Partial<PromoGroup> = {}): PromoGroup {
    return {
        id: 'promo_a',
        tenantId: 'ten_1',
        createdAt: now,
        updatedAt: now,
        name: 'Group A',
        productIds: ['prod_1'],
        priority: 10,
        ...overrides,
    };
}

function makeCreative(overrides: Partial<Creative> = {}): Creative {
    return {
        id: 'creative_1',
        tenantId: 'ten_1',
        createdAt: now,
        updatedAt: now,
        campaignId: 'camp_1',
        name: 'Banner',
        type: 'image',
        content: 'https://cdn.example.com/banner.jpg',
        status: 'DRAFT',
        ...overrides,
    };
}

describe('Flow 1 — resolveCampaignPromoGroupForProduct (Campaign -> PromoGroup -> Product)', () => {
    it('vrátí vítěznou PromoGroup, pokud Campaign obsahuje jedinou eligible skupinu', () => {
        const campaign = makeCampaign({ promoGroupIds: ['promo_a'] });
        const groupA = makePromoGroup({ id: 'promo_a', productIds: ['prod_1'] });

        const result = resolveCampaignPromoGroupForProduct(campaign, [groupA], 'prod_1');

        expect(result.resolved).toBe(true);
        expect(result.winner?.id).toBe('promo_a');
        expect(result.campaignId).toBe('camp_1');
        expect(result.productId).toBe('prod_1');
    });

    it('ignoruje PromoGroup, kterou Campaign NEobsahuje (i když produkt obsahuje)', () => {
        const campaign = makeCampaign({ promoGroupIds: ['promo_a'] });
        const groupA = makePromoGroup({ id: 'promo_a', productIds: ['prod_1'], priority: 5 });
        const groupB = makePromoGroup({ id: 'promo_b', productIds: ['prod_1'], priority: 100 });

        // groupB má vyšší priority, ale Campaign ji vůbec neobsahuje v promoGroupIds.
        const result = resolveCampaignPromoGroupForProduct(campaign, [groupA, groupB], 'prod_1');

        expect(result.resolved).toBe(true);
        expect(result.winner?.id).toBe('promo_a');
    });

    it('vrátí resolved: false, pokud žádná ze zahrnutých PromoGroup neobsahuje produkt', () => {
        const campaign = makeCampaign({ promoGroupIds: ['promo_a'] });
        const groupA = makePromoGroup({ id: 'promo_a', productIds: ['prod_other'] });

        const result = resolveCampaignPromoGroupForProduct(campaign, [groupA], 'prod_1');

        expect(result.resolved).toBe(false);
    });

    it('respektuje deterministický tie-break z resolveConflict() (createdAt) při shodné priority', () => {
        const campaign = makeCampaign({ promoGroupIds: ['promo_a', 'promo_b'] });
        const groupA = makePromoGroup({ id: 'promo_a', productIds: ['prod_1'], priority: 10, createdAt: now });
        const groupB = makePromoGroup({ id: 'promo_b', productIds: ['prod_1'], priority: 10, createdAt: earlier });

        const result = resolveCampaignPromoGroupForProduct(campaign, [groupA, groupB], 'prod_1');

        expect(result.resolved).toBe(true);
        expect(result.tieBreakApplied).toBe(true);
        expect(result.winner?.id).toBe('promo_b'); // starší createdAt vyhrává
    });
});

describe('Flow 2 — evaluateCampaignForProduct (Campaign evaluation ACTIVE/PAUSED)', () => {
    it('ACTIVE kampaň se vyhodnocuje a vrací Flow 1 výsledek', () => {
        const campaign = makeCampaign({ status: 'ACTIVE', promoGroupIds: ['promo_a'] });
        const groupA = makePromoGroup({ id: 'promo_a', productIds: ['prod_1'] });

        const result = evaluateCampaignForProduct(campaign, [groupA], 'prod_1');

        expect(result.evaluated).toBe(true);
        if (result.evaluated) {
            expect(result.resolved).toBe(true);
            expect(result.winner?.id).toBe('promo_a');
        }
    });

    it('PAUSED kampaň se NEVYHODNOCUJE (evaluated: false, žádný resolveConflict volán)', () => {
        const campaign = makeCampaign({ status: 'PAUSED', promoGroupIds: ['promo_a'] });
        const groupA = makePromoGroup({ id: 'promo_a', productIds: ['prod_1'] });

        const result = evaluateCampaignForProduct(campaign, [groupA], 'prod_1');

        expect(result.evaluated).toBe(false);
        if (!result.evaluated) {
            expect(result.reason).toContain('PAUSED');
        }
    });

    it('DRAFT kampaň se nevyhodnocuje', () => {
        const campaign = makeCampaign({ status: 'DRAFT' });
        const result = evaluateCampaignForProduct(campaign, [], 'prod_1');
        expect(result.evaluated).toBe(false);
    });

    it('ENDED kampaň se nevyhodnocuje', () => {
        const campaign = makeCampaign({ status: 'ENDED' });
        const result = evaluateCampaignForProduct(campaign, [], 'prod_1');
        expect(result.evaluated).toBe(false);
    });
});

describe('Flow 4 — publishCreative (Creative publication)', () => {
    it('publikuje validní DRAFT Creative s neprázdným content', () => {
        const creative = makeCreative({ status: 'DRAFT', content: 'https://cdn.example.com/banner.jpg' });

        const result = publishCreative(creative, ctx);

        expect(result.allowed).toBe(true);
        expect(result.creativeId).toBe('creative_1');
    });

    it('odmítne publikaci Creative s prázdným content', () => {
        const creative = makeCreative({ status: 'DRAFT', content: '' });

        const result = publishCreative(creative, ctx);

        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('content');
    });

    it('odmítne publikaci archivovaného Creative (terminální stav)', () => {
        const creative = makeCreative({ status: 'ARCHIVED', content: 'https://cdn.example.com/banner.jpg' });

        const result = publishCreative(creative, ctx);

        expect(result.allowed).toBe(false);
    });
});
