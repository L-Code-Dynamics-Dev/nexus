// NoOpActionPriceRule -- port okfish "no-op actionPrice guard".
//
// ODKUD PORTOVÁNO (živý klon okfish-pricing-engine, HEAD 3a910e2):
//   - cloudflare-worker/src/engine/pricing.ts:119-125 (worker mini-engine)
//   - cloudflare-worker/src/shoptet-api/pricing-bridge.ts:56 (produkční
//     zápisová cesta, `salePriceNum`)
//   Obě místa dělají TOTÉŽ, jen jinými prostředky. Tady je to jedno pravidlo.
//
// CO DĚLÁ:
//   Akční cena, která NENÍ nižší než základní cena, není akce -- je to
//   pozůstatek po skončené promo akci, kterému nikdo nevymazal pole.
//   Pravidlo takovou hodnotu zahodí (`salePrice -> undefined`).
//
//   Podmínka je 1:1 z okfishe: `actionPrice >= basePrice` -> undefined.
//   Tedy PŘESNÁ ROVNOST se také zahazuje (`>=`, ne `>`). To je ten reálný
//   případ: v okfish `products.csv` má 8908 z 16633 řádků `actionPrice`
//   přesně rovné `price`.
//
//   Proč to není kosmetika: bez tohoto guardu DiscountLimitRule uvidí
//   definovanou `salePrice`, spustí VAGNER větev ("salePrice je autoritativní")
//   a vrátí plnou základní cenu jako finální -- zablokuje veškerou loyalty
//   i cap logiku. Potvrzeno živě 2026-08-05 na LOWRANCE kódu 111139
//   (actionPrice == price == 1167.20).
//
// CO EXPLICITNĚ NEDĚLÁ:
//   - Neparsuje CSV/feed. Vstup jsou už hotové Decimaly; parsing řetězců
//     ("6,25", prázdný string) patří do adaptéru, ne sem.
//   - Nesyntetizuje žádnou akční cenu (to je BrandSaleDiscountRule).
//   - Nepočítá cenu. Vrací jen "má se salePrice použít, nebo ne".
//   - Nekontroluje basePrice <= 0. Okfish worker má na to vlastní fallback
//     větev PŘED tímto guardem (pricing.ts:109-117); ta v Nexusu odpovídá
//     ValidationRule a záměrně se sem netahá.

import type Decimal from 'decimal.js';
import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';

export interface NoOpActionPriceRuleInput {
    readonly basePrice: Decimal;
    /** Akční cena z feedu/Shoptetu. `undefined` = produkt akci nemá. */
    readonly actionPrice?: Decimal;
}

export interface NoOpActionPriceRuleResult {
    /** `true` = vstupní actionPrice byla zahozena jako no-op pozůstatek. */
    readonly applied: boolean;
    /**
     * Akční cena, se kterou má zbytek chainu počítat. `undefined` buď
     * proto, že žádná nepřišla, nebo proto, že byla zahozena.
     */
    readonly effectiveSalePrice?: Decimal;
}

export class NoOpActionPriceRule
    implements Rule<NoOpActionPriceRuleInput, NoOpActionPriceRuleResult>
{
    constructor(public readonly context: RuleContext) {}

    evaluate(input: NoOpActionPriceRuleInput): NoOpActionPriceRuleResult {
        if (input.actionPrice === undefined) {
            return { applied: false, effectiveSalePrice: undefined };
        }

        // `>=`: rovnost je taky no-op. Viz hlavička.
        if (input.actionPrice.greaterThanOrEqualTo(input.basePrice)) {
            return { applied: true, effectiveSalePrice: undefined };
        }

        return { applied: false, effectiveSalePrice: input.actionPrice };
    }
}
