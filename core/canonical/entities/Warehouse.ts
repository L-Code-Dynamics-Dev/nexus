// Warehouse -- Fáze 6.1 lifecycle + invariants (Josovo zadání 2026-09-05:
// "Další kroky Fáze 6" + "Fáze 6.1 = lifecycle + základní invariants").
// Žádný zdrojový systém má vícesklad koncept -- Stock.ts dnes reprezentuje
// jednu agregovanou pozici.
//
// ROZHODNUTO (Jose 2026-09-05):
//   - Warehouse 1 -> N StockPosition, přes `warehouseId` (StockPosition v
//     Stock.ts rozšířeno o volitelné `warehouseId` pole -- viz Stock.ts).
//   - Warehouse NENÍ totéž jako Supplier (Procurement doména,
//     SupplierOffer) -- oddělené koncepty (dodavatel != sklad), viz Jose:
//     "Supplier zůstává úplně oddělený." Žádná vazba/sloučení se Supplier
//     zde neimplementuje.
//   - Warehouse lifecycle: ACTIVE -> INACTIVE. Na rozdíl od Campaign/
//     Invoice zde NENÍ terminální stav -- sklad se v této fázi neukončuje
//     natrvalo, jen dočasně vypíná/zapíná (obousměrný přechod). Jose
//     nezadal žádný "trvale zrušený" stav, proto se nedomýšlí.
//
// SCOPE (Jose Fáze 6.1): lifecycle + invarianty. NEIMPLEMENTOVAT: přesuny,
// rezervace, automatickou alokaci skladu ani jinou business logiku nad
// tento kontrakt.

import type { CanonicalEntity } from './base.js';
import type { StateAxisDefinition } from '../../state-machine/StateMachine.js';

/**
 * Warehouse lifecycle -- ROZHODNUTO (Jose): ACTIVE -> INACTIVE, obousměrně
 * povolený přechod (dočasné vypnutí skladu, ne trvalé zrušení). Žádný
 * terminální stav zde -- na rozdíl od Campaign (ENDED) a Invoice (ISSUED/
 * CANCELLED), Warehouse v této fázi nemá "natrvalo ukončený" koncept.
 */
export type WarehouseLifecycleState = 'ACTIVE' | 'INACTIVE';

export const WAREHOUSE_LIFECYCLE_DEFINITION: StateAxisDefinition<WarehouseLifecycleState> = {
    axisName: 'warehouseLifecycle',
    initialState: 'ACTIVE',
    terminalStates: [],
    transitions: {
        ACTIVE: ['INACTIVE'],
        INACTIVE: ['ACTIVE'],
    },
};

export interface Warehouse extends CanonicalEntity {
    name: string;
    /** TBD: fyzická adresa, nebo jen logický identifikátor (pro dropshipping supplier bez fyzického skladu)? */
    isPhysical: boolean;
    status: WarehouseLifecycleState;
}

/**
 * ROZHODNUTO (Jose 2026-09-05, Fáze 6.1): Warehouse 1:N StockPosition
 * (přes StockPosition.warehouseId, viz Stock.ts), Warehouse != Supplier
 * (oddělené domény, žádná vazba mezi nimi zde), lifecycle ACTIVE/INACTIVE
 * bez terminálního stavu. Zbývající OPEN QUESTIONS (business rule detail,
 * EXPLICITNĚ MIMO SCOPE Fáze 6.1):
 *
 * 1. Fyzická adresa jako pole, nebo jen logický identifikátor? Nerozhodnuto.
 * 2. Přesuny mezi sklady, rezervace, automatická alokace -- EXPLICITNĚ
 *    MIMO SCOPE (Jose: "žádné přesuny, rezervace ani automatická alokace
 *    skladu v této fázi"), neimplementovat bez dalšího zadání.
 */
