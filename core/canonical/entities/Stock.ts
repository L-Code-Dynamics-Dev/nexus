// Stock -- podle docs/entity-audit/Stock.md.
//
// KRITICKÉ: StockPosition (source facts) a Derived Availability jsou
// ZÁMĚRNĚ oddělené typy. Confirmed Gap z auditu: Stock/Availability se
// dnes NIKDY nepersistuje -- vždy compute-on-read. Proto StockPosition
// (tento soubor) je návrh CANONICAL PERSISTED entity, kterou legacy
// systém nemá -- je to řešení nálezu, ne migrace existující tabulky.
//
// NEVYTVÁŘET: reserved/available/allocated/backordered -- audit pro ně
// nemá zdrojový důkaz (viz OPEN QUESTIONS v auditu, bod 4).

import type { CanonicalEntity, EntityId, ISODateTime } from './base.js';

/**
 * StockPosition -- CANONICAL PERSISTED entity, source facts ze Shoptetu.
 * Zdroj pravdy: Shoptet (`v.stock`, `v.purchasable`, `v.canPreorder`/
 * `OnOrder`, `v.inTransit`) -- identická 4 pole čtená API i CSV export
 * normalizerem v legacy AIE kódu.
 *
 * Toto je NOVÝ návrh perzistence -- legacy systém StockPosition nikdy
 * neukládal (compute-on-read, Confirmed Gap). Reconciliation contract
 * (Expected vs Actual) vyžaduje historický snapshot k porovnání; bez
 * perzistence tohoto typu není reconciliation možná.
 */
export interface StockPosition extends CanonicalEntity {
    readonly productId: EntityId;
    readonly variantId?: EntityId;

    /** Source field, ze Shoptetu. */
    quantity: number;
    /** Source field. Nezávislé na quantity -- purchasable=true i při quantity=0 je validní. */
    purchasable: boolean;
    /** Source field. Nezávislé na quantity/purchasable. */
    canPreorder: boolean;
    /** Source field. Nezávislé na ostatních třech. */
    inTransit: boolean;

    /** Timestamp posledního čtení ze zdroje -- nutný pro reconciliation. */
    readonly observedAt: ISODateTime;
}

/**
 * DerivedAvailability -- Projection (CANONICAL-MODEL-CONTRACT.md §3),
 * NIKDY vlastní perzistovaný stav, žádné vlastní ID s lifecycle.
 * Vypočítáváno nad StockPosition (per variant, pak agregace na produkt --
 * legacy AvailabilityEngine agreguje variant-level klasifikace).
 *
 * `lowStockThreshold` je explicitně parametr, NE hardcoded konstanta --
 * legacy `LOW_STOCK_THRESHOLD = 3` byl Confirmed Conflict (porušení
 * multi-tenant principu), zde musí přijít z tenant config.
 */
export interface DerivedAvailability {
    readonly stockPosition: StockPosition;
    readonly lowStockThreshold: number; // tenant-scoped config, ne konstanta
    readonly inStock: boolean; // derived: quantity > 0
    readonly classification: AvailabilityClassification;
}

export type AvailabilityClassification =
    | 'IN_STOCK'
    | 'LOW_STOCK'
    | 'PARTIALLY_AVAILABLE'
    | 'IN_TRANSIT'
    | 'ON_ORDER'
    | 'OUT_OF_STOCK'
    | 'UNKNOWN';

/**
 * Pure function -- žádný vlastní stav, přepočitatelná (Projection Taxonomy
 * §3 kontraktu). Signatura, NE implementace -- legacy AvailabilityEngine
 * logiku je třeba portovat samostatně, po schválení tohoto typu.
 */
export type ClassifyAvailability = (
    position: StockPosition,
    lowStockThreshold: number
) => AvailabilityClassification;
