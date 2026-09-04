// Price / PriceList / QuantityTier boundary -- podle
// docs/entity-audit/Price-PriceList-QuantityTier.md.
//
// KRITICKÉ ROZLIŠENÍ (nesmí se slít):
//   Product.purchasePrice  != SupplierOffer.unitPrice
//   PricingComputationInput (efemérní vstup) != PersistedPriceRecord (Shoptet zrcadlo)
//   Shoptet native quantity-discount config != Nexus quantity pricing (neexistuje)

import type { CanonicalEntity, EntityId, ExternalIdentity, Money } from './base.js';

/**
 * PriceList -- DNES 1:1 s loyalty tier (TIER_PRICELIST_MAP), hardcoded v
 * legacy kódu. TBD zda Canonical Model má umožnit nezávislou B2B dimenzi.
 * `tenantScopedTierKey` nahrazuje hardcoded mapování -- musí být tenant
 * config, ne kód (potvrzený Confirmed Conflict, viz CONTRACT §6).
 */
export interface PriceList extends CanonicalEntity {
    readonly externalIdentity: ExternalIdentity; // Shoptet pricelist ID
    name: string;
    tenantScopedTierKey: string;
}

/**
 * PricingComputationInput -- EFEMÉRNÍ vstup do výpočtu (per sync run, per
 * SKU, per tier). NENÍ perzistovaná entita. Odpovídá legacy PricingInput.
 */
export interface PricingComputationInput {
    readonly productSku: string;
    readonly priceListId: EntityId;
    basePrice: Money;
    salePrice?: Money;
    /**
     * Zdroj pravdy: Shoptet `buyPrice`. NIKDY totéž jako
     * SupplierOffer.unitPrice (Procurement doména, aktuální nabídka
     * konkrétního dodavatele) -- viz Product.ts komentář, stejné pravidlo.
     */
    purchasePrice?: Money;
    productMaxDiscount?: number;
    /**
     * Legacy `PricingInput.customerTier` -- dnes 1:1 s `tenantScopedTierKey`
     * na PriceList (hardcoded TIER_PRICELIST_MAP v legacy). Zůstává string,
     * ne union, protože Nexus nesmí zadrátovat konkrétní tenant tiery do
     * core typu (viz PriceList komentář výše).
     */
    customerTier?: string;
    allowLoyaltyDiscount?: boolean;
    manufacturer?: string;
    category?: string;
}

/**
 * PersistedPriceRecord -- Shoptet zrcadlo, PO write-backu. Zdroj pravdy
 * je Shoptet (Nexus počítá, Shoptet je cíl zápisu a stává se zdrojem
 * pravdy pro AKTUÁLNÍ hodnotu, dokud příští sync neproběhne znovu).
 */
export interface PersistedPriceRecord extends CanonicalEntity {
    readonly productId: EntityId;
    readonly priceListId: EntityId;
    value: Money;
    /** Reconciliation contract -- Stage 5 pattern (nejsilněji ověřený v celém auditu). */
    lastReconciledAt?: string;
}

/**
 * QuantityTier -- NEW BUILD / TBD, forenzně potvrzeno (ne domněnka).
 * Quantity discount calculation NENÍ přítomen v legacy Pricing Engine.
 * minimumAmount/maximumAmount/applyQuantityDiscount/applyVolumeDiscount
 * jsou čistý pass-through do Shoptet XML -- výpočet dělá NATIVNÍ Shoptet
 * quantityDiscount* funkce (potvrzeno v shoptet_openapi.json), ne Nexus.
 *
 * Tento typ je ZÁMĚRNĚ prázdný/neimplementovaný -- žádný legacy kód
 * k migraci neexistuje. Pokud Nexus bude chtít vlastní quantity pricing
 * (např. pro platformy bez nativní podpory), je to nová business
 * capability, ne migrace, a musí se navrhnout jako samostatná práce.
 */
export interface QuantityTierSourceConfig {
    readonly productId: EntityId;
    /** Shoptet native config -- pass-through, Nexus to nevyhodnocuje. */
    minimumAmount?: number;
    maximumAmount?: number;
    applyQuantityDiscount?: boolean;
    applyVolumeDiscount?: boolean;
}
