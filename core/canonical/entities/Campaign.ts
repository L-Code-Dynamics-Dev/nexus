// Campaign / PromoGroup / CampaignPlacement / Creative -- Fáze 6.1
// lifecycle + invariants (Josovo zadání 2026-09-05: "Další kroky Fáze 6" +
// "Fáze 6.1 = lifecycle + základní invariants"). Čistě NEW BUILD.
//
// ROZHODNUTO (Jose):
//   - PromoGroup -> Product: nezávislá entita, explicitní vazba na
//     produkty, produkt může být ve VÍCE PromoGroup (M:N). Vlastní promo
//     pravidla per PromoGroup. Konflikt více promo skupin na stejném
//     produktu se NEŘEŠÍ implicitně -- `priority` je POVINNÉ pole
//     (vyšší číslo = vyšší priorita, konkrétní tie-break algoritmus mimo
//     scope kostry, jen že priorita MUSÍ existovat).
//   - Campaign může obsahovat VÍCE PromoGroup (1:N, ne 1:1) -- proto
//     `promoGroupIds` (pole), NE `promoGroupId` (singulár).
//   - Campaign lifecycle: DRAFT -> ACTIVE -> PAUSED -> ENDED.
//     DRAFT lze upravovat. ACTIVE je publikovaná/vyhodnocovaná. PAUSED je
//     dočasně vypnutá BEZ ztráty konfigurace (PAUSED -> ACTIVE povolen).
//     ENDED je terminální a NIKDY se nemaže (historie).
//   - Creative -> Campaign, jednoduchý kontrakt (id/campaignId/name/type/
//     content/status), žádný complex content model zatím.
//   - CampaignPlacement zůstává rozšiřitelný string (NE fixní enum) --
//     Jose: "Placement bych zatím nefixoval na konkrétní kanály."
//
// SCOPE (Jose Fáze 6.1): lifecycle + invarianty. NEIMPLEMENTOVAT: konkrétní
// promo výpočty, marketingové distribuční kanály, žádnou další business
// logiku nad tento kontrakt.

import type { CanonicalEntity, EntityId, ISODateTime } from './base.js';
import type { StateAxisDefinition } from '../../state-machine/StateMachine.js';

/**
 * PromoGroup -- seskupení produktů pro účely kampaně. `priority` je
 * POVINNÉ (ne optional) -- Jose: "konflikt více promo skupin se neřeší
 * implicitně, musí existovat explicitní priorita." Produkt může patřit
 * do více PromoGroup současně (M:N), proto se priorita řeší per-group,
 * ne jako vlastnost Product.
 */
export interface PromoGroup extends CanonicalEntity {
    name: string;
    /** FK na Product.id -- explicitní členství, NENÍ odvozeno z PriceList/ceníku. */
    productIds: EntityId[];
    /** Vyšší číslo = vyšší priorita při konfliktu více PromoGroup na stejném produktu. Tie-break algoritmus mimo scope kostry. */
    priority: number;
}

/**
 * Campaign lifecycle -- ROZHODNUTO (Jose): DRAFT -> ACTIVE -> PAUSED ->
 * ENDED. DRAFT je jediný stav, kde lze kampaň upravovat (Rule/validace
 * mimo scope kostry, jen stavový kontrakt zde). PAUSED <-> ACTIVE
 * obousměrně povolen (dočasné vypnutí beze ztráty konfigurace). ENDED je
 * terminální -- žádný přechod ven, záznam se NIKDY nemaže (historie).
 */
export type CampaignLifecycleState = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ENDED';

export const CAMPAIGN_LIFECYCLE_DEFINITION: StateAxisDefinition<CampaignLifecycleState> = {
    axisName: 'campaignLifecycle',
    initialState: 'DRAFT',
    terminalStates: ['ENDED'],
    transitions: {
        DRAFT: ['ACTIVE', 'ENDED'],
        ACTIVE: ['PAUSED', 'ENDED'],
        PAUSED: ['ACTIVE', 'ENDED'],
        ENDED: [],
    },
};

/**
 * Campaign -- ROZHODNUTO: může obsahovat VÍCE PromoGroup (`promoGroupIds`
 * pole, ne singulár `promoGroupId`).
 */
export interface Campaign extends CanonicalEntity {
    name: string;
    status: CampaignLifecycleState;
    startsAt?: ISODateTime;
    endsAt?: ISODateTime;
    /** FK na PromoGroup.id[] -- Campaign obsahuje VÍCE PromoGroup (1:N). */
    promoGroupIds: EntityId[];
}

/**
 * CampaignPlacement -- Jose: "Placement bych zatím nefixoval na konkrétní
 * kanály... rozšiřitelný enum/kontrakt." Ponecháno jako string (ne union),
 * aby přidání nového kanálu (produktová stránka/homepage/banner) nebylo
 * breaking change typu.
 */
export interface CampaignPlacement extends CanonicalEntity {
    readonly campaignId: EntityId;
    /** Rozšiřitelný string, NE fixní enum -- viz komentář výše. */
    placementType: string;
}

/**
 * Creative -- ROZHODNUTO (Jose): jednoduchý kontrakt, žádný strukturovaný
 * content model zatím. `content` je volný text/URL (Jose neuvedl
 * structured title/body/CTA jako požadavek).
 */
export type CreativeLifecycleState = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';

export const CREATIVE_LIFECYCLE_DEFINITION: StateAxisDefinition<CreativeLifecycleState> = {
    axisName: 'creativeLifecycle',
    initialState: 'DRAFT',
    terminalStates: ['ARCHIVED'],
    transitions: {
        DRAFT: ['PUBLISHED', 'ARCHIVED'],
        PUBLISHED: ['ARCHIVED'],
        ARCHIVED: [],
    },
};

export interface Creative extends CanonicalEntity {
    readonly campaignId: EntityId;
    name: string;
    /** TBD: konkrétní typ hodnot (image/text/video?) -- nerozhodnuto, string zatím. */
    type: string;
    content: string;
    status: CreativeLifecycleState;
}

/**
 * ROZHODNUTO (Jose 2026-09-05, Fáze 6.1): Campaign lifecycle
 * (DRAFT/ACTIVE/PAUSED/ENDED), Campaign 1:N PromoGroup, PromoGroup
 * povinná priority, Creative jednoduchý kontrakt s vlastním lifecycle,
 * Placement rozšiřitelný string. Zbývající OPEN QUESTIONS (business rule
 * detail, EXPLICITNĚ MIMO SCOPE Fáze 6.1):
 *
 * 1. PromoGroup priority tie-break algoritmus (co přesně se stane při
 *    shodné prioritě, jak se priorita aplikuje na výslednou cenu/promo) --
 *    business logika, ne struktura kostry.
 * 2. CampaignPlacement konkrétní hodnoty (závisí na Connector Layer
 *    schopnostech) -- nerozhodnuto.
 * 3. Creative `type`/`content` konkrétní hodnoty a validace -- nerozhodnuto.
 * 4. Kdo campaign vytváří/schvaluje (workflow) a napojení na Decision/
 *    Execution vrstvu -- EXPLICITNĚ MIMO SCOPE (žádné schvalovací workflow
 *    bez dalšího zadání, analogicky k B2B approval workflow zákazu).
 */
