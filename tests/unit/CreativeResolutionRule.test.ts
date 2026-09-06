// CreativeResolutionRule -- Fáze 6.5 Creative resolve logika (Josovo
// zadání 2026-09-06): "Campaign ACTIVE? -> Creative PUBLISHED? -> odpovídá
// placement? -> odpovídá produkt/PromoGroup? -> priority -> VYKRESLIT".

import { describe, it, expect } from 'vitest';
import { CreativeResolutionRule } from '../../domains/campaign/CreativeResolutionRule.js';
import type { Campaign, PromoGroup, Creative } from '../../core/canonical/entities/Campaign.js';

const ctx = { tenantId: 'ten_1', ruleId: 'test', ruleVersion: '1' };
const now = '2026-09-06T00:00:00Z';

function makeCampaign(overrides: Partial<Campaign> = {}): Campaign {
    return {
        id: 'camp_1', tenantId: 'ten_1', createdAt: now, updatedAt: now,
        name: 'Víkendová akce', status: 'ACTIVE', promoGroupIds: ['promo_1'],
        ...overrides,
    };
}

function makePromoGroup(overrides: Partial<PromoGroup> = {}): PromoGroup {
    return {
        id: 'promo_1', tenantId: 'ten_1', createdAt: now, updatedAt: now,
        name: 'Vybrané mikiny', productIds: ['mikina_a', 'mikina_b', 'mikina_c'], priority: 10,
        ...overrides,
    };
}

function makeCreative(overrides: Partial<Creative> = {}): Creative {
    return {
        id: 'creative_1', tenantId: 'ten_1', createdAt: now, updatedAt: now,
        campaignId: 'camp_1', name: 'Banner', type: 'image',
        content: 'https://cdn.example.com/banner.jpg', status: 'PUBLISHED',
        placementTypes: ['homepage', 'product'], priority: 0,
        ...overrides,
    };
}

describe('CreativeResolutionRule', () => {
    const rule = new CreativeResolutionRule(ctx);

    it('happy path -- produkt v PromoGroup, Campaign ACTIVE, Creative PUBLISHED, placement sedí -> vykreslit', () => {
        const result = rule.evaluate({
            campaign: makeCampaign(),
            creative: makeCreative(),
            allPromoGroups: [makePromoGroup()],
            placement: 'product',
            productId: 'mikina_a',
        });
        expect(result.shouldRender).toBe(true);
        expect(result.reason).toBeUndefined();
    });

    it('Campaign PAUSED -> nevykresluje se (CAMPAIGN_NOT_ACTIVE)', () => {
        const result = rule.evaluate({
            campaign: makeCampaign({ status: 'PAUSED' }),
            creative: makeCreative(),
            allPromoGroups: [makePromoGroup()],
            placement: 'product',
            productId: 'mikina_a',
        });
        expect(result.shouldRender).toBe(false);
        expect(result.reason).toBe('CAMPAIGN_NOT_ACTIVE');
    });

    it('Campaign ENDED -> nevykresluje se', () => {
        const result = rule.evaluate({
            campaign: makeCampaign({ status: 'ENDED' }),
            creative: makeCreative(),
            allPromoGroups: [makePromoGroup()],
            placement: 'product',
            productId: 'mikina_a',
        });
        expect(result.shouldRender).toBe(false);
        expect(result.reason).toBe('CAMPAIGN_NOT_ACTIVE');
    });

    it('Creative DRAFT -> nevykresluje se (CREATIVE_NOT_PUBLISHED)', () => {
        const result = rule.evaluate({
            campaign: makeCampaign(),
            creative: makeCreative({ status: 'DRAFT' }),
            allPromoGroups: [makePromoGroup()],
            placement: 'product',
            productId: 'mikina_a',
        });
        expect(result.shouldRender).toBe(false);
        expect(result.reason).toBe('CREATIVE_NOT_PUBLISHED');
    });

    it('Creative ARCHIVED -> nevykresluje se', () => {
        const result = rule.evaluate({
            campaign: makeCampaign(),
            creative: makeCreative({ status: 'ARCHIVED' }),
            allPromoGroups: [makePromoGroup()],
            placement: 'product',
            productId: 'mikina_a',
        });
        expect(result.shouldRender).toBe(false);
        expect(result.reason).toBe('CREATIVE_NOT_PUBLISHED');
    });

    it('placement neodpovídá žádnému z placementTypes -> PLACEMENT_MISMATCH', () => {
        const result = rule.evaluate({
            campaign: makeCampaign(),
            creative: makeCreative({ placementTypes: ['homepage'] }),
            allPromoGroups: [makePromoGroup()],
            placement: 'checkout',
            productId: 'mikina_a',
        });
        expect(result.shouldRender).toBe(false);
        expect(result.reason).toBe('PLACEMENT_MISMATCH');
    });

    it('produkt mimo PromoGroup scope (mikina X mimo Vybrané mikiny) -> PRODUCT_OUT_OF_SCOPE', () => {
        const result = rule.evaluate({
            campaign: makeCampaign(),
            creative: makeCreative(),
            allPromoGroups: [makePromoGroup()],
            placement: 'product',
            productId: 'mikina_x', // NENÍ v productIds PromoGroup
        });
        expect(result.shouldRender).toBe(false);
        expect(result.reason).toBe('PRODUCT_OUT_OF_SCOPE');
    });

    it('PromoGroup existuje, ale Campaign ji vůbec neobsahuje -> PRODUCT_OUT_OF_SCOPE', () => {
        const otherGroup = makePromoGroup({ id: 'promo_other', productIds: ['mikina_a'] });
        const result = rule.evaluate({
            campaign: makeCampaign({ promoGroupIds: ['promo_1'] }), // neobsahuje 'promo_other'
            creative: makeCreative(),
            allPromoGroups: [otherGroup],
            placement: 'product',
            productId: 'mikina_a',
        });
        expect(result.shouldRender).toBe(false);
        expect(result.reason).toBe('PRODUCT_OUT_OF_SCOPE');
    });

    it('je pure function -- determinismus', () => {
        const input = {
            campaign: makeCampaign(),
            creative: makeCreative(),
            allPromoGroups: [makePromoGroup()],
            placement: 'product',
            productId: 'mikina_a',
        };
        const first = rule.evaluate(input);
        const second = rule.evaluate(input);
        expect(first).toEqual(second);
    });
});
