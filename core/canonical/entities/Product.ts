// Product entity -- podle docs/entity-audit/Product.md.
//
// KRITICKÉ: žádný zdrojový systém má "celý" produkt -- každé pole má jiný
// source-of-truth (viz Source-of-Truth Matrix v auditu). Toto NENÍ migrace
// jedné existující struktury, je to KOMPOZICE z fragmentovaných zdrojů.
//
// OTEVŘENÉ (nerozhodnuto, viz audit §Open Questions -- nedomýšlet):
//   - Variant: povinná vrstva vždy, nebo opt-in?
//   - Discount limits: pole na Product, nebo samostatná Rule/RuleVersion?
//   - AvailabilitySnapshot: pole, nebo samostatná time-series entita?
// Tento soubor NEROZHODUJE tyto otázky -- ponechává je jako TBD markery.

import type { CanonicalEntity, EntityId, ExternalIdentity, Money } from './base.js';

/**
 * Product -- commerce entity. Shoptet je zdroj pravdy pro identitu, název,
 * kategorii, brand a ceny (viz Source-of-Truth Matrix, audit §SOURCE-OF-TRUTH).
 */
export interface Product extends CanonicalEntity {
    /** Externí identita -- Shoptet `code`. NIKDY totéž jako canonical `id`. */
    readonly externalIdentity: ExternalIdentity;

    /** Zdroj pravdy: Shoptet. */
    sku: string;
    name: string;
    categoryId?: EntityId;
    brandId?: EntityId;

    /**
     * Zdroj pravdy: Shoptet `buyPrice` -- evidenční/historická nákupní cena.
     * NIKDY nezaměňovat s SupplierOffer.unitPrice (Procurement doména) --
     * to je JINÁ hodnota, aktuální nabídka konkrétního dodavatele. Sloučení
     * by způsobilo kruhovou závislost identickou tvarem s již vyřešeným
     * INC-011 (Pricing Engine coupon-sales-writer.ts maxDiscount).
     */
    purchasePrice?: Money;

    /**
     * EAN -- POZOR: v žádném zdrojovém systému nebylo nalezeno jako reálné
     * datové pole, jen zmíněno v komentáři (feed-generator.ts). NENÍ
     * potvrzený canonical atribut -- ponecháno jako optional, needitovat
     * validaci proti němu, dokud nebude potvrzen skutečný zdroj dat.
     */
    ean?: string;

    /**
     * Discount limits (productMaxDiscount, brandLimits, categoryLimits) --
     * TBD zda patří sem, nebo do samostatné Rule/RuleVersion entity
     * (domains/pricing/). Nezahrnuto v tomto typu, dokud nebude rozhodnuto.
     */
}

/**
 * Variant -- TBD zda povinná vrstva vždy (i pro produkt bez variant), nebo
 * opt-in rozšíření. Pricing Engine ji nemá vůbec; AIE ji má jako
 * `variants[]` array. Nerozhodnuto, ponecháno jako samostatný typ.
 */
export interface Variant extends CanonicalEntity {
    readonly productId: EntityId;
    sku: string;
    attributes: Record<string, string>;
}
