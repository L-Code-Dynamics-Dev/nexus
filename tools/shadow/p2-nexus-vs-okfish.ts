// P2 -- NEXUS chain vs okfish root engine (batch cesta / ceníky).
//
// okfish strana: `calculateProductsPricing()` (pricing-bridge -> EngineBuilder
//   -> BasePrice/HighestDiscount/DiscountLimit/Rounding, Decimal.js),
//   importovaná z živého klonu.
// NEXUS strana: `createNexusPricingCalculator(configProvider, tenant)`.
//
// CÍLEM NENÍ SHODA -- cílem je KVANTIFIKOVAT, kolika produktů se týkají
// známé chybějící kusy logiky (§3.1 návrhu) a kolik rozdílů zůstane
// NEVYSVĚTLENÝCH. Nevysvětlené rozdíly jsou to jediné, co může být skutečný
// bug, a proto se počítají zvlášť.
//
// TŘI REŽIMY, všechny se počítají v jednom běhu:
//   naive        -- NEXUS dostane přesně to, co dnes umí přijmout: syrovou
//                   actionPrice z feedu, žádný productMaxDiscount. Měří plný
//                   dopad všech čtyř chybějících kusů najednou.
//   with-limits  -- NEXUS navíc dostane složené PRODUCT_LIMITS. Rozdíl proti
//                   'naive' izoluje, kolik dělá samotné skládání limitů.
//   adapted      -- KONTROLA POCTIVOSTI: NEXUS dostane navíc no-op guard
//                   a brandSale syntézu. Když tenhle režim vyjde na 100 %,
//                   je dokázáno, že klasifikace v prvních dvou režimech nic
//                   nezametla pod koberec (viz adapters.ts komentář).
//
// ZERO PRODUCTION WRITES: stejná pravidla jako P3 -- GET na veřejný feed,
// čtení JSON z klonu, zápis jen do vlastního výstupu.

import * as fs from 'fs';
import * as path from 'path';
import { createNexusPricingCalculator } from '../../domains/pricing/createNexusPricingCalculator.js';
import { InMemoryPricingConfigurationProvider } from '../../domains/pricing/PricingConfigurationProvider.js';
import type { TenantContext } from '../../core/tenant/types.js';
import { loadFeed, parseArgs, type CsvRow } from './feed.js';
import { loadOkfishConfig } from './okfishConfig.js';
import { loadOkfishEngines, assertOkfishCwd, assertNoShoptetToken } from './okfishEngines.js';
import { normalizeRow, toRootEngineProduct, toNexusInput, type NormalizedProduct, type NexusInputMode } from './adapters.js';

/**
 * Tenant pro shadow běh. NENÍ to placeholder ve smyslu `assertTenantContext`
 * blacklistu -- je to reálný identifikátor okfish tenanta v NEXUS modelu,
 * jediný, jehož ceny se tu počítají.
 */
const OKFISH_TENANT: TenantContext = { tenantId: 'okfish_sk', platform: 'shoptet' };

export type P2Class =
    | 'BRAND_SALE_MISSING'
    /**
     * brandSale se liší o nejvýš 1 haléř: root/bridge počítá
     * `Math.round(base*(1-d)*100)/100` nad floatem, NEXUS přes Decimal.
     * `2.30*0.85` = `1.9549999999999998` -> root 1.95, NEXUS správných 1.96.
     * NEXUS se tím shoduje s okfish WORKER enginem (integer-cents).
     * Očekávané, ne nález.
     */
    | 'BRAND_SALE_ROUNDING'
    | 'NOOP_ACTION'
    | 'LIMIT_SOURCE'
    | 'CLEARANCE_WINDOW'
    | 'ROUNDING_CENT'
    | 'TIER_UNKNOWN'
    | 'VALIDATION_DIVERGENCE'
    | 'UNCLASSIFIED';

export interface P2Diff {
    code: string;
    tier: string;
    basePrice: number | undefined;
    actionPrice: number | undefined;
    manufacturer: string | undefined;
    productLimit: number | undefined;
    productLimitSource: string | undefined;
    okfishPrice: number | null;
    nexusPrice: number | null;
    deltaCents: number | null;
    cls: P2Class;
}

/**
 * Klasifikace PŘÍČINY rozdílu -- pořadí odpovídá tomu, jak silný je důkaz.
 *
 * Poctivá poznámka k metodě: klasifikace je odvozena z VLASTNOSTÍ PRODUKTU
 * (má brandSale? má no-op actionPrice? má product limit?), ne z důkazu, že
 * právě ta vlastnost rozdíl způsobila. U produktu, který má víc příznaků
 * najednou, dostane rozdíl ten první v pořadí. Proto se v reportu uvádí i
 * kolik produktů má víc příznaků současně.
 */
function classify(
    p: NormalizedProduct,
    okfish: number | null,
    nexus: number | null,
    mode: NexusInputMode,
    clearanceInactive: Set<string>
): P2Class {
    if (okfish === null || nexus === null) return 'VALIDATION_DIVERGENCE';

    // V 'adapted' režimu je chybějící logika DOPLNĚNÁ, takže příznaky
    // produktu už rozdíl vysvětlit nemohou -- cokoli tu zbude je buď
    // haléřové zaokrouhlení, nebo skutečně neznámý rozdíl. Přiřadit tu
    // BRAND_SALE_MISSING by byla lež, která by zamaskovala reziduum.
    if (mode === 'adapted') {
        return Math.abs(okfish - nexus) <= 0.0101 ? 'ROUNDING_CENT' : 'UNCLASSIFIED';
    }

    const noopAction = p.rawActionPrice !== undefined && p.basePrice !== undefined
        && p.rawActionPrice >= p.basePrice;

    // 1) No-op actionPrice: NEXUS ji vezme jako platnou sale, okfish ji zahodí.
    //    Nejsilnější důkaz -- je to čistě vlastnost vstupu, nezávislá na tieru.
    if (noopAction) return 'NOOP_ACTION';

    // 2) brandSale.
    //
    // Od 2026-09-07 je `BrandSaleDiscountRule` součástí kanonického chainu
    // a konfiguraci dostává přes port, takže "NEXUS neumí brandSale" už
    // NENÍ platná příčina. Co zbývá, je HALÉŘOVÁ ODCHYLKA V ZAOKROUHLENÍ:
    //
    //   root/bridge: Math.round(base * (1-d) * 100) / 100  -- nad floatem
    //   NEXUS:       Decimal, přes celé haléře
    //
    // `2.30 * 0.85` je ve floatu `1.9549999999999998`, takže root dá 1.95,
    // NEXUS správných 1.96. Ověřeno v P3 jako `BRAND_SALE_ROUNDING` --
    // a NEXUS se tam shoduje s okfish WORKER enginem, který to počítá
    // přes integer-cents stejně. Rozchází se tedy jen s bridgem, a to
    // v jeho neprospěch.
    //
    // Odchylka je maximálně 1 haléř a projeví se jen na tierech, kde
    // brandSale vyhrává nad loyalty (ZR4-ZR14).
    if (p.brandSaleApplies) {
        return Math.abs(nexus - okfish) <= 0.0101
            ? 'BRAND_SALE_ROUNDING'
            : 'BRAND_SALE_MISSING';
    }

    // 3) Skládání PRODUCT_LIMITS: v 'naive' NEXUS limit vůbec nedostal.
    if (mode === 'naive' && p.productLimit !== undefined) {
        return clearanceInactive.has(p.code) ? 'CLEARANCE_WINDOW' : 'LIMIT_SOURCE';
    }
    // V 'with-limits' zbývá jen clearance okno, které limit vypnulo úplně.
    if (clearanceInactive.has(p.code)) return 'CLEARANCE_WINDOW';

    if (Math.abs(okfish - nexus) <= 0.0101) return 'ROUNDING_CENT';

    return 'UNCLASSIFIED';
}

export interface P2ModeResult {
    compared: number;
    matched: number;
    diffs: P2Diff[];
    breakdown: Record<string, number>;
    productsWithAnyDiff: number;
}

export interface P2Result {
    products: number;
    tiers: string[];
    durationMs: number;
    feedSource: string;
    feedRows: number;
    naive: P2ModeResult;
    withLimits: P2ModeResult;
    adapted: P2ModeResult;
    /** produkty, u kterých platí víc klasifikačních příznaků současně */
    multiSignalProducts: number;
    okfishFailures: number;
    nexusThrows: number;
}

function emptyMode(): P2ModeResult & { codes: Set<string> } {
    return { compared: 0, matched: 0, diffs: [], breakdown: {}, productsWithAnyDiff: 0, codes: new Set<string>() };
}

export async function runP2(opts: {
    feedFile?: string;
    limit?: number;
    cachePath?: string;
    allowNetwork?: boolean;
    fallbackPath?: string;
    maxDiffsPerMode?: number;
}): Promise<P2Result> {
    const started = Date.now();
    assertNoShoptetToken();
    assertOkfishCwd();
    const { calculateProductsPricing } = await loadOkfishEngines();
    const cfg = loadOkfishConfig();
    const maxDiffs = opts.maxDiffsPerMode ?? 20000;

    // NEXUS kalkulátor -- konfigurace ze STEJNÉHO policy-v1.json jako okfish,
    // podaná přes port (žádný fs uvnitř domény).
    const provider = new InMemoryPricingConfigurationProvider({
        loyaltyTiers: cfg.loyaltyTiersRatio,
        brandLimits: cfg.brandLimits,
        categoryLimits: cfg.categoryLimits,
        // Zapojeno 2026-09-07 (rozhodnutí Lucky): BrandSaleDiscountRule je
        // teď součástí kanonického chainu, takže konfiguraci dostává PŘES
        // PORT, ne obcházením v `adapted` režimu. Do té doby si brandSale
        // syntézu dělal harness sám v `toNexusInput` -- proto `naive`
        // i `with-limits` hlásily BRAND_SALE_MISSING, i když Rule existovala.
        brandSaleDiscounts: cfg.brandSaleDiscounts,
    });
    const nexusCalc = createNexusPricingCalculator(provider, OKFISH_TENANT);

    const feed = await loadFeed({
        filePath: opts.feedFile,
        cachePath: opts.cachePath,
        allowNetwork: opts.allowNetwork,
        fallbackPath: opts.fallbackPath,
    });

    let rows: CsvRow[] = feed.rows.filter((r) => (r['code'] ?? '').trim() !== '');
    if (opts.limit !== undefined) rows = rows.slice(0, opts.limit);

    const pricelists = cfg.tierNames.map((name, i) => ({ name, id: i + 1 }));
    const clearanceInactive = new Set(cfg.clearanceInactiveCodes);
    const naive = emptyMode();
    const withLimits = emptyMode();
    const adapted = emptyMode();
    let multiSignalProducts = 0;
    let okfishFailures = 0;
    let nexusThrows = 0;

    const BATCH = 500;
    for (let i = 0; i < rows.length; i += BATCH) {
        const chunk = rows.slice(i, i + BATCH);
        const normalized = chunk.map((r) => normalizeRow(r, cfg));
        const rootOut = calculateProductsPricing(normalized.map(toRootEngineProduct), pricelists);
        okfishFailures += rootOut.failures.length;
        const rootByCode = new Map(rootOut.results.map((r) => [r.code, r]));

        for (const p of normalized) {
            const signals = [
                p.rawActionPrice !== undefined && p.basePrice !== undefined && p.rawActionPrice >= p.basePrice,
                p.brandSaleApplies,
                p.productLimit !== undefined,
            ].filter(Boolean).length;
            if (signals > 1) multiSignalProducts++;

            const rootRes = rootByCode.get(p.code);

            for (const tier of cfg.tierNames) {
                const rootStr = rootRes?.prices[tier];
                const okfishPrice = rootStr !== undefined ? Math.round(Number(rootStr) * 100) / 100 : null;

                for (const [mode, acc] of [
                    ['naive', naive], ['with-limits', withLimits], ['adapted', adapted],
                ] as const) {
                    acc.compared++;
                    let nexusPrice: number | null = null;
                    try {
                        const res = nexusCalc(toNexusInput(p, tier, mode, cfg.brandSaleDiscounts));
                        nexusPrice = res.rejected ? null : Math.round(res.finalPrice.toNumber() * 100) / 100;
                    } catch {
                        nexusThrows++;
                        nexusPrice = null;
                    }

                    if (okfishPrice !== null && nexusPrice !== null && okfishPrice === nexusPrice) {
                        acc.matched++;
                        continue;
                    }

                    const cls = classify(p, okfishPrice, nexusPrice, mode, clearanceInactive);
                    acc.breakdown[cls] = (acc.breakdown[cls] ?? 0) + 1;
                    acc.codes.add(p.code);
                    if (acc.diffs.length < maxDiffs) {
                        acc.diffs.push({
                            code: p.code,
                            tier,
                            basePrice: p.basePrice,
                            actionPrice: p.rawActionPrice,
                            manufacturer: p.manufacturer,
                            productLimit: p.productLimit,
                            productLimitSource: p.productLimitSource,
                            okfishPrice,
                            nexusPrice,
                            deltaCents: okfishPrice !== null && nexusPrice !== null
                                ? Math.round((okfishPrice - nexusPrice) * 100) : null,
                            cls,
                        });
                    }
                }
            }
        }
        if ((i / BATCH) % 5 === 0) {
            process.stderr.write(`[NEXUS_SHADOW] P2 ${Math.min(i + BATCH, rows.length)}/${rows.length} produktů...\n`);
        }
    }

    naive.productsWithAnyDiff = naive.codes.size;
    withLimits.productsWithAnyDiff = withLimits.codes.size;
    adapted.productsWithAnyDiff = adapted.codes.size;

    const strip = (m: typeof naive): P2ModeResult => ({
        compared: m.compared, matched: m.matched, diffs: m.diffs,
        breakdown: m.breakdown, productsWithAnyDiff: m.productsWithAnyDiff,
    });

    return {
        products: rows.length,
        tiers: cfg.tierNames,
        durationMs: Date.now() - started,
        feedSource: feed.source,
        feedRows: feed.rows.length,
        naive: strip(naive),
        withLimits: strip(withLimits),
        adapted: strip(adapted),
        multiSignalProducts,
        okfishFailures,
        nexusThrows,
    };
}

function printMode(label: string, m: P2ModeResult): void {
    const pct = m.compared === 0 ? 0 : (100 * m.matched / m.compared);
    console.log(`\n--- ${label} ---`);
    console.log(`porovnání: ${m.compared}, shoda: ${m.matched} (${pct.toFixed(4)} %), rozdílů: ${m.compared - m.matched}`);
    console.log(`dotčených produktů: ${m.productsWithAnyDiff}`);
    console.log('breakdown:', m.breakdown);
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const res = await runP2({
        feedFile: typeof args['feed'] === 'string' ? args['feed'] : undefined,
        limit: typeof args['limit'] === 'string' ? Number(args['limit']) : undefined,
        cachePath: typeof args['cache'] === 'string' ? args['cache'] : '/tmp/okfish_master_feed.csv',
        allowNetwork: args['offline'] !== true,
        fallbackPath: typeof args['fallback'] === 'string' ? args['fallback'] : undefined,
    });

    console.log(`\n=== P2: NEXUS chain vs okfish root engine ===`);
    console.log(`feed: ${res.feedSource} (${res.feedRows} řádků)`);
    console.log(`produktů: ${res.products}, tierů: ${res.tiers.length}, doba: ${(res.durationMs / 1000).toFixed(1)} s`);
    console.log(`okfish failures: ${res.okfishFailures}, NEXUS výjimek: ${res.nexusThrows}, produktů s víc příznaky: ${res.multiSignalProducts}`);
    printMode('naive (NEXUS bez PRODUCT_LIMITS)', res.naive);
    printMode('with-limits (NEXUS dostal složené PRODUCT_LIMITS)', res.withLimits);
    printMode('adapted (kontrola poctivosti -- musí být 100 %)', res.adapted);
    if (res.adapted.matched !== res.adapted.compared) {
        console.log('\n[NEXUS_SHADOW] POZOR: adapted režim NEDAL 100 %. Zbývající rozdíly ' +
            'NEJSOU vysvětlené chybějící logikou z §3.1 a patří vyšetřit jako možné bugy.');
    }

    const out = typeof args['out'] === 'string' ? args['out'] : null;
    if (out) {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, JSON.stringify(res, null, 1), 'utf-8');
        console.log(`\nzapsáno: ${out}`);
    }
}

if (process.argv[1] && process.argv[1].endsWith('p2-nexus-vs-okfish.ts')) {
    main().catch((e) => { console.error('[NEXUS_SHADOW] P2 CHYBA:', e); process.exit(1); });
}
