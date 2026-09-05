// PromoGroupDiscountRule -- Fáze 6.5 Domain Rules, první konkrétní business
// logika Campaign/PromoGroup domény (Josovo zadání 2026-09-05: "Fáze 6.5 –
// Domain Rules... Campaign + PromoGroup, protože tam už máme nejpevnější
// základ"). Implementuje PŘESNÉ architektonické rozhodnutí Jose:
//
// POŘADÍ V CENOVÉM MODELU (kandidátní, NE řetězení procent):
//   basePrice -> sale/loyalty/customer pricing -> discount limits ->
//   currentPrice -> [PromoGroup kandidát] -> [QuantityTier kandidát] ->
//   finální výběr nejlepší platné ceny -> rounding
//
// KLÍČOVÉ ARCHITEKTONICKÉ PRAVIDLO (Jose, doslovně): "PromoGroup se
// aplikuje na currentPrice, tedy na cenu vzniklou po Pricing chainu. Ne na
// basePrice." A: "PromoGroup se nemá automaticky sčítat s ostatními
// slevami. Má vzniknout kandidátní cena a engine má podle definovaných
// pravidel vyhodnotit, která platná cena je pro zákazníka nejlepší." A:
// "PromoGroup je samostatná promo vrstva a nesmí přepisovat ani obcházet
// pravidla Pricing engine."
//
// Konkrétní mechanika (Jose, doslovně): "Vyber 1 -- currentPrice = cena,
// která vznikla předchozími pravidly Pricing chainu. PromoGroup z ní
// vytvoří Promo cenu. Engine porovná: cenu bez PromoGroup, cenu po
// PromoGroup. Vyhraje nižší platná cena. PromoGroup tedy nesmí
// automaticky přepsat levnější cenu, která už vznikla předchozím
// pravidlem. Pokud je více platných PromoGroup, nejdřív se vyřeší
// konflikt podle priority -> createdAt -> id... Teprve vítězná PromoGroup
// vytvoří kandidátní cenu. Finální výsledek je minimum z currentPrice a
// promoPrice."
//
// Tato Rule NEŘEŠÍ konflikt více PromoGroup (to už dělá
// PromoGroupPriorityRule.resolveConflict() z Fáze 6.3) -- přijímá JEDNU
// vítěznou PromoGroup (nebo žádnou) jako vstup a jen z ní spočítá
// kandidátní cenu + provede finální min-výběr. Skládání obou kroků
// (resolveConflict -> tato Rule) patří do Fáze 6.4-style flow funkce
// (`domains/campaign/CampaignFlows.ts` už existuje, ale toto rozšíření
// je nová business logika, ne pouhá kompozice -- proto samostatný soubor,
// ne úprava CampaignFlows.ts).
//
// NEDOTÝKÁ SE (Jose, explicitně zachovat beze změny): QuantityTierRule
// (domains/pricing/QuantityTierRule.ts) zůstává NENAPOJENÁ (design
// proposal §6 stále nerozhodnut) a jeho vlastní pravidlo "quantity sleva
// se počítá ze sourcePrice PO customer/sale/limit vrstvě, PŘED
// rounding" je NEDOTČENÉ -- tato Rule o QuantityTier vůbec neví, jen
// vytváří PromoGroup kandidáta na stejné úrovni cenového modelu
// (currentPrice), jak Jose nakreslil v diagramu výše. Skládání
// PromoGroup + QuantityTier kandidátů dohromady (finální výběr mezi
// VÍCE kandidáty) je MIMO SCOPE této Rule -- ta řeší jen "currentPrice
// vs. PromoGroup kandidát", ne obecný N-kandidátní výběr.
//
// UNRESOLVED (nelze jednoznačně odvodit ze zadání, NEIMPLEMENTOVÁNO):
//   - Obecný výběr mezi VÍCE než dvěma kandidáty (PromoGroup + QuantityTier
//     + budoucí typy) najednou -- Jose zadal jen párové porovnání
//     "currentPrice vs. PromoGroup cena", obecný N-way výběr je nová
//     abstrakce nad rámec tohoto zadání.
//   - Validace horní hranice PERCENTAGE (0 <= value < 1) -- odvozeno z
//     konvence RoundingRule/DiscountLimitRule (`discount_percent < 1`
//     invariant v D1 schématu hecmania-quantity-pricing, viz PROGRESS_LOG),
//     ale Jose to explicitně nezopakoval v tomto zadání -- validace je
//     zde implementována jako DEFENZIVNÍ krok (Rule musí zůstat
//     deterministická i na chybný config), ne jako potvrzené business
//     pravidlo. FIXED_AMOUNT horní hranice (nesmí přesáhnout currentPrice)
//     řešena stejně defenzivně -- clamp na currentPrice, nikdy záporná cena.

import Decimal from 'decimal.js';
import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import type { PromoGroup, PromoGroupDiscount } from '../../core/canonical/entities/Campaign.js';

export interface PromoGroupDiscountRuleInput {
    /** Cena PO celém Pricing chainu (sale/loyalty/discount limits) -- NIKDY basePrice. */
    readonly currentPrice: Decimal;
    /**
     * Vítězná PromoGroup pro tento produkt (výstup PromoGroupPriorityRule.
     * resolveConflict(), volaný PŘED touto Rule) -- `undefined`, pokud
     * žádná PromoGroup neplatí (produkt není v žádné aktivní promo).
     */
    readonly winningPromoGroup?: PromoGroup;
}

export type PromoGroupDiscountSource = 'PROMO_GROUP' | 'CURRENT_PRICE';

export interface PromoGroupDiscountRuleResult {
    /** Minimum z currentPrice a promo kandidátní ceny -- viz Jose "Finální výsledek je minimum z currentPrice a promoPrice." */
    readonly finalPrice: Decimal;
    /** Odkud finální cena pochází -- PROMO_GROUP jen pokud byla PromoGroup cena skutečně nižší (nikdy tichá náhrada dražší cenou). */
    readonly source: PromoGroupDiscountSource;
    /** Promo kandidátní cena, pokud PromoGroup měla platnou slevu (i když nakonec neVyhrála) -- pro observabilitu/audit. */
    readonly promoPrice?: Decimal;
}

function computePromoPrice(currentPrice: Decimal, discount: PromoGroupDiscount): Decimal {
    if (discount.type === 'PERCENTAGE') {
        // Defenzivní clamp -- viz UNRESOLVED komentář nahoře, konvence z
        // existujícího DiscountLimitRule/D1 schématu (0 <= percent < 1),
        // ne explicitně potvrzené Jose zadání pro tuto Rule konkrétně.
        const safePercent = Math.min(Math.max(discount.value, 0), 0.999999);
        const one = new Decimal('1');
        return currentPrice.mul(one.minus(safePercent));
    }

    // FIXED_AMOUNT: absolutní částka odečtená z currentPrice, nikdy pod 0
    // (záporná cena by nebyla platná kandidátní cena k porovnání).
    const zero = new Decimal('0');
    const reduced = currentPrice.minus(discount.value);
    return reduced.lessThan(zero) ? zero : reduced;
}

/**
 * Vytvoří PromoGroup kandidátní cenu (pokud vítězná skupina má platnou
 * slevu) a vybere MINIMUM z ní a currentPrice -- nikdy tiché přepsání,
 * nikdy sčítání s jinými slevami (ty už jsou zahrnuté v currentPrice,
 * PromoGroup o nich neví a nesmí je znovu aplikovat).
 */
export class PromoGroupDiscountRule implements Rule<PromoGroupDiscountRuleInput, PromoGroupDiscountRuleResult> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: PromoGroupDiscountRuleInput): PromoGroupDiscountRuleResult {
        const { currentPrice, winningPromoGroup } = input;

        if (winningPromoGroup === undefined || winningPromoGroup.discount === undefined) {
            // Žádná platná PromoGroup nebo vítězná skupina nemá slevu
            // nakonfigurovanou -- currentPrice zůstává beze změny, PromoGroup
            // vrstva se v tomto případě neuplatní vůbec (Jose: "PromoGroup
            // nesmí přepisovat ani obcházet pravidla Pricing engine").
            return { finalPrice: currentPrice, source: 'CURRENT_PRICE' };
        }

        const promoPrice = computePromoPrice(currentPrice, winningPromoGroup.discount);

        // "Vyhraje nižší platná cena." -- striktně lessThan, ne lessThanOrEqualTo,
        // aby při přesné shodě (promoPrice === currentPrice) zůstal zdroj
        // deterministicky CURRENT_PRICE (žádná sleva se fakticky neprojevila).
        if (promoPrice.lessThan(currentPrice)) {
            return { finalPrice: promoPrice, source: 'PROMO_GROUP', promoPrice };
        }

        return { finalPrice: currentPrice, source: 'CURRENT_PRICE', promoPrice };
    }
}
