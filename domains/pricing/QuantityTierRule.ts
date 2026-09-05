// QuantityTierRule -- PLACEHOLDER implementace hypotézy C z
// docs/design-proposals/QuantityTier-Hecmania.md. NENÍ napojena do
// createNexusPricingCalculator (batch/live otázka §6 zatím nerozhodnuta) --
// izolovaný modul k otestování designu, ne produkční rozhodnutí.
//
// Vstup je záměrně `sourcePrice` (cena PO HighestDiscountRule +
// DiscountLimitRule, PŘED RoundingRule), ne `basePrice` -- viz design
// proposal §1: množstevní sleva se počítá ze zákaznické ceny, ne z
// originální ceny (250 -> 225 H-KLUB -> 207 quantity, ne 250 -> 230).
//
// Group membership (QuantityTierGroup.memberProductSkus) je zatím
// explicitní ruční seznam -- design proposal §4 zůstává otevřený (jak se
// group reálně definuje v Hecmania feedu). Total quantity napříč group je
// odpovědnost VOLAJÍCÍHO (musí sečíst quantity přes všechny SKU v košíku,
// co patří do stejné group), ne této Rule -- Rule zůstává čistá funkce bez
// I/O, nesahá do košíku/objednávky sama.

import Decimal from 'decimal.js';
import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import type { QuantityTierBreakpoint } from '../../core/canonical/entities/Price.js';

export interface QuantityTierRuleInput {
    /** Cena PO customer/sale/discount-limit vrstvě, PŘED zaokrouhlením. */
    readonly sourcePrice: Decimal;
    /** Celkové množství přes CELOU group (voláno už sečtené, ne per-SKU). */
    readonly totalQuantity: number;
    readonly breakpoints: readonly QuantityTierBreakpoint[];
}

export interface QuantityTierRuleResult {
    readonly applied: boolean;
    readonly price?: Decimal;
    readonly matchedBreakpoint?: QuantityTierBreakpoint;
}

function findBreakpoint(quantity: number, breakpoints: readonly QuantityTierBreakpoint[]): QuantityTierBreakpoint | undefined {
    // "Nejlepší" breakpoint = ten s nejvyšším minQuantity, který quantity stále splňuje.
    // Explicitní volba, ne spoléhání na pořadí pole -- breakpoints mohou přijít
    // v libovolném pořadí z configu.
    let best: QuantityTierBreakpoint | undefined;
    for (const bp of breakpoints) {
        const withinRange = quantity >= bp.minQuantity && (bp.maxQuantity === undefined || quantity <= bp.maxQuantity);
        if (!withinRange) continue;
        if (best === undefined || bp.minQuantity > best.minQuantity) {
            best = bp;
        }
    }
    return best;
}

export class QuantityTierRule implements Rule<QuantityTierRuleInput, QuantityTierRuleResult> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: QuantityTierRuleInput): QuantityTierRuleResult {
        const breakpoint = findBreakpoint(input.totalQuantity, input.breakpoints);
        if (!breakpoint || breakpoint.discountPercent <= 0) {
            return { applied: false };
        }

        const one = new Decimal('1');
        const discountedPrice = input.sourcePrice.mul(one.minus(breakpoint.discountPercent));

        return { applied: true, price: discountedPrice, matchedBreakpoint: breakpoint };
    }
}
