// Customer -- podle docs/entity-audit/Customer.md.
//
// ENTITY BOUNDARY (kontraktu závazné pravidlo, potvrzeno auditem):
//   Customer != RiskIdentity != RiskGraphNode != RiskGraphEdge
//
// Customer je commerce entita. RiskIdentity/RiskGraphNode patří do
// domains/safeorder/, NE sem. Guest checkout má RiskIdentity BEZ
// Customer záznamu -- Customer proto NENÍ primární identita Nexusu,
// je to jedna z několika identitních projekcí.
//
// B2B (Fáze 6.1, Josovo zadání 2026-09-05): ROZHODNUTO -- B2B NENÍ
// samostatný svět ani nová doména. Je to `BusinessProfile` capability/
// commercial profile navázaný na Customer (Jose: "B2B je Customer
// capability / commercial profile"). BusinessProfile MŮŽE rozšířit
// Pricing/Order/Payment/Invoice (např. B2B -> Pricing = který ceník/tier
// použít, B2B -> Order = obchodní podmínky, B2B -> Billing/Invoice =
// firemní fakturační údaje), ale VŠECHNY tyto domény zůstávají vlastníky
// své vlastní logiky -- BusinessProfile zde je jen datový kontrakt
// (company/tax identifiers/pricing context/payment terms), NIKDY vlastní
// PricingEngine ani duplicitní business logika.
//
// NEIMPLEMENTOVAT (Jose, Fáze 6.1 scope): B2B approval workflow, B2B
// credit limits -- jen kontrakt/typ, žádná logika.

import type { CanonicalEntity, EntityId, ExternalIdentity } from './base.js';

/**
 * BusinessProfile -- B2B rozšíření Customer. NENÍ samostatná CanonicalEntity
 * (nemá vlastní `id`/lifecycle) -- je to vložený datový kontrakt na
 * Customer, přesně jako Jose popsal: "Customer -> BusinessProfile" jako
 * capability, ne jako oddělený objekt s vlastní identitou.
 *
 * Pole odpovídají Josovu výčtu 1:1 (company/tax identifiers/pricing
 * context/payment terms) -- konkrétní shape každého pole je TBD (viz
 * Open Questions), tohle je jen kontrakt, který tato pole POJMENOVÁVÁ.
 */
export interface BusinessProfile {
    /** TBD: přesný shape (jen název, nebo structured {name, registeredAddress}?) -- nerozhodnuto. */
    company: string;
    /**
     * TBD: IČO/DIČ přesný shape (string vs. structured {ico, dic}) --
     * nerozhodnuto. Pojmenováno "taxIdentifiers" (množné číslo, pole nebo
     * struktura) podle Josova "tax identifiers", ne dřívějšího plochého
     * "companyIdentifier" (nahrazeno tímto přesnějším kontraktem).
     */
    taxIdentifiers: string;
    /**
     * ROZHODNUTO (implicitně z Jose "B2B -> Pricing = který ceník/tier
     * použít"): pricingContext je REFERENCE (jaký ceník/tier tahle firma
     * používá), NIKDY vlastní cenová pravidla -- Pricing doména zůstává
     * vlastníkem výpočtu, tohle pole jen říká KTERÝ ceník/tier se má
     * použít. TBD: přesný shape (FK na PriceList.id, nebo string tier key
     * jako Customer.priceListId níže?) -- nerozhodnuto, viz Open Questions.
     */
    pricingContext?: EntityId;
    /** TBD: konkrétní shape platebních podmínek (splatnost ve dnech? typ platby?) -- nerozhodnuto. */
    paymentTerms?: string;
}

/**
 * Customer -- commerce entita. Zdroj pravdy: Shoptet (`ShoptetCustomer.guid`).
 */
export interface Customer extends CanonicalEntity {
    readonly externalIdentity: ExternalIdentity;

    email?: string;
    customerGroupId?: EntityId;

    /**
     * TBD -- cardinalita vztahu k PriceList není definitivně potvrzená
     * (viz Price-PriceList-QuantityTier.md Open Questions: je PriceList
     * 1:1 loyalty tier navždy, nebo nezávislá B2B dimenze?). Ponecháno
     * jako volitelný odkaz, ne závazný kontrakt.
     */
    priceListId?: EntityId;

    /**
     * TBD -- vztah k RiskIdentity. Audit potvrdil, že Customer a
     * RiskIdentity NEJSOU 1:1 (guest checkout má RiskIdentity bez
     * Customer). Tento typ NESMÍ obsahovat riskIdentityId jako povinné
     * pole ani jako vlastnost -- pokud vazba existuje, žije v
     * domains/safeorder/ jako referenc SMĚREM k Customer.id, ne naopak.
     * Zde záměrně NEDEFINOVÁNO.
     */

    /**
     * B2B (Fáze 6.1, ROZHODNUTO Jose 2026-09-05): volitelný
     * `BusinessProfile` -- `undefined` = běžný B2C zákazník, beze změny
     * chování (Non-Interference, žádný existující Customer záznam se
     * tímto nerozbije). Nahrazuje dřívější ploché `isBusinessCustomer`/
     * `companyIdentifier` pole strukturovaným kontraktem podle Josova
     * návrhu (company/tax identifiers/pricing context/payment terms).
     * Přítomnost `businessProfile` SAMA znamená "je to B2B zákazník" --
     * žádný samostatný boolean flag navíc.
     */
    businessProfile?: BusinessProfile;
}

/**
 * TBD markery, které tento soubor VĖDOMĖ neřeší (viz audit Open Questions):
 *   - guest identity boundary (Customer bez záznamu, jen RiskIdentity)
 *   - přesný Customer lifecycle (stav není v auditu doložen)
 *   - field-level source of truth pro každé pole nad rámec výše uvedeného
 *   - customerGroupId -- je to totéž jako Shoptet customerGroup, nebo
 *     nezávislý Nexus koncept?
 *   - B2B (ROZHODNUTO Jose 2026-09-05: BusinessProfile capability na
 *     Customer, ne nová doména ani vlastní PricingEngine) -- zbývající
 *     OPEN QUESTIONS, EXPLICITNĚ MIMO SCOPE Fáze 6.1:
 *     1. BusinessProfile.company/taxIdentifiers/paymentTerms přesný shape
 *        (plochý string vs. structured objekt) -- nerozhodnuto.
 *     2. BusinessProfile.pricingContext vztah k Customer.priceListId --
 *        jsou to dvě nezávislá pole, nebo jedno nahrazuje druhé pro B2B
 *        zákazníky? Nerozhodnuto.
 *     3. KTERÝ existující Pricing Rule/config přesně čte
 *        `businessProfile.pricingContext` -- business logika, ne
 *        struktura kostry, mimo scope zde.
 *     4. B2B approval workflow, B2B credit limits -- EXPLICITNĚ MIMO
 *        SCOPE (Jose: "neimplementovat zatím"), žádné pole/typ pro ně
 *        zde záměrně nepřidáno.
 */
