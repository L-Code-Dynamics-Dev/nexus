// Order -- podle docs/entity-audit/Order.md.
//
// KRITICKÉ (State Taxonomy, CONTRACT §4): externalStatus a canonicalStatus
// jsou DVĚ NEZÁVISLÉ vrstvy. Shoptet nemá pevný status enum (GET
// /api/orders/statuses vrací per-shop konfigurovatelný seznam) --
// canonicalStatus se NESMÍ odvodit přejmenováním externalStatus, musí
// být navržen nezávisle. Tento soubor NEDEFINUJE hodnoty canonicalStatus
// -- to je otevřený krok (viz Open Questions), ne domněnka.

import type { CanonicalEntity, EntityId, ExternalIdentity, Money } from './base.js';

/**
 * Surová hodnota ze Shoptetu -- per-shop konfigurovatelná, NENÍ enum.
 * `id`/`name` čteny 1:1, `system` flag může (ne musí) signalizovat
 * standardní chování (potvrzeno/zrušeno) -- nutno ověřit per-shop.
 */
export interface ExternalOrderStatus {
    readonly id: number;
    readonly name: string;
}

/**
 * Order -- externí platforma (Shoptet) je zdroj pravdy DOKUD nebude
 * importováno do canonical state. canonicalStatus zde ZÁMĚRNĚ chybí
 * jako konkrétní enum -- viz komentář výše.
 */
export interface Order extends CanonicalEntity {
    readonly externalIdentity: ExternalIdentity; // Shoptet code/guid

    customerId?: EntityId; // optional -- guest checkout, viz Customer.ts boundary
    externalStatus: ExternalOrderStatus;

    /**
     * TBD -- canonicalStatus mapping. NEDEFINOVÁNO zde. Podle auditu:
     *   1. je lifecycle jeden univerzální enum, nebo se štěpí na
     *      nezávislé osy (order/payment/fulfillment)?
     *   2. kdy v lifecycle vstupuje SafeOrder risk evaluace?
     *   3. kdy vstupuje AIE Procurement shortage detection?
     * Dokud tyto otázky nejsou zodpovězené, canonicalStatus se
     * NEPŘIDÁVÁ jako pole -- přidání bez odpovědi by bylo přesně to
     * "přejmenování externího statusu", které kontrakt zakazuje.
     */

    total?: Money;
    items?: OrderItem[];

    /** Ze Shoptetu, NENÍ totéž jako updatedAt (Nexus-side mutace). */
    readonly externalChangeTime: string;
}

export interface OrderItem extends CanonicalEntity {
    readonly orderId: EntityId;
    readonly productId: EntityId;
    quantity: number;
    unitPrice: Money;
    /**
     * TBD z auditu -- AIE CustomerOrderLine.ownStockQuantity zdroj
     * nejasný (totéž jako Shoptet stock, nebo nezávislý koncept?).
     * NEPŘIDÁNO zde, dokud nebude ověřeno -- viz Stock.ts audit.
     */
}

/**
 * Mapping External -> Canonical status je KONFIGURACE (per tenant/
 * connector), NE kód v core/. Signatura zde jen jako kontrakt --
 * implementace patří do connectors/shoptet/, ne do core/canonical/.
 */
export type MapExternalToCanonicalStatus = (
    external: ExternalOrderStatus,
    tenantId: string
) => { canonicalStatus: string } | { unresolved: true; preservedExternal: ExternalOrderStatus };
