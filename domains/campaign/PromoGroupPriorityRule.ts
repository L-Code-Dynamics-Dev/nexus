// PromoGroupPriorityRule -- Fáze 6.2 business rule nad Fáze 6.1 kostrou
// (core/canonical/entities/Campaign.ts PromoGroup). Josovo zadání:
// "validuj priority" + "při konfliktu PromoGroup používej explicitní
// priority" + "žádné vlastní promo výpočty".
//
// Rule řeší VÝHRADNĚ "která PromoGroup vyhrává pro daný produkt" --
// NEPOČÍTÁ žádnou cenu ani slevu (Jose: "žádné vlastní promo výpočty,
// pokud nejsou ještě definované").
//
// UNRESOLVED (Jose: "pokud nejde jednoznačně odvodit, neimplementuj a
// označ UNRESOLVED"): remíza (dvě nebo více PromoGroup se STEJNOU
// nejvyšší priority pro tentýž produkt) -- zadání říká jen "používej
// explicitní priority", neuvádí tie-break algoritmus pro shodnou hodnotu.
// resolveConflict() proto v tomto případě VRACÍ selhání (`resolved:
// false`), NEVYBÍRÁ žádnou skupinu libovolně (např. první v poli) --
// tiché rozhodnutí by bylo domněnka, ne odvození ze zadání.

import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import type { PromoGroup } from '../../core/canonical/entities/Campaign.js';

export interface PromoGroupPriorityValidationInput {
    readonly priority: number;
}

export interface PromoGroupPriorityValidationResult {
    readonly valid: boolean;
    readonly reason?: string;
}

/**
 * Validuje PromoGroup.priority -- musí být definované konečné číslo a
 * nezáporné. Konkrétní horní hranice (max povolená priority) není v
 * zadání specifikována -- nevynucena.
 */
export class PromoGroupPriorityValidationRule implements Rule<PromoGroupPriorityValidationInput, PromoGroupPriorityValidationResult> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: PromoGroupPriorityValidationInput): PromoGroupPriorityValidationResult {
        if (!Number.isFinite(input.priority)) {
            return { valid: false, reason: 'priority musí být konečné číslo' };
        }
        if (input.priority < 0) {
            return { valid: false, reason: 'priority musí být nezáporné číslo' };
        }
        return { valid: true };
    }
}

export interface PromoGroupConflictResult {
    readonly resolved: boolean;
    readonly winner?: PromoGroup;
    readonly reason?: string;
}

/**
 * Vybere PromoGroup s nejvyšší priority mezi skupinami, které OBSAHUJÍ
 * daný produkt (member check přes productIds). Čistá funkce, žádný I/O.
 *
 * UNRESOLVED: remíza na nejvyšší priority -- viz komentář nahoře, vrací
 * `resolved: false`, nevybírá žádnou skupinu libovolně.
 */
export function resolveConflict(groups: readonly PromoGroup[], productId: string): PromoGroupConflictResult {
    const eligible = groups.filter((g) => g.productIds.includes(productId));

    if (eligible.length === 0) {
        return { resolved: false, reason: `žádná PromoGroup neobsahuje produkt "${productId}"` };
    }

    const maxPriority = Math.max(...eligible.map((g) => g.priority));
    const topGroups = eligible.filter((g) => g.priority === maxPriority);

    if (topGroups.length > 1) {
        return {
            resolved: false,
            reason: `remíza: ${topGroups.length} PromoGroup se shodnou nejvyšší priority (${maxPriority}) pro produkt "${productId}" -- UNRESOLVED, tie-break algoritmus není specifikován`,
        };
    }

    return { resolved: true, winner: topGroups[0] };
}
