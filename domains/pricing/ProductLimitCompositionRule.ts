// ProductLimitCompositionRule -- port okfish skládání `PRODUCT_LIMITS`
// ze tří JSON zdrojů + Stage 1 konfliktní kontrola.
//
// ODKUD PORTOVÁNO (živý klon okfish-pricing-engine, HEAD 3a910e2):
//   - cloudflare-worker/src/engine/config.ts:92-115 (`assertNoCrossFileConflicts`,
//     Stage 1 validace)
//   - cloudflare-worker/src/engine/config.ts:117-123 (`PRODUCT_LIMITS` spread)
//   - datové zdroje:
//       src/config/policies/zero-discount-products.json          (pole kódů)
//       src/config/policies/clearance-sale-products.json         (kód -> pct | okno)
//       src/config/policies/product-max-discount-overrides.json  (kód -> pct)
//
// CO DĚLÁ:
//   Ze tří nezávislých souborů složí JEDNU mapu `kód -> poměr` (0.22 = 22 %),
//   kterou pak DiscountLimitRule konzumuje jako `productMaxDiscount`.
//
//   Pořadí a převod jednotek 1:1 z config.ts:117-123:
//     1. zeroDiscountProducts  (pole kódů)  -> poměr 0     (žádná sleva)
//     2. clearance (AKTIVNÍ)   (pct)        -> pct / 100
//     3. productMaxDiscountOverrides (pct)  -> pct / 100
//   Zdroj 3 je spreadnutý poslední, takže by při konfliktu vyhrál -- právě
//   proto existuje Stage 1 kontrola, aby ke konfliktu nikdy nedošlo.
//
//   Do mapy se dostanou JEN AKTIVNÍ clearance položky. Neaktivní okno
//   (ClearanceWindowRule vrátí `active: false`) se vyfiltruje úplně -- okfish
//   config.ts:73 `.filter(pair => pair[1] !== undefined)`. To NENÍ totéž jako
//   "strop 0" ani "strop 100 %": produkt prostě žádný product-level strop
//   nemá a v DiscountLimitRule propadne na brand/category fallback.
//
//   STAGE 1 (config.ts:92-115): pokud tentýž kód figuruje ve DVOU ze tří
//   zdrojů, pravidlo VRÁTÍ KONFLIKT a mapu nepostaví. Okfish na tomhle místě
//   hází výjimku při načtení modulu ("refuse to build at all"). Nexus Rule
//   nesmí házet (Rule.ts: evaluate je čistá funkce), takže konflikt je vrácen
//   jako DATA -- rozhodnutí, jestli to shodí proces, patří volajícímu.
//   Chování je jinak identické: při konfliktu žádná mapa, tj. nelze omylem
//   spočítat cenu z nejednoznačné konfigurace.
//
//   POZOR na porovnávanou množinu: Stage 1 v okfishi kontroluje VŠECHNY
//   klíče clearance souboru (config.ts:113 `Object.keys(clearanceSaleProducts)`),
//   tedy i ty s neaktivním oknem. Konflikt je vada konfigurace bez ohledu na
//   datum. Zachováno 1:1 -- proto se konflikt počítá z `clearanceCodes`
//   (všechny), zatímco do mapy jdou jen aktivní.
//
// CO EXPLICITNĚ NEDĚLÁ:
//   - Nečte soubory z disku. Vstupem jsou už načtená data (Worker nemá `fs`,
//     stejný důvod jako u PricingConfigurationProvider).
//   - Nevyhodnocuje clearance okna sama. Volající je vyhodnotí
//     ClearanceWindowRule a předá sem už jen aktivní dvojice -- aby `now`
//     zůstalo vstupem jediného pravidla a tohle zůstalo čistě datové.
//   - Nepočítá cenu ani strop neaplikuje. Jen skládá mapu.
//   - Neřeší brandLimits/categoryLimits -- ty jdou přímo z policy-v1.json
//     do DiscountLimitRule, tuhle kompozicí neprocházejí.

import Decimal from 'decimal.js';
import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';

/** Jmenný zdroj limitu -- kvůli hlášce konfliktu i auditovatelnosti mapy. */
export type ProductLimitSourceFile =
    | 'zero-discount-products.json'
    | 'clearance-sale-products.json'
    | 'product-max-discount-overrides.json';

export interface ProductLimitCompositionRuleInput {
    /** zero-discount-products.json -- pole kódů, každý dostane poměr 0. */
    readonly zeroDiscountCodes: readonly string[];
    /**
     * VŠECHNY kódy z clearance-sale-products.json, včetně těch s neaktivním
     * oknem -- vstup pro Stage 1 kontrolu (viz hlavička).
     */
    readonly clearanceCodes: readonly string[];
    /**
     * Jen AKTIVNÍ clearance položky (kód -> pct, 22 = 22 %), vyhodnocené
     * ClearanceWindowRule. Podmnožina `clearanceCodes`.
     */
    readonly activeClearancePct: Record<string, number>;
    /** product-max-discount-overrides.json (kód -> pct, 10 = 10 %). */
    readonly productMaxDiscountOverridePct: Record<string, number>;
}

export interface ProductLimitConflict {
    readonly code: string;
    readonly sourceA: ProductLimitSourceFile;
    readonly sourceB: ProductLimitSourceFile;
}

export interface ProductLimitCompositionRuleResult {
    /** `false` = Stage 1 našla konflikt, `limits` je prázdná. */
    readonly valid: boolean;
    /** Složená mapa kód -> poměr slevy. Prázdná při konfliktu. */
    readonly limits: Record<string, Decimal>;
    /** Ze kterého souboru každý klíč pochází. */
    readonly sources: Record<string, ProductLimitSourceFile>;
    /** Všechny nalezené konflikty (ne jen první). */
    readonly conflicts: readonly ProductLimitConflict[];
    /** Hláška ve tvaru okfish config.ts:101-104. Jen při konfliktu. */
    readonly reason?: string;
}

const HUNDRED = new Decimal('100');

export class ProductLimitCompositionRule
    implements
        Rule<ProductLimitCompositionRuleInput, ProductLimitCompositionRuleResult>
{
    constructor(public readonly context: RuleContext) {}

    evaluate(
        input: ProductLimitCompositionRuleInput
    ): ProductLimitCompositionRuleResult {
        // --- STAGE 1: cross-file conflict check -------------------------
        // Stejná dvojitá smyčka jako okfish assertNoCrossFileConflicts,
        // stejné pořadí zdrojů (config.ts:111-115), tedy i stejné pořadí
        // dvojic v hlášce.
        const sourceLists: ReadonlyArray<readonly [ProductLimitSourceFile, readonly string[]]> = [
            ['zero-discount-products.json', input.zeroDiscountCodes],
            ['clearance-sale-products.json', input.clearanceCodes],
            [
                'product-max-discount-overrides.json',
                Object.keys(input.productMaxDiscountOverridePct),
            ],
        ];

        const conflicts: ProductLimitConflict[] = [];
        const reasons: string[] = [];

        for (let i = 0; i < sourceLists.length; i++) {
            for (let j = i + 1; j < sourceLists.length; j++) {
                const entryA = sourceLists[i];
                const entryB = sourceLists[j];
                if (entryA === undefined || entryB === undefined) continue;
                const [nameA, codesA] = entryA;
                const [nameB, codesB] = entryB;
                const setB = new Set<string>(codesB);
                const hits = codesA.filter((code: string) => setB.has(code));
                if (hits.length > 0) {
                    for (const code of hits) {
                        conflicts.push({ code, sourceA: nameA, sourceB: nameB });
                    }
                    reasons.push(
                        `Product code(s) ${hits.join(', ')} appear in BOTH ${nameA} and ${nameB}. ` +
                            `This is ambiguous -- the map spread later in PRODUCT_LIMITS would silently win with no ` +
                            `warning. Remove the code from one of the two files before deploying.`
                    );
                }
            }
        }

        if (conflicts.length > 0) {
            return {
                valid: false,
                limits: {},
                sources: {},
                conflicts,
                reason: reasons.join(' '),
            };
        }

        // --- Kompozice mapy (config.ts:117-123) -------------------------
        const limits: Record<string, Decimal> = {};
        const sources: Record<string, ProductLimitSourceFile> = {};

        for (const code of input.zeroDiscountCodes) {
            limits[code] = new Decimal(0);
            sources[code] = 'zero-discount-products.json';
        }

        for (const [code, pct] of Object.entries(input.activeClearancePct)) {
            limits[code] = new Decimal(pct).div(HUNDRED);
            sources[code] = 'clearance-sale-products.json';
        }

        for (const [code, pct] of Object.entries(input.productMaxDiscountOverridePct)) {
            limits[code] = new Decimal(pct).div(HUNDRED);
            sources[code] = 'product-max-discount-overrides.json';
        }

        return { valid: true, limits, sources, conflicts: [] };
    }
}
