// PromoGroupPriorityRule -- Fáze 6.2 business rule nad Fáze 6.1 kostrou
// (core/canonical/entities/Campaign.ts PromoGroup). Josovo zadání:
// "validuj priority" + "při konfliktu PromoGroup používej explicitní
// priority" + "žádné vlastní promo výpočty".
//
// Rule řeší VÝHRADNĚ "která PromoGroup vyhrává pro daný produkt" --
// NEPOČÍTÁ žádnou cenu ani slevu (Jose: "žádné vlastní promo výpočty,
// pokud nejsou ještě definované").
//
// ROZHODNUTO (Jose 2026-09-05, Fáze 6.3): "Nedeterministicky nerozhodovat.
// Vyžadovat jednoznačnou prioritu, nebo explicitní tie-break
// createdAt/id." Remíza na nejvyšší priority se řeší DETERMINISTICKY:
// 1. nejstarší createdAt vyhrává (ISO 8601 string, lexikograficky =
//    chronologicky srovnatelný), 2. pokud i createdAt je identický,
// nejmenší id (lexikograficky) jako finální rozhodčí. resolveConflict()
// proto vrací `resolved: true` vždy, když existuje alespoň jedna eligible
// skupina -- `tieBreakApplied` říká volajícímu, jestli rozhodnutí padlo
// na čisté priority, nebo na tie-break.

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
    /** true, pokud rozhodnutí padlo na tie-break (createdAt/id), ne na čisté priority. */
    readonly tieBreakApplied: boolean;
}

/**
 * Vybere PromoGroup s nejvyšší priority mezi skupinami, které OBSAHUJÍ
 * daný produkt (member check přes productIds). Čistá funkce, žádný I/O.
 *
 * ROZHODNUTO (Jose 2026-09-05, Fáze 6.3): remíza na nejvyšší priority se
 * řeší deterministickým tie-breakem -- nejstarší createdAt vyhrává, při
 * shodném createdAt rozhoduje lexikograficky nejmenší id. `resolved` je
 * proto vždy true, pokud existuje alespoň jedna eligible skupina.
 */
export function resolveConflict(groups: readonly PromoGroup[], productId: string): PromoGroupConflictResult {
    const eligible = groups.filter((g) => g.productIds.includes(productId));

    if (eligible.length === 0) {
        return { resolved: false, reason: `žádná PromoGroup neobsahuje produkt "${productId}"`, tieBreakApplied: false };
    }

    const maxPriority = Math.max(...eligible.map((g) => g.priority));
    const topGroups = eligible.filter((g) => g.priority === maxPriority);

    if (topGroups.length === 1) {
        return { resolved: true, winner: topGroups[0], tieBreakApplied: false };
    }

    // Tie-break 1: nejstarší createdAt (ISO 8601 -- lexikografické
    // srovnání odpovídá chronologickému). topGroups.length >= 2 zde
    // (větev length === 1 se vrátila výše), takže [0] je vždy definované.
    const firstTop = topGroups[0]!;
    const oldestCreatedAt = topGroups.reduce((oldest, g) => (g.createdAt < oldest ? g.createdAt : oldest), firstTop.createdAt);
    const oldestGroups = topGroups.filter((g) => g.createdAt === oldestCreatedAt);

    if (oldestGroups.length === 1) {
        return {
            resolved: true,
            winner: oldestGroups[0],
            tieBreakApplied: true,
            reason: `remíza na priority (${maxPriority}) vyřešena tie-breakem podle nejstaršího createdAt`,
        };
    }

    // Tie-break 2: i createdAt identický -- lexikograficky nejmenší id.
    // oldestGroups.length >= 2 zde (větev length === 1 se vrátila výše).
    const firstOldest = oldestGroups[0]!;
    const winner = oldestGroups.reduce((smallest, g) => (g.id < smallest.id ? g : smallest), firstOldest);
    return {
        resolved: true,
        winner,
        tieBreakApplied: true,
        reason: `remíza na priority (${maxPriority}) i createdAt vyřešena tie-breakem podle nejmenšího id`,
    };
}
