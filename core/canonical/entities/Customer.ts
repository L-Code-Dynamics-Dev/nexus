// Customer -- podle docs/entity-audit/Customer.md.
//
// ENTITY BOUNDARY (kontraktu závazné pravidlo, potvrzeno auditem):
//   Customer != RiskIdentity != RiskGraphNode != RiskGraphEdge
//
// Customer je commerce entita. RiskIdentity/RiskGraphNode patří do
// domains/safeorder/, NE sem. Guest checkout má RiskIdentity BEZ
// Customer záznamu -- Customer proto NENÍ primární identita Nexusu,
// je to jedna z několika identitních projekcí.

import type { CanonicalEntity, EntityId, ExternalIdentity } from './base.js';

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
}

/**
 * TBD markery, které tento soubor VĖDOMĖ neřeší (viz audit Open Questions):
 *   - guest identity boundary (Customer bez záznamu, jen RiskIdentity)
 *   - přesný Customer lifecycle (stav není v auditu doložen)
 *   - field-level source of truth pro každé pole nad rámec výše uvedeného
 *   - customerGroupId -- je to totéž jako Shoptet customerGroup, nebo
 *     nezávislý Nexus koncept?
 */
