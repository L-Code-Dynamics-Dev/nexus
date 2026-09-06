// Regresní parita XPlusXRule vs. legacy resolveXPlusXForVariant
// (~/hecmania-quantity-pricing/worker/src/promo/free-units.ts, port do
// connectors/pricing-engine/legacy/promo/free-units.ts) -- ověřuje, že
// Rule contract obal nezměnil žádné chování oproti originálu.

import { describe, it, expect } from 'vitest';
import { XPlusXRule } from '../../../domains/pricing/XPlusXRule.js';
import { resolveXPlusXForVariant } from '../../../connectors/pricing-engine/legacy/promo/free-units.js';

describe('XPlusXRule — parity with legacy resolveXPlusXForVariant', () => {
    const rule = new XPlusXRule({ tenantId: 'ten_1', ruleId: 'xplusx-v1', ruleVersion: '1' });
    const ratio = { paid: 2, free: 1 }; // cyklus = 3

    it('přesně jeden cyklus (3 ks celkem) -> 2 placené + 1 zdarma', () => {
        const result = rule.evaluate({ qty: 3, ratio });
        const legacy = resolveXPlusXForVariant(3, ratio);
        expect(result.paidQty).toBe(legacy.paidQty);
        expect(result.freeQty).toBe(legacy.freeQty);
        expect(result.inScope).toBe(true);
    });

    it('regresní test živého ověření: 20 ks celkem -> 14 placených + 6 zdarma', () => {
        const result = rule.evaluate({ qty: 20, ratio });
        const legacy = resolveXPlusXForVariant(20, ratio);
        expect(result.paidQty).toBe(14);
        expect(result.freeQty).toBe(6);
        expect(result).toMatchObject(legacy);
    });

    it('produkt mimo X+X scope (žádný ratio) -- vrací beze změny, inScope: false', () => {
        const result = rule.evaluate({ qty: 20 });
        expect(result.inScope).toBe(false);
        expect(result.paidQty).toBe(20);
        expect(result.freeQty).toBe(0);
        expect(result.totalReceivedQty).toBe(20);
    });

    it('0 ks -> žádné promo, unitsToNextRule = celý cyklus', () => {
        const result = rule.evaluate({ qty: 0, ratio });
        expect(result.paidQty).toBe(0);
        expect(result.freeQty).toBe(0);
        expect(result.unitsToNextRule).toBe(3);
    });

    it('je pure function -- determinismus (Rule.ts kontrakt)', () => {
        const input = { qty: 20, ratio };
        const first = rule.evaluate(input);
        const second = rule.evaluate(input);
        expect(first).toEqual(second);
    });
});
