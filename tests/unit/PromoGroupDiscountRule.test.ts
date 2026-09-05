// Fáze 6.5 Domain Rules -- domains/campaign/PromoGroupDiscountRule.ts.
// Josovo zadání 2026-09-05 (přesná citace): "PromoGroup se aplikuje na
// currentPrice... Engine porovná: cenu bez PromoGroup, cenu po
// PromoGroup. Vyhraje nižší platná cena." + "nemá automaticky sčítat se
// s ostatními slevami" + "finální výsledek je minimum z currentPrice a
// promoPrice".

import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { PromoGroupDiscountRule } from '../../domains/campaign/PromoGroupDiscountRule.js';
import type { PromoGroup } from '../../core/canonical/entities/Campaign.js';

const ctx = { tenantId: 'ten_1', ruleId: 'test', ruleVersion: '1' };
const now = '2026-09-05T00:00:00Z';

function makePromoGroup(overrides: Partial<PromoGroup> = {}): PromoGroup {
    return {
        id: 'promo_1',
        tenantId: 'ten_1',
        createdAt: now,
        updatedAt: now,
        name: 'Test promo',
        productIds: ['prod_1'],
        priority: 10,
        ...overrides,
    };
}

describe('PromoGroupDiscountRule', () => {
    const rule = new PromoGroupDiscountRule(ctx);

    it('bez vítězné PromoGroup vrací currentPrice beze změny (žádná promo vrstva se neuplatní)', () => {
        const result = rule.evaluate({ currentPrice: new Decimal('225') });
        expect(result.finalPrice.toString()).toBe('225');
        expect(result.source).toBe('CURRENT_PRICE');
        expect(result.promoPrice).toBeUndefined();
    });

    it('vítězná PromoGroup BEZ nakonfigurované slevy vrací currentPrice beze změny', () => {
        const group = makePromoGroup(); // discount není nastavena
        const result = rule.evaluate({ currentPrice: new Decimal('225'), winningPromoGroup: group });
        expect(result.finalPrice.toString()).toBe('225');
        expect(result.source).toBe('CURRENT_PRICE');
    });

    it('PERCENTAGE sleva nižší než currentPrice vyhrává jako promo cena', () => {
        const group = makePromoGroup({ discount: { type: 'PERCENTAGE', value: 0.1 } });
        const result = rule.evaluate({ currentPrice: new Decimal('225'), winningPromoGroup: group });
        // 225 * (1 - 0.1) = 202.5
        expect(result.finalPrice.toString()).toBe('202.5');
        expect(result.source).toBe('PROMO_GROUP');
        expect(result.promoPrice?.toString()).toBe('202.5');
    });

    it('FIXED_AMOUNT sleva odečítá absolutní částku z currentPrice', () => {
        const group = makePromoGroup({ discount: { type: 'FIXED_AMOUNT', value: 50 } });
        const result = rule.evaluate({ currentPrice: new Decimal('225'), winningPromoGroup: group });
        expect(result.finalPrice.toString()).toBe('175');
        expect(result.source).toBe('PROMO_GROUP');
    });

    it('FIXED_AMOUNT sleva vyšší než currentPrice se ořízne na 0, ne do záporu', () => {
        const group = makePromoGroup({ discount: { type: 'FIXED_AMOUNT', value: 500 } });
        const result = rule.evaluate({ currentPrice: new Decimal('225'), winningPromoGroup: group });
        expect(result.finalPrice.toString()).toBe('0');
        expect(result.source).toBe('PROMO_GROUP');
    });

    it('PromoGroup NIKDY nezdraží cenu -- pokud by promo cena byla vyšší než currentPrice, vyhrává currentPrice', () => {
        // Konstrukčně nemožné s PERCENTAGE/FIXED_AMOUNT (obojí vždy snižuje
        // nebo rovná se), ale test ověřuje invariant "nižší vyhrává" explicitně
        // přes hraniční 0% slevu -- promoPrice === currentPrice, CURRENT_PRICE vítězí.
        const group = makePromoGroup({ discount: { type: 'PERCENTAGE', value: 0 } });
        const result = rule.evaluate({ currentPrice: new Decimal('225'), winningPromoGroup: group });
        expect(result.finalPrice.toString()).toBe('225');
        // Přesná shoda -- zdroj zůstává CURRENT_PRICE (deterministické, ne PROMO_GROUP i při remíze).
        expect(result.source).toBe('CURRENT_PRICE');
        expect(result.promoPrice?.toString()).toBe('225');
    });

    it('PromoGroup se NESČÍTÁ s jinými slevami -- currentPrice už zahrnuje sale/loyalty/limit výsledek, Rule ho bere jako jediný vstup', () => {
        // currentPrice = 225 reprezentuje H-KLUB cenu PO Pricing chainu (např.
        // 250 základní -> 225 po 10% loyalty slevě). PromoGroup 10% se aplikuje
        // NA TOTO, ne na basePrice 250 -- výsledek 202.5, NE 250*(1-0.1-0.1)=200.
        const group = makePromoGroup({ discount: { type: 'PERCENTAGE', value: 0.1 } });
        const currentPriceAfterLoyalty = new Decimal('225'); // 250 * 0.9
        const result = rule.evaluate({ currentPrice: currentPriceAfterLoyalty, winningPromoGroup: group });
        expect(result.finalPrice.toString()).toBe('202.5'); // 225 * 0.9, NE 200
    });

    it('PERCENTAGE hodnota nad 1 je defenzivně ořezána (config chyba nesmí vytvořit zápornou cenu)', () => {
        const group = makePromoGroup({ discount: { type: 'PERCENTAGE', value: 5 } }); // neplatný config, 500%
        const result = rule.evaluate({ currentPrice: new Decimal('225'), winningPromoGroup: group });
        expect(result.finalPrice.greaterThanOrEqualTo(0)).toBe(true);
    });

    it('je pure function -- stejný vstup vždy stejný výstup (determinismus, Rule.ts kontrakt)', () => {
        const group = makePromoGroup({ discount: { type: 'PERCENTAGE', value: 0.15 } });
        const input = { currentPrice: new Decimal('300'), winningPromoGroup: group };
        const first = rule.evaluate(input);
        const second = rule.evaluate(input);
        expect(first.finalPrice.toString()).toBe(second.finalPrice.toString());
        expect(first.source).toBe(second.source);
    });
});
