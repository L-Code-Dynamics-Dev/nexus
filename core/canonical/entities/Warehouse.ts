// Warehouse -- PLACEHOLDER, čistě NEW BUILD (docs/CANONICAL_MODEL_SYNTHESIS.md
// §13). Fáze 6 (docs/MIGRATION_PLAN.md). Žádný zdrojový systém má vícesklad
// koncept -- Stock.ts (core/canonical/entities/Stock.ts) dnes reprezentuje
// jednu agregovanou pozici, ne per-warehouse rozpad. Pokud Nexus bude
// potřebovat multi-warehouse (více fyzických skladů/dropshipping lokací),
// je to nová stavba navazující na Stock.ts, ne migrace.
//
// Tento soubor je jen typová kostra, žádné obchodní rozhodnutí.

import type { CanonicalEntity } from './base.js';

export interface Warehouse extends CanonicalEntity {
    name: string;
    /** TBD: fyzická adresa, nebo jen logický identifikátor (pro dropshipping supplier bez fyzického skladu)? */
    isPhysical: boolean;
}

/**
 * OPEN QUESTIONS:
 * 1. Vztah k StockPosition (core/canonical/entities/Stock.ts) -- rozšířit
 *    Stock o warehouseId, nebo je Warehouse nezávislá dimenze až později?
 * 2. Je "Supplier" (Procurement doména, SupplierOffer) totéž jako Warehouse,
 *    nebo oddělené koncepty (dodavatel != sklad)?
 */
