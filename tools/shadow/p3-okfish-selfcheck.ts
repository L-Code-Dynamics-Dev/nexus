// P3 (priorita 0) -- shoduje se okfish sám se sebou?
//
// Porovnává DVA nezávislé okfish cenové enginy nad IDENTICKÝM vstupem:
//   A) root engine  -- src/core/PricingEngine.ts (Decimal.js), volaný přes
//                      cloudflare-worker/src/shoptet-api/pricing-bridge.ts
//                      -> calculateProductsPricing(). Batch cesta (ceníky).
//   B) worker engine -- cloudflare-worker/src/engine/pricing.ts
//                      -> calculateAllTierPrices(). Real-time badge.
//
// Oba enginy se sem IMPORTUJÍ Z KLONU, nekopírují se a needitují.
//
// ZERO PRODUCTION WRITES: skript čte veřejný feed (GET), čte JSON konfiguraci
// z klonu a píše výhradně do vlastního výstupního JSON v ~/nexus. Žádný
// token, žádné Shoptet API, žádný zápis do okfish repa ani do jeho
// stavových souborů.
//
// Spuštění (z okfish klonu jako cwd -- pricing-bridge staví cestu ke config
// souboru přes process.cwd()):
//   cd <okfish-clone> && NODE_PATH=~/nexus/node_modules \
//     npx tsx ~/nexus/tools/shadow/p3-okfish-selfcheck.ts --out <path.json>
// Nebo pohodlněji: npx tsx ~/nexus/tools/shadow/run.ts p3

import * as fs from 'fs';
import * as path from 'path';
import { loadFeed, parseArgs, type CsvRow } from './feed.js';
import { loadOkfishConfig } from './okfishConfig.js';
import { loadOkfishEngines, assertOkfishCwd, assertNoShoptetToken } from './okfishEngines.js';
import { normalizeRow, toRootEngineProduct, type NormalizedProduct } from './adapters.js';

export type P3Class =
    | 'ROUNDING_CENT'
    | 'ALLOW_LOYALTY_DIVERGENCE'
    | 'INVALID_BASEPRICE_FALLBACK'
    | 'MISSING_TIER'
    | 'BRAND_SALE_ROUNDING'
    | 'UNCLASSIFIED';

export interface P3Diff {
    code: string;
    tier: string;
    basePrice: number | undefined;
    actionPrice: number | undefined;
    manufacturer: string | undefined;
    productLimit: number | undefined;
    rootPrice: number | null;
    workerPrice: number | null;
    deltaCents: number | null;
    cls: P3Class;
}

/**
 * Klasifikace rozdílu. Pořadí je záměrné -- od nejjistější příčiny k nejméně
 * jisté; UNCLASSIFIED znamená "nerozumím vlastnímu enginu" a je to nejdůležitější
 * číslo v celém běhu.
 */
function classify(p: NormalizedProduct, rootPrice: number | null, workerPrice: number | null): P3Class {
    if (rootPrice === null || workerPrice === null) {
        if (p.basePrice === undefined || p.basePrice <= 0) return 'INVALID_BASEPRICE_FALLBACK';
        return 'MISSING_TIER';
    }
    // Worker fallback při neplatné basePrice: vrací basePrice pro všechny tiery.
    if (p.basePrice === undefined || p.basePrice <= 0) return 'INVALID_BASEPRICE_FALLBACK';

    // pricing-bridge posílá allowLoyaltyDiscount=true natvrdo, worker čte feed.
    if (!p.allowLoyaltyDiscount) return 'ALLOW_LOYALTY_DIVERGENCE';

    const delta = Math.abs(rootPrice - workerPrice);
    if (delta <= 0.0101) {
        // brandSale syntéza: root použije Math.round(base*(1-d)*100)/100,
        // worker applyPercent (integer cents). Na hraně haléře se rozejdou.
        return p.brandSaleApplies ? 'BRAND_SALE_ROUNDING' : 'ROUNDING_CENT';
    }
    return 'UNCLASSIFIED';
}

export interface P3Result {
    compared: number;
    products: number;
    matched: number;
    diffs: P3Diff[];
    breakdown: Record<string, number>;
    productsWithAnyDiff: number;
    tiers: string[];
    durationMs: number;
    feedSource: string;
    feedRows: number;
    skippedNoCode: number;
}

export async function runP3(opts: {
    feedFile?: string;
    limit?: number;
    cachePath?: string;
    allowNetwork?: boolean;
    fallbackPath?: string;
}): Promise<P3Result> {
    const started = Date.now();
    assertNoShoptetToken();
    assertOkfishCwd();
    const { calculateAllTierPrices, calculateProductsPricing } = await loadOkfishEngines();
    const cfg = loadOkfishConfig();
    const feed = await loadFeed({
        filePath: opts.feedFile,
        cachePath: opts.cachePath,
        allowNetwork: opts.allowNetwork,
        fallbackPath: opts.fallbackPath,
    });

    let rows: CsvRow[] = feed.rows.filter((r) => (r['code'] ?? '').trim() !== '');
    const skippedNoCode = feed.rows.length - rows.length;
    if (opts.limit !== undefined) rows = rows.slice(0, opts.limit);

    const pricelists = cfg.tierNames.map((name, i) => ({ name, id: i + 1 }));
    const diffs: P3Diff[] = [];
    const breakdown: Record<string, number> = {};
    let compared = 0;
    let matched = 0;
    const productsWithDiff = new Set<string>();

    // Root engine se volá po dávkách: calculateProductsPricing staví engine
    // znovu při každém volání (EngineBuilder.fromConfig -> fs.readFileSync),
    // takže per-produkt volání by načetlo config 17 000×. Dávka to amortizuje.
    const BATCH = 500;
    for (let i = 0; i < rows.length; i += BATCH) {
        const chunk = rows.slice(i, i + BATCH);
        const normalized = chunk.map((r) => normalizeRow(r, cfg));
        const rootOut = calculateProductsPricing(normalized.map(toRootEngineProduct), pricelists);
        const rootByCode = new Map(rootOut.results.map((r) => [r.code, r]));

        for (const p of normalized) {
            const workerAll = calculateAllTierPrices(p.row, cfg.productLimits);
            const rootRes = rootByCode.get(p.code);
            for (const tier of cfg.tierNames) {
                compared++;
                const rootStr = rootRes?.prices[tier];
                const rootPrice = rootStr !== undefined ? Number(rootStr) : null;
                const workerPrice = workerAll[tier]?.price ?? null;

                // Normalizace formátů: root vrací toFixed(4), worker číslo na 2 dp.
                // Porovnávám na 2 desetinných místech, jinak by 100 % bylo false-positive.
                const rootR = rootPrice === null ? null : Math.round(rootPrice * 100) / 100;
                const workR = workerPrice === null ? null : Math.round(workerPrice * 100) / 100;

                if (rootR !== null && workR !== null && rootR === workR) { matched++; continue; }

                const cls = classify(p, rootR, workR);
                breakdown[cls] = (breakdown[cls] ?? 0) + 1;
                productsWithDiff.add(p.code);
                diffs.push({
                    code: p.code,
                    tier,
                    basePrice: p.basePrice,
                    actionPrice: p.rawActionPrice,
                    manufacturer: p.manufacturer,
                    productLimit: p.productLimit,
                    rootPrice: rootR,
                    workerPrice: workR,
                    deltaCents: rootR !== null && workR !== null ? Math.round((rootR - workR) * 100) : null,
                    cls,
                });
            }
        }
        if ((i / BATCH) % 5 === 0) {
            process.stderr.write(`[NEXUS_SHADOW] P3 ${Math.min(i + BATCH, rows.length)}/${rows.length} produktů...\n`);
        }
    }

    return {
        compared,
        products: rows.length,
        matched,
        diffs,
        breakdown,
        productsWithAnyDiff: productsWithDiff.size,
        tiers: cfg.tierNames,
        durationMs: Date.now() - started,
        feedSource: feed.source,
        feedRows: feed.rows.length,
        skippedNoCode,
    };
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const res = await runP3({
        feedFile: typeof args['feed'] === 'string' ? args['feed'] : undefined,
        limit: typeof args['limit'] === 'string' ? Number(args['limit']) : undefined,
        cachePath: typeof args['cache'] === 'string' ? args['cache'] : '/tmp/okfish_master_feed.csv',
        allowNetwork: args['offline'] !== true,
        fallbackPath: typeof args['fallback'] === 'string' ? args['fallback'] : undefined,
    });

    console.log(`\n=== P3: okfish root engine vs okfish worker engine ===`);
    console.log(`feed: ${res.feedSource} (${res.feedRows} řádků, ${res.skippedNoCode} bez kódu přeskočeno)`);
    console.log(`produktů: ${res.products}, porovnání: ${res.compared}, shoda: ${res.matched} (${(100 * res.matched / res.compared).toFixed(4)} %)`);
    console.log(`rozdílů: ${res.compared - res.matched}, dotčených produktů: ${res.productsWithAnyDiff}`);
    console.log(`doba: ${(res.durationMs / 1000).toFixed(1)} s`);
    console.log(`breakdown:`, res.breakdown);

    const out = typeof args['out'] === 'string' ? args['out'] : null;
    if (out) {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, JSON.stringify(res, null, 1), 'utf-8');
        console.log(`zapsáno: ${out}`);
    }
}

// Spustit jen jako CLI, ne při importu z testu.
if (process.argv[1] && process.argv[1].endsWith('p3-okfish-selfcheck.ts')) {
    main().catch((e) => { console.error('[NEXUS_SHADOW] P3 CHYBA:', e); process.exit(1); });
}
