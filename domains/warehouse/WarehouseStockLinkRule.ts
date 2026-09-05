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
// UNRESOLVED (nelze jednoznačně odvodit ze zadání, NEIMPLEMENTOVÁNO):
//   - Co přesně se má stát, když StockPosition.warehouseId je undefined
//     (StockPosition bez warehouse vazby vůbec, viz Stock.ts Non-
//     Interference komentář -- existující záznamy bez warehouseId zůstávají
//     validní). Zadání mluví o tom, ŽE aktivní vazba vyžaduje ACTIVE
//     Warehouse, ale neříká, jestli chybějící vazba je "neplatná" nebo
//     "mimo scope tohoto pravidla" (prostě žádná vazba k ověření). Tato
//     Rule vrací `isValidActiveLink: false` s explicitním reason pro tento
//     případ, ale NEPOVAŽUJE to jednoznačně za "chybu" v业務 smyslu --
//     jen za "toto konkrétní pravidlo se neuplatňuje / nelze potvrdit".
//     Volající, který potřebuje jiné chování pro "žádná vazba" vs.
//     "vazba na neaktivní sklad", potřebuje další explicitní zadání.
//   - Co se stane, když warehouseId odkazuje na Warehouse.id, který
//     neodpovídá předanému Warehouse objektu vůbec (typo/jiný sklad) --
//     Rule to řeší jako "vazba neplatná" (id se neshoduje), ale žádné
//     zadání neřeší chybové hlášení pro tento konkrétní scénář odděleně
//     od "sklad není aktivní".

import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import type { Warehouse } from '../../core/canonical/entities/Warehouse.js';
import type { StockPosition } from '../../core/canonical/entities/Stock.js';

export interface WarehouseStockLinkRuleInput {
    readonly warehouse: Warehouse;
    readonly stockPosition: StockPosition;
}

export interface WarehouseStockLinkRuleResult {
    readonly isValidActiveLink: boolean;
    readonly reason?: string;
}

export class WarehouseStockLinkRule implements Rule<WarehouseStockLinkRuleInput, WarehouseStockLinkRuleResult> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: WarehouseStockLinkRuleInput): WarehouseStockLinkRuleResult {
        const { warehouse, stockPosition } = input;

        if (stockPosition.warehouseId === undefined) {
            return {
                isValidActiveLink: false,
                reason: 'StockPosition nemá warehouseId -- žádná skladová vazba k ověření.',
            };
        }

        if (stockPosition.warehouseId !== warehouse.id) {
            return {
                isValidActiveLink: false,
                reason: `StockPosition.warehouseId ("${stockPosition.warehouseId}") neodpovídá předanému Warehouse.id ("${warehouse.id}").`,
            };
        }

        if (warehouse.status !== 'ACTIVE') {
            return {
                isValidActiveLink: false,
                reason: `Warehouse "${warehouse.id}" není aktivní (status "${warehouse.status}") -- pouze aktivní Warehouse může být použit jako aktivní skladová vazba.`,
            };
        }

        return { isValidActiveLink: true };
    }
}
