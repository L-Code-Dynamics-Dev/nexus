// ClearanceWindowRule -- port okfish "clearance datová okna".
//
// ODKUD PORTOVÁNO (živý klon okfish-pricing-engine, HEAD 3a910e2):
//   - cloudflare-worker/src/engine/config.ts:61-73
//     (`type ClearanceEntry`, `resolveClearancePct`, `activeClearanceEntries`)
//   - datový zdroj: src/config/policies/clearance-sale-products.json
//
// CO DĚLÁ:
//   Rozhodne, zda je výprodejová položka v daném okamžiku AKTIVNÍ, a vrátí
//   její procento slevy.
//
//   Dva tvary záznamu, oba podporované (okfish config.ts:61):
//     - `22`                                     -> vždy aktivní, 22 %
//     - `{ pct, validFrom?, validTo? }`          -> aktivní jen v okně
//   Datumy jsou "YYYY-MM-DD".
//
//   Hraniční chování 1:1 z `resolveClearancePct` (config.ts:63-68):
//     - `validFrom` a `now < new Date(validFrom)` -> NEAKTIVNÍ.
//       `new Date("2026-08-31")` je půlnoc UTC, takže okno začíná
//       2026-08-31T00:00:00Z včetně (v ten okamžik `<` neplatí -> aktivní).
//     - `validTo` a `now > new Date(validTo + "T23:59:59")` -> NEAKTIVNÍ.
//       POZOR: `"2026-09-04T23:59:59"` BEZ zóny je v JS parsováno jako
//       LOKÁLNÍ čas, na rozdíl od `"2026-08-31"`, které je UTC. Tuhle
//       asymetrii má okfish taky a je zachována 1:1 -- viz komentář
//       u `parseValidToBoundary()` níže. Na strojích v UTC (Cloudflare
//       Worker, CI) rozdíl mizí.
//     - Chybějící hranice = neomezená z té strany.
//     - Interval je INKLUZIVNÍ na obou koncích (celý poslední den).
//
//   DETERMINISMUS: `now` je VSTUP. Okfish tohle porušuje -- config.ts:70
//   volá `new Date()` při načtení modulu, takže dlouhoběžící Worker isolate
//   může držet zastaralé okno mezi deploymenty (okfish to sám přiznává
//   v komentáři config.ts:55-60 jako "known, accepted limitation").
//   V Nexusu tahle vada nesmí být zopakovaná -- Rule.ts vyžaduje, aby
//   stejný vstup dal stejný výsledek.
//
// CO EXPLICITNĚ NEDĚLÁ:
//   - Nepočítá cenu. Vrací procento; převod na strop a jeho aplikaci dělá
//     ProductLimitCompositionRule + DiscountLimitRule.
//   - Nedělá cross-file conflict check (to je ProductLimitCompositionRule).
//   - Nečte JSON z disku.
//
// NEOVĚŘENO: v okfish `products_import.csv` (jediný dohledatelný snapshot
// reálného výstupu) není JEDINÝ produkt, u kterého by clearance okno reálně
// zabralo -- ten snapshot vznikl PŘED zavedením clearance-sale-products.json
// (kód `3963P-S` v něm má -10 % z brandLimits, ne -20 % z clearance okna).
// Parita datového okna je tedy ověřená jen proti okfish ZDROJOVÉMU KÓDU,
// ne proti reálnému výstupu z produkce.

import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import type { ISODateTime } from '../../core/canonical/entities/base.js';

/** 1:1 tvar `ClearanceEntry` z okfish config.ts:61. */
export type ClearanceEntry =
    | number
    | {
          readonly pct: number;
          /** "YYYY-MM-DD", inkluzivně. */
          readonly validFrom?: string;
          /** "YYYY-MM-DD", inkluzivně (celý ten den). */
          readonly validTo?: string;
      };

export interface ClearanceWindowRuleInput {
    readonly entry: ClearanceEntry;
    /**
     * Referenční čas. VSTUP, nikdy `Date.now()` uvnitř `evaluate()` --
     * Rule.ts vyžaduje determinismus. Okfish tohle porušuje (config.ts:70),
     * viz hlavička.
     */
    readonly now: ISODateTime;
}

export type ClearanceInactiveReason = 'BEFORE_WINDOW' | 'AFTER_WINDOW' | 'INVALID_DATE';

export interface ClearanceWindowRuleResult {
    /** `true` = výprodej v `now` platí. */
    readonly active: boolean;
    /** Procento slevy (22 = 22 %). Přítomno jen když `active`. */
    readonly pct?: number;
    /** Proč neaktivní. Přítomno jen když `!active`. */
    readonly reasonCode?: ClearanceInactiveReason;
}

/**
 * `new Date("YYYY-MM-DD")` -- ISO date-only, JS ho parsuje jako UTC půlnoc.
 * Vrací `undefined` u nerozparsovatelného vstupu (fail-closed).
 */
function parseValidFromBoundary(day: string): number | undefined {
    const ms = Date.parse(day);
    return Number.isNaN(ms) ? undefined : ms;
}

/**
 * `new Date(validTo + "T23:59:59")` -- okfish config.ts:66.
 *
 * Tenhle řetězec NEMÁ zónu, takže ho ECMAScript parsuje jako LOKÁLNÍ čas
 * (na rozdíl od date-only formy výše, která je UTC). Je to nekonzistence
 * v okfishi, ne v tomhle portu -- kdybychom to tu "opravili" na UTC,
 * rozešli bychom se s okfishem na strojích mimo UTC. Zachováno 1:1;
 * na Cloudflare Workeru a v CI (obojí UTC) je to bez rozdílu.
 */
function parseValidToBoundary(day: string): number | undefined {
    const ms = Date.parse(`${day}T23:59:59`);
    return Number.isNaN(ms) ? undefined : ms;
}

export class ClearanceWindowRule
    implements Rule<ClearanceWindowRuleInput, ClearanceWindowRuleResult>
{
    constructor(public readonly context: RuleContext) {}

    evaluate(input: ClearanceWindowRuleInput): ClearanceWindowRuleResult {
        // Prostý number = žádné okno, vždy aktivní (config.ts:64).
        if (typeof input.entry === 'number') {
            return { active: true, pct: input.entry };
        }

        const nowMs = Date.parse(input.now);
        if (Number.isNaN(nowMs)) {
            return { active: false, reasonCode: 'INVALID_DATE' };
        }

        const { pct, validFrom, validTo } = input.entry;

        if (validFrom !== undefined) {
            const fromMs = parseValidFromBoundary(validFrom);
            if (fromMs === undefined) {
                return { active: false, reasonCode: 'INVALID_DATE' };
            }
            // okfish: `now < new Date(validFrom)` -> undefined
            if (nowMs < fromMs) {
                return { active: false, reasonCode: 'BEFORE_WINDOW' };
            }
        }

        if (validTo !== undefined) {
            const toMs = parseValidToBoundary(validTo);
            if (toMs === undefined) {
                return { active: false, reasonCode: 'INVALID_DATE' };
            }
            // okfish: `now > new Date(validTo + 'T23:59:59')` -> undefined
            if (nowMs > toMs) {
                return { active: false, reasonCode: 'AFTER_WINDOW' };
            }
        }

        return { active: true, pct };
    }
}
