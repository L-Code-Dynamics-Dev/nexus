// XPlusXRule -- migrace resolveXPlusXForVariant (connectors/pricing-engine/
// legacy/promo/free-units.ts, port z ~/hecmania-quantity-pricing) pod
// Nexus Rule contract. Fáze 6.5 pokračování -- testovací matice pro
// PromoGroup/QuantityTier vyžaduje X+X scénáře (Jose 2026-09-05).
//
// SCOPE (Jose, testovací matice): "X+X je samostatná promo logika a platí
// pouze pro produkty v definovaném promo scope. Produkty mimo něj se jí
// vůbec nesmí dotknout." + "X+X produkty zároveň stále podléhají
// množstevnímu pravidlu tam, kde je pro ně množstevní sleva definovaná."
//
// Toto je NEZÁVISLÁ vrstva od PromoGroupDiscountRule a QuantityTierRule --
// řeší JEN paid/free split (kolik kusů je placených, kolik zdarma),
// NEPOČÍTÁ žádnou cenu. Cena za (placený) kus se řeší jinde (Pricing
// chain / PromoGroup / QuantityTier) -- viz `effectivePricePerUnit()`
// v legacy souboru, která je čistě informativní a nikdy nenahrazuje
// ceníkovou cenu.

import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import {
    resolveXPlusXForVariant,
    type XPlusXRatio,
    type FreeUnitsResult,
} from '../../connectors/pricing-engine/legacy/promo/free-units.js';

export interface XPlusXRuleInput {
    /** Celkový počet kusů v košíku pro TUTO variantu (ne jen placené). */
    readonly qty: number;
    /** Poměr placeno/zdarma pro tuto variantu -- undefined = produkt NENÍ v X+X scope. */
    readonly ratio?: XPlusXRatio;
}

export interface XPlusXRuleResult extends FreeUnitsResult {
    /** false, pokud produkt vůbec není v X+X scope (žádný ratio) -- odlišeno od "v scope, ale 0 kusů". */
    readonly inScope: boolean;
}

export class XPlusXRule implements Rule<XPlusXRuleInput, XPlusXRuleResult> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: XPlusXRuleInput): XPlusXRuleResult {
        if (input.ratio === undefined) {
            // Produkt mimo X+X scope -- Jose: "produkty mimo něj se jí vůbec
            // nesmí dotknout." Vrací "beze změny" tvar, ne chybu.
            return {
                inScope: false,
                paidQty: input.qty,
                freeQty: 0,
                totalReceivedQty: input.qty,
                appliedRule: null,
                nextRule: null,
                unitsToNextRule: null,
            };
        }

        const result = resolveXPlusXForVariant(input.qty, input.ratio);
        return { ...result, inScope: true };
    }
}

export type { XPlusXRatio, FreeUnitsResult } from '../../connectors/pricing-engine/legacy/promo/free-units.js';
