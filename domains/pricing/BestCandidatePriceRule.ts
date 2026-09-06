// BestCandidatePriceRule -- Fáze 6.5 pokračování. Finální krok kandidátního
// cenového modelu (Jose 2026-09-05, doslovně):
//
//   BASE PRICE -> SALE/LOYALTY/CUSTOMER -> DISCOUNT LIMITS -> CURRENT PRICE
//   -> PROMOGROUP CANDIDATE -> QUANTITY TIER CANDIDATE -> BEST PRICE -> ROUNDING
//
// "PromoGroup, QuantityTier a další mechanismy jsou kandidáti, ne
// automatické sčítání slev. Výsledkem je vždy nejnižší platná cena,
// nikoliv kombinace všech procent."
//
// Tato Rule NEPOČÍTÁ PromoGroup ani QuantityTier kandidáty samotné (to
// dělají PromoGroupDiscountRule a QuantityTierRule) -- přijímá jejich
// výsledky jako hotové kandidáty a vybere z nich (spolu s currentPrice)
// absolutní minimum. Žádné sčítání, žádné řetězení, žádné přepočítávání.
//
// KRITICKÉ (Jose): "případ, kdy promo nebo quantity kandidát vyjde vyšší
// než současná cena -> nesmí zdražit." currentPrice je VŽDY jeden z
// kandidátů v porovnání (i když žádná promo/quantity sleva neplatí) --
// minimum tedy nikdy nemůže být vyšší než currentPrice samotná.

import Decimal from 'decimal.js';
import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';

export type CandidateSource = 'CURRENT_PRICE' | 'PROMO_GROUP' | 'QUANTITY_TIER';

export interface PriceCandidate {
    readonly source: CandidateSource;
    readonly price: Decimal;
}

export interface BestCandidatePriceRuleInput {
    /** Cena po Pricing chainu (sale/loyalty/discount limits) -- VŽDY součástí porovnání jako CURRENT_PRICE kandidát. */
    readonly currentPrice: Decimal;
    /** PromoGroup kandidátní cena, pokud platná PromoGroup se slevou existuje pro tento produkt. */
    readonly promoGroupCandidate?: Decimal;
    /** QuantityTier kandidátní cena, pokud množstevní pásmo platí pro tento produkt/group. */
    readonly quantityTierCandidate?: Decimal;
}

export interface BestCandidatePriceRuleResult {
    readonly finalPrice: Decimal;
    readonly winningSource: CandidateSource;
    /** Všichni kandidáti, co vstoupili do porovnání -- pro observabilitu/audit. */
    readonly candidates: readonly PriceCandidate[];
}

/**
 * Vybere absolutní minimum mezi currentPrice a libovolnými dodanými
 * kandidáty (PromoGroup/QuantityTier). currentPrice je VŽDY přítomna jako
 * kandidát -- žádný jiný kandidát ji nemůže "přebít" tím, že by byl vyšší
 * (Jose: "nesmí zdražit"). Přesná shoda mezi kandidáty -> vyhrává ten,
 * co je v poli DŘÍVE (currentPrice má vždy prioritu při shodě, pak
 * promoGroupCandidate, pak quantityTierCandidate) -- deterministické,
 * žádná náhodnost.
 */
export class BestCandidatePriceRule implements Rule<BestCandidatePriceRuleInput, BestCandidatePriceRuleResult> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: BestCandidatePriceRuleInput): BestCandidatePriceRuleResult {
        const candidates: PriceCandidate[] = [{ source: 'CURRENT_PRICE', price: input.currentPrice }];

        if (input.promoGroupCandidate !== undefined) {
            candidates.push({ source: 'PROMO_GROUP', price: input.promoGroupCandidate });
        }
        if (input.quantityTierCandidate !== undefined) {
            candidates.push({ source: 'QUANTITY_TIER', price: input.quantityTierCandidate });
        }

        let winner = candidates[0]!;
        for (const candidate of candidates.slice(1)) {
            if (candidate.price.lessThan(winner.price)) {
                winner = candidate;
            }
        }

        return { finalPrice: winner.price, winningSource: winner.source, candidates };
    }
}
