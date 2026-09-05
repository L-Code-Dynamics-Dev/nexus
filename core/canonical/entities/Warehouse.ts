// Warehouse -- Fáze 6 doménová kostra (docs/MIGRATION_PLAN.md, Josovo
// zadání 2026-09-05: "Další kroky Fáze 6"). Žádný zdrojový systém má
// vícesklad koncept -- Stock.ts dnes reprezentuje jednu agregovanou pozici.
//
// ROZHODNUTO (Jose 2026-09-05):
//   - Warehouse -> StockPosition přes `warehouseId` (StockPosition v
//     Stock.ts rozšířeno o volitelné `warehouseId` pole -- viz Stock.ts).
//   - Warehouse NENÍ totéž jako Supplier (Procurement doména,
//     SupplierOffer) -- oddělené koncepty (dodavatel != sklad), viz Jose:
//     "Dodrž přesně oddělení domén: Warehouse není Supplier". Žádná
//     vazba/sloučení se Supplier zde neimplementuje.
//
// Tento soubor implementuje POUZE základní kontrakt.

import type { CanonicalEntity } from './base.js';

export interface Warehouse extends CanonicalEntity {
    name: string;
    /** TBD: fyzická adresa, nebo jen logický identifikátor (pro dropshipping supplier bez fyzického skladu)? */
    isPhysical: boolean;
}

/**
 * ROZHODNUTO (Jose 2026-09-05): Warehouse -> StockPosition.warehouseId
 * (viz Stock.ts), Warehouse != Supplier (oddělené domény, žádná vazba
 * mezi nimi zde). Zbývající OPEN QUESTION (business rule detail):
 * 1. Fyzická adresa jako pole, nebo jen logický identifikátor? Nerozhodnuto.
 */
