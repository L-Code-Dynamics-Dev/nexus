// Campaign / PromoGroup / CampaignPlacement / Creative -- Fáze 6 doménová
// kostra (docs/MIGRATION_PLAN.md, Josovo zadání 2026-09-05: "Další kroky
// Fáze 6"). Čistě NEW BUILD, žádný zdrojový systém neobsahuje kód k migraci.
//
// ROZHODNUTO (Jose 2026-09-05): PromoGroup -> Product (NENÍ PriceList).
// Vazba je explicitní FK seznam (productIds), ne odvozená z ceníku/tieru --
// PromoGroup je nezávislá entita na Pricing doméně, viz "Dodrž přesně
// oddělení domén: PromoGroup není PriceList".
//
// SCOPE (Jose): implementovat POUZE základní kontrakty (typy, entity,
// vazby, ID, stavové hodnoty) -- žádná neodsouhlasená funkcionalita
// (email marketing, retargeting, affiliate, schvalovací workflow).
// Lifecycle states a Placement typy ZŮSTÁVAJÍ TBD (viz Open Questions),
// Jose zadání je neurčuje explicitně -- ponecháno jako string dokud
// nepadne konkrétní enum rozhodnutí.

import type { CanonicalEntity, EntityId, ISODateTime } from './base.js';

/**
 * PromoGroup -- seskupení produktů pro účely kampaně. ROZHODNUTO: vazba na
 * Product přes explicitní `productIds` (FK seznam), NENÍ odvozeno z
 * PriceList/ceníku ani z dynamického pravidla (kategorie/tag) -- to by
 * bylo přesně smíchání s Pricing doménou, které Jose zakázal.
 */
export interface PromoGroup extends CanonicalEntity {
    name: string;
    /** FK na Product.id -- explicitní členství, ne odvozené pravidlo. */
    productIds: EntityId[];
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
    /** FK na PromoGroup.id -- ROZHODNUTO (Jose): Campaign -> PromoGroup. */
    promoGroupId: EntityId;
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
 * ROZHODNUTO (Jose 2026-09-05): PromoGroup -> Product, Campaign ->
 * PromoGroup, Campaign -> Creative -- vazby výše implementovány jako
 * explicitní FK. Zbývající OPEN QUESTIONS (mimo scope Fáze 6 kostry,
 * Jose: "nepřidávej žádnou neodsouhlasenou funkcionalitu" -- lifecycle
 * states, placement enum a content model jsou BUSINESS RULE detaily,
 * ne struktura kostry, proto zůstávají TBD):
 *
 * 1. Campaign lifecycle states: jaké přesně stavy (DRAFT/SCHEDULED/
 *    ACTIVE/ENDED/CANCELLED?) a jaké přechody mezi nimi jsou povolené?
 * 2. CampaignPlacement typy: kde přesně se kampaně mohou zobrazovat
 *    (závisí na tom, co Shoptet/frontend Connector Layer umožní)?
 * 3. Creative content model: strukturovaný, nebo volný text/asset URL?
 * 4. Kdo campaign vytváří/schvaluje (workflow), a jak se to promítá do
 *    Decision/Execution vrstvy (SOURCE->DERIVED->DECISION->EXECUTED->
 *    RECONCILED vzor, viz CANONICAL_MODEL_SYNTHESIS.md §8 Promotion
 *    referenční vzor)? -- explicitně MIMO SCOPE (Jose: "žádné B2B
 *    schvalování" per bod 5 zadání, analogicky pro Campaign schvalování).
 */
