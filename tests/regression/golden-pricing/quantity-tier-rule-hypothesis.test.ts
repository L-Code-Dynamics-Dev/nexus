// HYPOTHESIS TEST -- ne golden regression parity (žádný legacy oracle
// existuje, QuantityTier nikdy v legacy nebyl implementován, viz
// docs/entity-audit/Price-PriceList-QuantityTier.md). Testuje jen interní
// konzistenci placeholder implementace hypotézy C
// (docs/design-proposals/QuantityTier-Hecmania.md) -- NENÍ důkaz správnosti
// vůči obchodní realitě Hecmanie, protože feed data ještě nejsou k
// dispozici (design proposal §4 zůstává otevřený).
//
// QuantityTierRule NENÍ napojena do createNexusPricingCalculator --
// zůstává izolovaný modul, dokud nepadnou rozhodnutí v design proposalu §8.

import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { QuantityTierRule, type QuantityTierRuleInput } from '../../../domains/pricing/QuantityTierRule.js';
import type { QuantityTierBreakpoint } from '../../../core/canonical/entities/Price.js';

const HECMANIA_HYPOTHESIS_BREAKPOINTS: QuantityTierBreakpoint[] = [
    { minQuantity: 1, maxQuantity: 2, discountPercent: 0 },
    { minQuantity: 3, maxQuantity: 5, discountPercent: 0.03 },
    { minQuantity: 6, maxQuantity: 9, discountPercent: 0.05 },
    { minQuantity: 10, maxQuantity: 19, discountPercent: 0.08 },
    { minQuantity: 20, discountPercent: 0.12 },
];

describe('QuantityTierRule — hypothesis C placeholder', () => {
    const rule = new QuantityTierRule({ tenantId: 'ten_1', ruleId: 'quantity-tier-v1-hypothesis', ruleVersion: '1' });

    it('worked example from proposal: BASE 250 -> H-KLUB 225 -> QUANTITY 8% -> 207', () => {
        // POZNÁMKA: Josův worked example v design-diskuzi použil "quantity
        // 8 -> 8%", ale jeho vlastní breakpoint tabulka má 8 ks v pásmu
        // 6-9 -> 5%, ne 10-19 -> 8%. Nekonzistence mezi worked example a
        // breakpoint tabulkou -- test proto použije quantity 10 (první ks
        // v 8% pásmu), aby ověřil worked example VÝPOČET (225 * 0.92 = 207),
        // ne konkrétní breakpoint hranici. Až padne rozhodnutí o skutečných
        // Hecmania breakpointech, tohle se má přepsat na reálná čísla.
        const result = rule.evaluate({
            sourcePrice: new Decimal('225'),
            totalQuantity: 10,
            breakpoints: HECMANIA_HYPOTHESIS_BREAKPOINTS,
        });

        expect(result.applied).toBe(true);
        expect(result.price?.toString()).toBe('207');
        expect(result.matchedBreakpoint?.discountPercent).toBe(0.08); // 10-19 ks tier
    });

    const breakpointCases: { name: string; quantity: number; expectedDiscount: number | null }[] = [
        { name: 'quantity 1 -> 0% tier (no discount)', quantity: 1, expectedDiscount: 0 },
        { name: 'quantity 2 -> still 0% tier (upper boundary)', quantity: 2, expectedDiscount: 0 },
        { name: 'quantity 3 -> 3% tier (lower boundary)', quantity: 3, expectedDiscount: 0.03 },
        { name: 'quantity 5 -> still 3% tier (upper boundary)', quantity: 5, expectedDiscount: 0.03 },
        { name: 'quantity 6 -> 5% tier (lower boundary)', quantity: 6, expectedDiscount: 0.05 },
        { name: 'quantity 9 -> still 5% tier (upper boundary)', quantity: 9, expectedDiscount: 0.05 },
        { name: 'quantity 10 -> 8% tier (lower boundary)', quantity: 10, expectedDiscount: 0.08 },
        { name: 'quantity 19 -> still 8% tier (upper boundary)', quantity: 19, expectedDiscount: 0.08 },
        { name: 'quantity 20 -> 12% tier (open-ended, no maxQuantity)', quantity: 20, expectedDiscount: 0.12 },
        { name: 'quantity 1000 -> still 12% tier (open-ended holds for any large quantity)', quantity: 1000, expectedDiscount: 0.12 },
        { name: 'quantity 0 -> no breakpoint matches -> not applied', quantity: 0, expectedDiscount: null },
    ];

    for (const { name, quantity, expectedDiscount } of breakpointCases) {
        it(name, () => {
            const result = rule.evaluate({
                sourcePrice: new Decimal('100'),
                totalQuantity: quantity,
                breakpoints: HECMANIA_HYPOTHESIS_BREAKPOINTS,
            });

            if (expectedDiscount === null) {
                expect(result.applied).toBe(false);
                expect(result.price).toBeUndefined();
            } else {
                expect(result.applied).toBe(expectedDiscount > 0);
                if (expectedDiscount > 0) {
                    const expectedPrice = new Decimal('100').mul(new Decimal(1).minus(expectedDiscount));
                    expect(result.price?.toString()).toBe(expectedPrice.toString());
                }
            }
        });
    }

    it('empty breakpoints array -> never applied, regardless of quantity', () => {
        const result = rule.evaluate({ sourcePrice: new Decimal('100'), totalQuantity: 50, breakpoints: [] });
        expect(result.applied).toBe(false);
    });

    it('overlapping breakpoints -> picks the one with higher minQuantity (most specific match)', () => {
        // Edge case ne z proposalu, ale config by mohl být chybně sestaven --
        // Rule musí mít deterministické chování i na "neplatný" config, ne throw.
        const overlapping: QuantityTierBreakpoint[] = [
            { minQuantity: 1, maxQuantity: 100, discountPercent: 0.02 },
            { minQuantity: 10, maxQuantity: 100, discountPercent: 0.08 },
        ];
        const result = rule.evaluate({ sourcePrice: new Decimal('100'), totalQuantity: 15, breakpoints: overlapping });
        expect(result.matchedBreakpoint?.discountPercent).toBe(0.08);
    });

    it('quantity below the lowest breakpoint minQuantity -> not applied', () => {
        const result = rule.evaluate({
            sourcePrice: new Decimal('100'),
            totalQuantity: -1, // neplatné množství, ale Rule nesmí spadnout, jen nic neaplikuje
            breakpoints: HECMANIA_HYPOTHESIS_BREAKPOINTS,
        });
        expect(result.applied).toBe(false);
    });

    it('is a pure function — same input always yields same output (determinism requirement, Rule.ts)', () => {
        const input: QuantityTierRuleInput = {
            sourcePrice: new Decimal('225'),
            totalQuantity: 8,
            breakpoints: HECMANIA_HYPOTHESIS_BREAKPOINTS,
        };
        const first = rule.evaluate(input);
        const second = rule.evaluate(input);
        expect(first).toEqual(second);
    });
});

describe('QuantityTierRule — chain integration sketch (NOT wired into createNexusPricingCalculator)', () => {
    // Ukazuje, jak by se QuantityTierRule volala MEZI DiscountLimitRule a
    // RoundingRule, kdyby design proposal §6 (batch/live otázka) byla
    // vyřešena a rozhodnutí padlo pro zapojení. Toto NENÍ produkční kód --
    // je to jen ověření, že navržená chain pozice (design proposal §1)
    // dává smysl na golden-style příkladu.

    it('sketch: base 250 -> H-KLUB 10% -> quantity 8% (qty 10) -> rounding', () => {
        const quantityRule = new QuantityTierRule({ tenantId: 'ten_1', ruleId: 'quantity-tier-v1-hypothesis', ruleVersion: '1' });

        const basePrice = new Decimal('250');
        // Simulace HighestDiscountRule výstupu (H-KLUB 10%) -- ne skutečné volání,
        // jen fixní hodnota pro sketch.
        const afterCustomerTier = basePrice.mul(new Decimal('0.90')); // 225
        // Simulace DiscountLimitRule -- žádný limit aktivní v tomto scénáři, no-op.
        const afterDiscountLimit = afterCustomerTier; // 225

        const quantityResult = quantityRule.evaluate({
            sourcePrice: afterDiscountLimit,
            totalQuantity: 10, // 10-19 ks pásmo -> 8%, viz poznámka u worked example výše
            breakpoints: HECMANIA_HYPOTHESIS_BREAKPOINTS,
        });

        const finalPrice = quantityResult.applied && quantityResult.price ? quantityResult.price : afterDiscountLimit;
        // RoundingRule by zaokrouhlila na 2 des. místa -- zde už celé číslo.
        expect(finalPrice.toFixed(2)).toBe('207.00');
    });
});
