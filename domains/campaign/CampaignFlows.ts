// CampaignFlows -- Fáze 6.4 business flows (Josovo zadání 2026-09-05:
// "Fáze 6.4 – skutečné business flows... implementovat jen flows, které
// mají přímou oporu v dosavadních rozhodnutích"). ČISTÁ KOMPOZICE
// existujících Fáze 6.2/6.3 Rules -- ŽÁDNÁ nová business logika, žádné
// nové rozhodnutí, žádný nový typ pole. Stejný princip jako
// domains/pricing/createNexusPricingCalculator.ts: skládá už hotové,
// otestované kusy do jednoho use-case volání, samo nic nevynalézá.
//
// Pokryté flows (ze zadání):
//   1. Campaign -> PromoGroup -> Product (resolveCampaignPromoGroupForProduct)
//   2. Campaign evaluation ACTIVE/PAUSED (evaluateCampaignForProduct)
//   3. PromoGroup conflict resolution -- VYNECHÁNO jako samostatný flow,
//      viz komentář u resolveCampaignPromoGroupForProduct níže: je to už
//      přesně resolveConflict() samotná (obecná, bez Campaign kontextu),
//      psát tenký alias by byla čistá duplicita, ne kompozice.
//   4. Creative publication (publishCreative)
//
// Explicitně NEDĚLÁ (Jose "zatím vůbec neřešit"): žádný výpočet ceny/slevy,
// žádné CampaignPlacement/distribuční rozhodování -- flows zde jen skládají
// existující Rules a vrací jejich výsledky, nikdy nepočítají nic nového.

import Decimal from 'decimal.js';
import type { Campaign, PromoGroup, Creative, CreativeLifecycleState } from '../../core/canonical/entities/Campaign.js';
import { shouldEvaluateCampaign } from './CampaignLifecycleRule.js';
import { resolveConflict, type PromoGroupConflictResult } from './PromoGroupPriorityRule.js';
import { CreativeLifecycleRule, type CreativeLifecycleRuleResult } from './CreativeLifecycleRule.js';
import { PromoGroupDiscountRule, type PromoGroupDiscountRuleResult } from './PromoGroupDiscountRule.js';
import { CreativeResolutionRule } from './CreativeResolutionRule.js';
import type { RuleContext } from '../../core/canonical/rules/Rule.js';

/**
 * Flow 1 -- Campaign -> PromoGroup -> Product. Pro danou Campaign (přes
 * `promoGroupIds`) a explicitně dodaný seznam VŠECH dostupných PromoGroup
 * zjistí, které z nich Campaign vůbec obsahuje, a mezi TĚMI (ne mezi
 * úplně všemi PromoGroup v systému) rozhodne vítěze pro daný produkt přes
 * `resolveConflict()` -- beze změny té funkce, jen zúžený vstupní seznam.
 *
 * Toto JE Flow 3 (PromoGroup conflict resolution) ze zadání aplikovaný v
 * Campaign kontextu -- `resolveConflict()` sama o sobě už je obecný,
 * Campaign-nezávislý "conflict resolution" flow (přijímá libovolný seznam
 * PromoGroup + productId, nic o Campaign neví). Samostatný wrapper pro
 * "obecný" use-case by byl identická funkce s jiným jménem -- proto zde
 * není žádný `resolvePromoGroupConflict()` alias, volající pro obecný
 * (ne-Campaign) případ použije `resolveConflict()` přímo.
 */
export interface CampaignPromoGroupResolution extends PromoGroupConflictResult {
    readonly campaignId: string;
    readonly productId: string;
}

export function resolveCampaignPromoGroupForProduct(
    campaign: Pick<Campaign, 'id' | 'promoGroupIds'>,
    allPromoGroups: readonly PromoGroup[],
    productId: string
): CampaignPromoGroupResolution {
    const campaignGroups = allPromoGroups.filter((g) => campaign.promoGroupIds.includes(g.id));
    const conflict = resolveConflict(campaignGroups, productId);

    return {
        ...conflict,
        campaignId: campaign.id,
        productId,
    };
}

/**
 * Flow 2 -- Campaign evaluation ACTIVE/PAUSED. Nejdřív se ptá
 * `shouldEvaluateCampaign(campaign.status)` (Fáze 6.3) -- pokud kampaň
 * není ACTIVE, vrací se rovnou "neaktivní" BEZ volání resolveConflict
 * vůbec (žádná zbytečná práce, přesně smysl toho rozhodnutí). Jen pokud
 * JE aktivní, deleguje na Flow 1.
 */
export type CampaignEvaluationResult =
    | { readonly evaluated: false; readonly reason: string }
    | ({ readonly evaluated: true } & CampaignPromoGroupResolution);

export function evaluateCampaignForProduct(
    campaign: Pick<Campaign, 'id' | 'status' | 'promoGroupIds'>,
    allPromoGroups: readonly PromoGroup[],
    productId: string
): CampaignEvaluationResult {
    if (!shouldEvaluateCampaign(campaign.status)) {
        return {
            evaluated: false,
            reason: `Campaign "${campaign.id}" má status "${campaign.status}" -- vyhodnocují se jen ACTIVE kampaně.`,
        };
    }

    const resolution = resolveCampaignPromoGroupForProduct(campaign, allPromoGroups, productId);
    return { evaluated: true, ...resolution };
}

/**
 * Flow 5 (Fáze 6.5) -- Campaign/PromoGroup skutečné promo pricing. Skládá
 * Flow 1 (resolveCampaignPromoGroupForProduct, Fáze 6.3 conflict
 * resolution) s `PromoGroupDiscountRule` (Fáze 6.5 kandidátní cena) --
 * PŘESNĚ v pořadí, které Jose zadal: "nejdřív se vyřeší konflikt podle
 * priority -> createdAt -> id... Teprve vítězná PromoGroup vytvoří
 * kandidátní cenu."
 *
 * `currentPrice` je vstup -- cena PO celém Pricing chainu (sale/loyalty/
 * discount limits), tento flow ji NEPOČÍTÁ, jen ji přebírá jako hotovou
 * hodnotu z volajícího (Pricing doména zůstává jediným vlastníkem toho
 * výpočtu, viz PromoGroupDiscountRule.ts hlavička).
 */
export interface CampaignPromoPricingResult {
    readonly campaignId: string;
    readonly productId: string;
    readonly conflictResolution: PromoGroupConflictResult;
    readonly pricing: PromoGroupDiscountRuleResult;
}

export function evaluateCampaignPromoPricingForProduct(
    campaign: Pick<Campaign, 'id' | 'status' | 'promoGroupIds'>,
    allPromoGroups: readonly PromoGroup[],
    productId: string,
    currentPrice: Decimal,
    context: RuleContext
): CampaignPromoPricingResult {
    const evaluation = evaluateCampaignForProduct(campaign, allPromoGroups, productId);

    const conflictResolution: PromoGroupConflictResult = evaluation.evaluated
        ? evaluation
        : { resolved: false, reason: evaluation.reason, tieBreakApplied: false };

    const discountRule = new PromoGroupDiscountRule(context);
    const pricing = discountRule.evaluate({
        currentPrice,
        winningPromoGroup: conflictResolution.resolved ? conflictResolution.winner : undefined,
    });

    return {
        campaignId: campaign.id,
        productId,
        conflictResolution,
        pricing,
    };
}

/**
 * Flow 4 -- Creative publication. Tenký flow nad `CreativeLifecycleRule`
 * pro konkrétní, nejčastější use-case "publikuj tenhle Creative" (cíl
 * vždy PUBLISHED) -- Rule samotná zůstává obecná (libovolný přechod),
 * tenhle flow jen předvyplní `targetStatus: 'PUBLISHED'` a `context`,
 * ať volající nemusí sám sestavovat Rule instanci pro nejběžnější případ.
 */
export interface PublishCreativeResult extends CreativeLifecycleRuleResult {
    readonly creativeId: string;
}

export function publishCreative(
    creative: Pick<Creative, 'id' | 'status' | 'content'>,
    context: RuleContext
): PublishCreativeResult {
    const rule = new CreativeLifecycleRule(context);
    const result = rule.evaluate({
        currentStatus: creative.status,
        targetStatus: 'PUBLISHED' as CreativeLifecycleState,
        content: creative.content,
    });

    return { ...result, creativeId: creative.id };
}

/**
 * Flow 6 (Fáze 6.5) -- Creative resolve pro daný placement/produkt. Jose
 * diagram: "Campaign ACTIVE? -> Creative PUBLISHED? -> odpovídá placement?
 * -> odpovídá produkt/PromoGroup? -> priority -> VYKRESLIT". Skládá
 * `CreativeResolutionRule` (per-Creative ano/ne rozhodnutí) přes VŠECHNY
 * kandidátní Creative dané Campaign a vrátí jen ty, co smí vykreslit,
 * SEŘAZENÉ podle `priority` (Jose: "v jednom placementu může existovat
 * více Creative, jejich pořadí řeší priority").
 *
 * Řazení je STABILNÍ (Array.sort() garance), ne odsouhlasený tie-break
 * algoritmus pro shodnou priority -- viz UNRESOLVED komentář v
 * CreativeResolutionRule.ts.
 */
export interface ResolvedCreative {
    readonly creative: Creative;
}

export function resolveCreativesForPlacement(
    campaign: Pick<Campaign, 'id' | 'status' | 'promoGroupIds'>,
    candidateCreatives: readonly Creative[],
    allPromoGroups: readonly PromoGroup[],
    placement: string,
    productId: string,
    context: RuleContext
): readonly ResolvedCreative[] {
    const rule = new CreativeResolutionRule(context);

    const eligible = candidateCreatives.filter((creative) => {
        const result = rule.evaluate({ campaign, creative, allPromoGroups, placement, productId });
        return result.shouldRender;
    });

    // Vyšší priority první -- stabilní řazení (Array.prototype.sort je
    // stabilní od ES2019), shodná priority zachová relativní pořadí
    // vstupního pole (deterministické, ale NENÍ odsouhlasený tie-break).
    return [...eligible].sort((a, b) => b.priority - a.priority).map((creative) => ({ creative }));
}
