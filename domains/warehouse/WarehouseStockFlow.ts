// WarehouseStockFlow -- Fáze 6.4 business flow, ne nová abstrakce.
// Josovo zadání 2026-09-05 (Fáze 6.4): "Warehouse -> StockPosition" je
// jeden ze jmenovaných use-caseů s přímou oporou v dosavadních
// rozhodnutích (Fáze 6.1-6.3). "Teď už bych nepřidával další abstrakce.
// Začal bych propojovat to, co jsme právě definovali, do reálných NEXUS
// use-caseů."
//
// Tento soubor NEPŘIDÁVÁ žádné nové business rozhodnutí, žádnou novou
// validaci ani žádné nové pole na entitách -- je to ČISTÁ KOMPOZICE nad
// již existující `WarehouseStockLinkRule` (domains/warehouse/
// WarehouseStockLinkRule.ts). `evaluateWarehouseStockLink` je přímý
// 1:1 wrapper (žádná nová logika navíc). `resolveWarehouseStockLinks`
// je stejné pravidlo aplikované na pole -- NENÍ to nová abstrakce, je to
// jen `Array.map()` nad existující Rule pro use-case "zkontroluj celý
// sklad najednou" (přirozené rozšíření use-case, ne nové rozhodnutí --
// žádná agregace/sčítání množství, žádná logika napříč pozicemi).
//
// Co tento flow ZÁMĚRNĚ NEDĚLÁ (stejné mimo-scope jako WarehouseStockLinkRule
// a Josovo explicitní "zatím vůbec neřešit" pro Fázi 6.4 -- "skladové
// přesuny"):
//   - Neimplementuje žádný přesun zboží mezi sklady.
//   - Neimplementuje žádnou rezervaci/alokaci množství.
//   - Nepočítá žádné agregované/dostupné množství napříč pozicemi nebo
//     sklady -- `resolveWarehouseStockLinks` vrací pole NEZÁVISLÝCH
//     výsledků, jeden per StockPosition, žádné sčítání ani vyhodnocení
//     "je sklad jako celek OK" navíc.

import type { RuleContext } from '../../core/canonical/rules/Rule.js';
import type { Warehouse } from '../../core/canonical/entities/Warehouse.js';
import type { StockPosition } from '../../core/canonical/entities/Stock.js';
import { WarehouseStockLinkRule, type WarehouseStockLinkRuleResult } from './WarehouseStockLinkRule.js';

/**
 * 1:1 use-case wrapper nad `WarehouseStockLinkRule` -- "je tahle konkrétní
 * skladová pozice platně navázaná na aktivní sklad?". Žádná nová logika,
 * jen pojmenovaný vstupní bod pro tenhle konkrétní use-case.
 */
export function evaluateWarehouseStockLink(
    context: RuleContext,
    warehouse: Warehouse,
    stockPosition: StockPosition
): WarehouseStockLinkRuleResult {
    const rule = new WarehouseStockLinkRule(context);
    return rule.evaluate({ warehouse, stockPosition });
}

export interface WarehouseStockLinkResolution {
    readonly stockPositionId: string;
    readonly result: WarehouseStockLinkRuleResult;
}

/**
 * Aplikuje `WarehouseStockLinkRule` na KAŽDOU pozici nezávisle -- use-case
 * "zkontroluj celý sklad najednou". Žádná agregace mezi pozicemi, žádné
 * sčítání množství -- jen pole samostatných výsledků, jeden per
 * StockPosition, ve stejném pořadí jako vstup.
 */
export function resolveWarehouseStockLinks(
    context: RuleContext,
    warehouse: Warehouse,
    stockPositions: readonly StockPosition[]
): WarehouseStockLinkResolution[] {
    const rule = new WarehouseStockLinkRule(context);
    return stockPositions.map((stockPosition) => ({
        stockPositionId: stockPosition.id,
        result: rule.evaluate({ warehouse, stockPosition }),
    }));
}
