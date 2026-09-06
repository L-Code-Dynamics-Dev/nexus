// CreativeResolutionRule -- Fáze 6.5 Domain Rules, Creative doména
// (Josovo zadání 2026-09-06, doslovně): "Creative není další cenová
// vrstva. Je to obsahová vrstva kampaně, která říká co se má zákazníkovi
// zobrazit a v jakém kontextu."
//
// PRAVIDLO SCOPE (Jose): "Creative se může zobrazovat pouze v kontextu
// své Campaign a jejího PromoGroup/produktového scope." Příklad: Creative
// patřící ke kampani "Víkendová akce" s PromoGroup "Vybrané mikiny"
// (mikina A/B/C) se zobrazí na mikině A (patří do PromoGroup), NE na
// produktu X mimo PromoGroup.
//
// RESOLVE ŘETĚZEC (Jose, přesná citace -- "Co tedy Fáze 6.5 přidává: Ne
// nový lifecycle, ale resolve logiku"):
//   Campaign je ACTIVE? -> Creative je PUBLISHED? -> odpovídá placement?
//   -> odpovídá produkt/kategorie/PromoGroup? -> priority -> VYKRESLIT
//
// Toto NENÍ nový lifecycle (ten je hotový z Fáze 6.1/6.2, beze změny) --
// je to READ-ONLY dotaz "smí se tenhle Creative teď vykreslit pro tenhle
// produkt/placement", skládající existující stavební kameny
// (shouldEvaluateCampaign, CREATIVE_LIFECYCLE_DEFINITION status check,
// PromoGroup membership) do jednoho resolve výsledku.
//
// KRITICKÉ (Jose): "Creative nikdy nemění cenu. Cenovou logiku už máme
// oddělenou v Pricing/PromoGroup/Quantity/X+X vrstvě." Tato Rule NEPOČÍTÁ
// ŽÁDNOU cenu, nevolá PromoGroupDiscountRule/QuantityTierRule/
// BestCandidatePriceRule -- čistě obsahové rozhodnutí "vykreslit ano/ne".
//
// UNRESOLVED (nelze jednoznačně odvodit ze zadání, NEIMPLEMENTOVÁNO):
//   - Tie-break při shodné `priority` dvou+ Creative ve stejném placementu
//     -- Jose zadal jen "jejich pořadí řeší priority", bez tie-break
//     algoritmu pro shodnou hodnotu (na rozdíl od PromoGroup, kde Fáze 6.3
//     explicitně řešila createdAt/id). Řazení zde je STABILNÍ (zachovává
//     pořadí vstupního pole při shodné priority, JS Array.sort() garance),
//     ale to NENÍ potvrzené business pravidlo -- jen defenzivní
//     determinismus (žádné náhodné pořadí), ne odsouhlasený tie-break.
//   - Přesný vztah "odpovídá kategorie" -- Jose zmínil "produkt/kategorie/
//     PromoGroup" v resolve řetězci, ale explicitní scope pravidlo
//     (příklad s mikinami) mluví jen o PromoGroup membershipu. Kategorie
//     jako samostatný scope mechanismus NENÍ v Product/PromoGroup typu
//     nikde definovaná (Product.categoryId existuje, ale PromoGroup nemá
//     žádnou vazbu na kategorii, jen na productIds) -- proto tato Rule
//     řeší JEN produkt-přes-PromoGroup scope, ne kategorii samostatně.

import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import type { Campaign, PromoGroup, Creative, CampaignLifecycleState, CreativeLifecycleState } from '../../core/canonical/entities/Campaign.js';
import { shouldEvaluateCampaign } from './CampaignLifecycleRule.js';

export interface CreativeResolutionRuleInput {
    readonly campaign: Pick<Campaign, 'id' | 'status' | 'promoGroupIds'>;
    readonly creative: Pick<Creative, 'id' | 'status' | 'placementTypes' | 'priority'>;
    /** Všechny PromoGroup dostupné v systému -- Rule si sama zúží na ty, co Campaign obsahuje. */
    readonly allPromoGroups: readonly PromoGroup[];
    readonly placement: string;
    readonly productId: string;
}

export type CreativeResolutionBlockedReason =
    | 'CAMPAIGN_NOT_ACTIVE'
    | 'CREATIVE_NOT_PUBLISHED'
    | 'PLACEMENT_MISMATCH'
    | 'PRODUCT_OUT_OF_SCOPE';

export interface CreativeResolutionRuleResult {
    readonly shouldRender: boolean;
    readonly reason?: CreativeResolutionBlockedReason;
}

export class CreativeResolutionRule implements Rule<CreativeResolutionRuleInput, CreativeResolutionRuleResult> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: CreativeResolutionRuleInput): CreativeResolutionRuleResult {
        const { campaign, creative, allPromoGroups, placement, productId } = input;

        // Krok 1: Campaign je ACTIVE? (Jose: "pokud je Campaign PAUSED nebo
        // ENDED, Creative se nevykresluje" -- shouldEvaluateCampaign už
        // řeší přesně tenhle check, Fáze 6.3, beze změny.)
        if (!shouldEvaluateCampaign(campaign.status as CampaignLifecycleState)) {
            return { shouldRender: false, reason: 'CAMPAIGN_NOT_ACTIVE' };
        }

        // Krok 2: Creative je PUBLISHED? (Jose: "ARCHIVED Creative se
        // nevykresluje" -- DRAFT taky ne, jen PUBLISHED je vykreslitelný stav.)
        if ((creative.status as CreativeLifecycleState) !== 'PUBLISHED') {
            return { shouldRender: false, reason: 'CREATIVE_NOT_PUBLISHED' };
        }

        // Krok 3: odpovídá placement? (Creative.placementTypes je pole --
        // Jose: "jeden Creative může mít více placementů".)
        if (!creative.placementTypes.includes(placement)) {
            return { shouldRender: false, reason: 'PLACEMENT_MISMATCH' };
        }

        // Krok 4: odpovídá produkt/PromoGroup scope? (Jose: "Creative se
        // může zobrazovat pouze v kontextu své Campaign a jejího PromoGroup/
        // produktového scope" -- produkt musí patřit do NĚKTERÉ PromoGroup,
        // kterou Campaign obsahuje.)
        const campaignGroups = allPromoGroups.filter((g) => campaign.promoGroupIds.includes(g.id));
        const productInScope = campaignGroups.some((g) => g.productIds.includes(productId));
        if (!productInScope) {
            return { shouldRender: false, reason: 'PRODUCT_OUT_OF_SCOPE' };
        }

        // Krok 5 (priority) řeší volající při řazení VÍCE Creative kandidátů
        // -- viz resolveCreativesForPlacement() v CampaignFlows.ts, tato
        // Rule sama o sobě odpovídá jen na "smí SE TENTO Creative vykreslit".
        return { shouldRender: true };
    }
}
