// BestCandidatePriceRule -- Fáze 6.5 pokračování. Josovo zadání: "PromoGroup,
// QuantityTier a další mechanismy jsou kandidáti, ne automatické sčítání
// slev. Výsledkem je vždy nejnižší platná cena, nikoliv kombinace všech
// procent." + "případ, kdy promo nebo quantity kandidát vyjde vyšší než
// současná cena -> nesmí zdražit."

import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { BestCandidatePriceRule } from '../../domains/pricing/BestCandidatePriceRule.js';

const ctx = { tenantId: 'ten_1', ruleId: 'test', ruleVersion: '1' };

describe('BestCandidatePriceRule', () => {
    const rule = new BestCandidatePriceRule(ctx);

    it('bez žádných kandidátů vrací currentPrice', () => {
        const result = rule.evaluate({ currentPrice: new Decimal('225') });
        expect(result.finalPrice.toString()).toBe('225');
        expect(result.winningSource).toBe('CURRENT_PRICE');
        expect(result.candidates).toHaveLength(1);
    });

    it('PromoGroup kandidát nižší než currentPrice vyhrává', () => {
        const result = rule.evaluate({
            currentPrice: new Decimal('225'),
            promoGroupCandidate: new Decimal('200'),
        });
        expect(result.finalPrice.toString()).toBe('200');
        expect(result.winningSource).toBe('PROMO_GROUP');
    });

    it('QuantityTier kandidát nižší než currentPrice vyhrává', () => {
        const result = rule.evaluate({
            currentPrice: new Decimal('225'),
            quantityTierCandidate: new Decimal('207'),
        });
        expect(result.finalPrice.toString()).toBe('207');
        expect(result.winningSource).toBe('QUANTITY_TIER');
    });

    it('oba kandidáti přítomní -- vyhrává absolutně nejnižší, NE součet slev', () => {
        const result = rule.evaluate({
            currentPrice: new Decimal('225'),
            promoGroupCandidate: new Decimal('202.5'), // 10% promo
            quantityTierCandidate: new Decimal('207'), // 8% quantity
        });
        // Nejnižší je 202.5 (PromoGroup), NE 225*(1-0.1-0.08)=184.5 (sečtené procento)
        expect(result.finalPrice.toString()).toBe('202.5');
        expect(result.winningSource).toBe('PROMO_GROUP');
    });

    it('kandidát vyšší než currentPrice NIKDY nezdraží -- currentPrice zůstává vítězem', () => {
        const result = rule.evaluate({
            currentPrice: new Decimal('225'),
            promoGroupCandidate: new Decimal('250'), // hypoteticky vyšší (např. chybná config)
        });
        expect(result.finalPrice.toString()).toBe('225');
        expect(result.winningSource).toBe('CURRENT_PRICE');
    });

    it('oba kandidáti vyšší než currentPrice -- currentPrice pořád vyhrává', () => {
        const result = rule.evaluate({
            currentPrice: new Decimal('225'),
            promoGroupCandidate: new Decimal('230'),
            quantityTierCandidate: new Decimal('240'),
        });
        expect(result.finalPrice.toString()).toBe('225');
        expect(result.winningSource).toBe('CURRENT_PRICE');
    });

    it('přesná shoda mezi kandidáty -- currentPrice má prioritu (deterministické)', () => {
        const result = rule.evaluate({
            currentPrice: new Decimal('225'),
            promoGroupCandidate: new Decimal('225'),
        });
        expect(result.winningSource).toBe('CURRENT_PRICE');
    });

    it('je pure function -- determinismus', () => {
        const input = {
            currentPrice: new Decimal('225'),
            promoGroupCandidate: new Decimal('202.5'),
            quantityTierCandidate: new Decimal('207'),
        };
        const first = rule.evaluate(input);
        const second = rule.evaluate(input);
        expect(first.finalPrice.toString()).toBe(second.finalPrice.toString());
        expect(first.winningSource).toBe(second.winningSource);
    });
});
