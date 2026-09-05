// Campaign / PromoGroup / CampaignPlacement / Creative -- PLACEHOLDER,
// čistě NEW BUILD (docs/CANONICAL_MODEL_SYNTHESIS.md §7,9: "Campaign |
// — | — | — | — | — (nic neexistuje)" -- žádný zdrojový systém má
// jakoukoliv implementaci, potvrzeno napříč všemi audity).
//
// Fáze 6 (docs/MIGRATION_PLAN.md řádek 60-61): "Čistě NEW BUILD. Žádný
// zdrojový systém neobsahuje kód k migraci." Tento soubor NENÍ business
// rozhodnutí -- je to jen typová kostra podle Canonical Model kontraktu
// (CanonicalEntity shape), aby budoucí návrh měl kam navázat. Žádná
// hodnota/pravidlo zde není domyšlené za obchodní stranu.
//
// DŮLEŽITÉ POUČENÍ (viz docs/design-proposals/QuantityTier-Hecmania.md):
// stejně jako QuantityTier, i Campaign potřebuje explicitní obchodní
// rozhodnutí PŘED jakoukoliv Rule/logic implementací -- ne až po ní.
// Otevřené otázky jsou vyjmenované níže, ne domyšlené.

import type { CanonicalEntity, EntityId, ISODateTime } from './base.js';

/**
 * PromoGroup -- seskupení produktů/pravidel pro účely kampaně. Shape
 * záměrně minimální (jen identita + název) -- vztah k Product/PriceList
 * je OTEVŘENÁ OTÁZKA (viz níže), ne rozhodnuto.
 */
export interface PromoGroup extends CanonicalEntity {
    name: string;
    /** TBD: explicitní seznam SKU, nebo dynamické pravidlo (kategorie/tag)? Nerozhodnuto. */
    memberProductSkus?: string[];
}

/**
 * Campaign lifecycle -- ZÁMĚRNĚ NEDEFINOVÁN jako konkrétní union hodnot.
 * State Taxonomy (CANONICAL-MODEL-CONTRACT.md §4) vyžaduje, aby canonical
 * status byl navržený nezávisle, ne odhadnutý -- pro entitu bez JAKÉHOKOLIV
 * legacy vzoru (na rozdíl od Order/PurchaseOrder, kde alespoň external
 * status existuje k rozlišení od) by hardcoded enum tady byl čistá
 * domněnka. Použij core/state-machine/StateAxisDefinition<T>, až budou
 * skutečné stavy known -- necháváno jako string dokud nepadne rozhodnutí.
 */
export interface Campaign extends CanonicalEntity {
    name: string;
    status: string; // TBD -- viz komentář výše, žádná domněnka o hodnotách
    startsAt?: ISODateTime;
    endsAt?: ISODateTime;
}

/**
 * CampaignPlacement -- KDE se kampaň zobrazuje/aplikuje (homepage banner?
 * konkrétní kategorie? checkout upsell?). Shape zcela otevřený -- žádný
 * zdrojový systém nemá analogický koncept k migraci.
 */
export interface CampaignPlacement extends CanonicalEntity {
    readonly campaignId: EntityId;
    /** TBD: enum placement typů nerozhodnut -- žádný precedent v portfoliu. */
    placementType: string;
}

/**
 * Creative -- vizuální/textový obsah kampaně (banner, text, obrázek).
 * Obsahový model (co přesně Creative obsahuje) je OTEVŘENÁ OTÁZKA.
 */
export interface Creative extends CanonicalEntity {
    readonly campaignId: EntityId;
    /** TBD: jen URL na asset, nebo strukturovaný obsah (title/body/CTA)? Nerozhodnuto. */
    assetReference: string;
}

/**
 * OPEN QUESTIONS (k rozhodnutí PŘED jakoukoliv Rule/logic implementací,
 * ne domýšlet za obchodní stranu):
 *
 * 1. Vztah PromoGroup <-> Product/PriceList: je PromoGroup nezávislá
 *    entita (jako navržená QuantityTierGroup hypotéza C), nebo odvozená
 *    z existujícího PriceList konceptu?
 * 2. Campaign lifecycle states: jaké přesně stavy (DRAFT/SCHEDULED/
 *    ACTIVE/ENDED/CANCELLED?) a jaké přechody mezi nimi jsou povolené?
 * 3. CampaignPlacement typy: kde přesně se kampaně mohou zobrazovat
 *    (závisí na tom, co Shoptet/frontend Connector Layer umožní)?
 * 4. Creative content model: strukturovaný, nebo volný text/asset URL?
 * 5. Kdo campaign vytváří/schvaluje (workflow), a jak se to promítá do
 *    Decision/Execution vrstvy (SOURCE->DERIVED->DECISION->EXECUTED->
 *    RECONCILED vzor, viz CANONICAL_MODEL_SYNTHESIS.md §8 Promotion
 *    referenční vzor)?
 */
