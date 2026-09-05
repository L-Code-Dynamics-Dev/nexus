// WarehouseStockLinkRule -- Fáze 6.2 business rule nad Warehouse/StockPosition
// vazbou (core/canonical/entities/{Warehouse,Stock}.ts). Validuje POUZE
// explicitně zadané pravidlo z Josova zadání, žádná domněnka navíc.
//
// Pravidlo implementované zde:
//   - POUZE aktivní (ACTIVE) Warehouse může být použit jako aktivní
//     skladová vazba. Rule přijímá Warehouse a StockPosition jako
//     explicitně předané vstupy (žádné I/O, žádné vlastní načítání) a
//     ověří, že StockPosition.warehouseId odkazuje na TENTO Warehouse a
//     že jeho status je ACTIVE.
//
// Co tato Rule ZÁMĚRNĚ NEDĚLÁ (Jose: "žádné skladové přesuny ani alokace"):
//   - Neimplementuje žádnou logiku přesunu zboží mezi sklady.
//   - Neimplementuje žádnou rezervaci/alokaci množství.
//   - Nevytváří ani neupravuje vazbu na Supplier -- Supplier zůstává
//     oddělený koncept, tato Rule o něm vůbec neví.
//
// ROZHODNUTO (Jose 2026-09-05, Fáze 6.3): "warehouseId === undefined
// znamená globální / dosud neurčený sklad, NE automaticky 'hlavní sklad'."
// `linkStatus` diskriminant níže explicitně odlišuje tenhle legitimní stav
// ("UNSCOPED" -- sklad zatím nebyl určen, není to porušení pravidla) od
// skutečných chyb (nesprávná/neaktivní vazba). ŽÁDNÝ fallback na
// konkrétní "hlavní sklad" zde není a nebude -- to by bylo přesně to
// domýšlení, které Jose zakázal.

import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import type { Warehouse } from '../../core/canonical/entities/Warehouse.js';
import type { StockPosition } from '../../core/canonical/entities/Stock.js';

export interface WarehouseStockLinkRuleInput {
    readonly warehouse: Warehouse;
    readonly stockPosition: StockPosition;
}

/**
 * ROZHODNUTO (Jose, Fáze 6.3) -- diskriminant vazby:
 *   'ACTIVE_LINK'        -- StockPosition patří danému Warehouse a ten je ACTIVE.
 *   'UNSCOPED'           -- StockPosition.warehouseId je undefined; sklad je
 *                           globální/dosud neurčený, NENÍ to chyba ani
 *                           implicitní "hlavní sklad" -- žádný fallback.
 *   'MISMATCHED_WAREHOUSE' -- StockPosition.warehouseId odkazuje na JINÝ
 *                           sklad, než byl předaný.
 *   'INACTIVE_WAREHOUSE' -- vazba na SPRÁVNÝ Warehouse, ale ten není ACTIVE.
 */
export type WarehouseStockLinkStatus = 'ACTIVE_LINK' | 'UNSCOPED' | 'MISMATCHED_WAREHOUSE' | 'INACTIVE_WAREHOUSE';

export interface WarehouseStockLinkRuleResult {
    /** `true` POUZE pro 'ACTIVE_LINK' -- žádná jiná hodnota linkStatus nikdy nevrací true. */
    readonly isValidActiveLink: boolean;
    readonly linkStatus: WarehouseStockLinkStatus;
    readonly reason?: string;
}

export class WarehouseStockLinkRule implements Rule<WarehouseStockLinkRuleInput, WarehouseStockLinkRuleResult> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: WarehouseStockLinkRuleInput): WarehouseStockLinkRuleResult {
        const { warehouse, stockPosition } = input;

        if (stockPosition.warehouseId === undefined) {
            return {
                isValidActiveLink: false,
                linkStatus: 'UNSCOPED',
                reason: 'StockPosition nemá warehouseId -- sklad je globální/dosud neurčený. Toto NENÍ chyba a NENÍ to automaticky "hlavní sklad".',
            };
        }

        if (stockPosition.warehouseId !== warehouse.id) {
            return {
                isValidActiveLink: false,
                linkStatus: 'MISMATCHED_WAREHOUSE',
                reason: `StockPosition.warehouseId ("${stockPosition.warehouseId}") neodpovídá předanému Warehouse.id ("${warehouse.id}").`,
            };
        }

        if (warehouse.status !== 'ACTIVE') {
            return {
                isValidActiveLink: false,
                linkStatus: 'INACTIVE_WAREHOUSE',
                reason: `Warehouse "${warehouse.id}" není aktivní (status "${warehouse.status}") -- pouze aktivní Warehouse může být použit jako aktivní skladová vazba.`,
            };
        }

        return { isValidActiveLink: true, linkStatus: 'ACTIVE_LINK' };
    }
}
