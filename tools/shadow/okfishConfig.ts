// Shadow harness -- načtení okfish policy konfigurace. POUZE ČTENÍ.
//
// Reimplementuje `cloudflare-worker/src/engine/config.ts` (LOYALTY_TIERS,
// BRAND_LIMITS, CATEGORY_LIMITS, BRAND_SALE_DISCOUNTS, PRODUCT_LIMITS)
// nad JSON soubory z okfish klonu. Reimplementace, ne import, ze dvou
// důvodů:
//   1. okfish `config.ts` je Worker modul s `import ... from '*.json'`
//      (TS resolveJsonModule + relativní cesty do `src/`); tahat ho sem
//      přes tsx z cizího repa je křehčí než 40 řádků, které dělají totéž.
//   2. Shadow nesmí importovat NIC z okfish writer vrstvy. Čím užší kontakt
//      s cizím repem, tím menší šance, že se writer přitáhne tranzitivně.
//
// Logika (merge pořadí, clearance datové okno, Stage 1 konfliktní check) je
// zkopírovaná 1:1 -- jakákoli odchylka by se v porovnání projevila jako
// falešný cenový rozdíl. Konfliktní check je tu záměrně zachovaný: kdyby
// okfish měl konfliktní config, shadow to musí ohlásit stejně hlasitě.

import * as fs from 'fs';
import * as path from 'path';

export const OKFISH_ROOT = process.env.OKFISH_CLONE
    ?? '/Users/lucky/.claude/jobs/99e48aa8/tmp/okfish-live';

const POLICY_DIR = path.join(OKFISH_ROOT, 'src/config/policies');

function readJson<T>(name: string): T {
    const p = path.join(POLICY_DIR, name);
    try {
        return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
    } catch (err) {
        throw new Error(`okfishConfig: nelze načíst ${p}: ${err instanceof Error ? err.message : String(err)}`);
    }
}

interface PolicyV1 {
    version: string;
    loyaltyTiers: Record<string, number>;
    brandSaleDiscounts?: Record<string, number>;
    brandLimits?: Record<string, number>;
    categoryLimits?: Record<string, number>;
}

type ClearanceEntry = number | { pct: number; validFrom?: string; validTo?: string };

export interface OkfishConfig {
    policyPath: string;
    /** ratio 0.04 = 4 % -- tvar, který čte root engine */
    loyaltyTiersRatio: Record<string, number>;
    /** procenta 4 = 4 % -- tvar, který čte worker mini-engine */
    loyaltyTiersPct: Record<string, number>;
    tierNames: string[];
    brandLimits: Record<string, number>;
    categoryLimits: Record<string, number>;
    brandSaleDiscounts: Record<string, number>;
    /** složené PRODUCT_LIMITS jako ratio (0.22 = 22 %) */
    productLimits: Record<string, number>;
    /** kód -> ze kterého JSON limit pochází (pro klasifikaci rozdílů) */
    productLimitSource: Record<string, 'zero-discount' | 'clearance' | 'override'>;
    /** clearance kódy, jejichž okno je PRÁVĚ TEĎ neaktivní */
    clearanceInactiveCodes: string[];
}

function resolveClearancePct(entry: ClearanceEntry, now: Date): number | undefined {
    if (typeof entry === 'number') return entry;
    if (entry.validFrom && now < new Date(entry.validFrom)) return undefined;
    if (entry.validTo && now > new Date(entry.validTo + 'T23:59:59')) return undefined;
    return entry.pct;
}

function assertNoCrossFileConflicts(sources: Record<string, string[]>): void {
    const entries = Object.entries(sources);
    for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
            const [nameA, codesA] = entries[i]!;
            const [nameB, codesB] = entries[j]!;
            const setB = new Set(codesB);
            const conflicts = codesA.filter((c) => setB.has(c));
            if (conflicts.length > 0) {
                throw new Error(
                    `[NEXUS_SHADOW] Product code(s) ${conflicts.join(', ')} appear in BOTH ${nameA} and ${nameB}. ` +
                    `Stejná Stage 1 validace jako okfish config.ts -- config je nejednoznačný.`
                );
            }
        }
    }
}

export function loadOkfishConfig(now: Date = new Date()): OkfishConfig {
    const policy = readJson<PolicyV1>('policy-v1.json');
    const zero = readJson<string[]>('zero-discount-products.json');
    const clearance = readJson<Record<string, ClearanceEntry>>('clearance-sale-products.json');
    const overrides = readJson<Record<string, number>>('product-max-discount-overrides.json');

    assertNoCrossFileConflicts({
        'zero-discount-products.json': zero,
        'clearance-sale-products.json': Object.keys(clearance),
        'product-max-discount-overrides.json': Object.keys(overrides),
    });

    const activeClearance: Array<[string, number]> = [];
    const clearanceInactiveCodes: string[] = [];
    for (const [code, entry] of Object.entries(clearance)) {
        const pct = resolveClearancePct(entry, now);
        if (pct === undefined) clearanceInactiveCodes.push(code);
        else activeClearance.push([code, pct]);
    }

    const productLimits: Record<string, number> = {};
    const productLimitSource: OkfishConfig['productLimitSource'] = {};
    for (const code of zero) { productLimits[code] = 0; productLimitSource[code] = 'zero-discount'; }
    for (const [code, pct] of activeClearance) { productLimits[code] = pct / 100; productLimitSource[code] = 'clearance'; }
    for (const [code, pct] of Object.entries(overrides)) { productLimits[code] = pct / 100; productLimitSource[code] = 'override'; }

    // Stejná konverze ratio -> pct jako okfish config.ts (Math.round(r*1e8)/1e6).
    const loyaltyTiersPct = Object.fromEntries(
        Object.entries(policy.loyaltyTiers).map(([t, r]) => [t, Math.round(r * 1e8) / 1e6])
    );

    return {
        policyPath: path.join(POLICY_DIR, 'policy-v1.json'),
        loyaltyTiersRatio: policy.loyaltyTiers,
        loyaltyTiersPct,
        tierNames: Object.keys(policy.loyaltyTiers),
        brandLimits: policy.brandLimits ?? {},
        categoryLimits: policy.categoryLimits ?? {},
        brandSaleDiscounts: policy.brandSaleDiscounts ?? {},
        productLimits,
        productLimitSource,
        clearanceInactiveCodes,
    };
}
