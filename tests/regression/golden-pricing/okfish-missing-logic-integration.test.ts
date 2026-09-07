// Integrační parita: čtyři DOPLNĚNÁ pravidla (NoOpActionPrice ->
// BrandSaleDiscount -> ClearanceWindow -> ProductLimitComposition) společně
// s už existujícími (HighestDiscount, DiscountLimit, Rounding) musí dát
// stejný výsledek jako okfish `calculateAllTierPrices`.
//
// POZOR NA SCOPE (Non-Interference): tenhle soubor NEZAPOJUJE nová pravidla
// do `createNexusPricingCalculator`. Skládá je ručně, jen pro důkaz, že
// dohromady sedí. Produkční zapojení je rozhodnutí Lucky.
//
// ORACLE: `okfishCalculateAllTierPrices` níže je 1:1 replika
// cloudflare-worker/src/engine/pricing.ts:107-185 (živý klon, HEAD 3a910e2),
// včetně `applyPercent`, `resolveActiveLimit` a `resolveAllowLoyaltyDiscount`.
//
// REÁLNÁ DATA:
//   fixtures/okfish-policy/okfish-products-import-snapshot.csv
//     = okfish products_import.csv, 100 skutečných produktů se skutečnými
//       vypočtenými cenami pro všech 10 ZR ceníků, tak jak byly zapsány
//       do Shoptetu.
//
// DŮLEŽITÉ OMEZENÍ TOHO SNAPSHOTU (ověřeno, nehádáno):
//   Snapshot vznikl PŘED zavedením PRODUCT_LIMITS souborů. Důkazy:
//     - kód `112824` je dnes v zero-discount-products.json (strop 0 %),
//       ale ve snapshotu má na ZR25 slevu ~24,9 %.
//     - kód `3963P-S` je dnes v clearance-sale-products.json (20 % v okně
//       31.8.-4.9.), ale ve snapshotu má -10 % (brand limit).
//   Snapshot tedy VALIDUJE: základní loyalty matematiku, no-op guard
//   a chování akční ceny. NEVALIDUJE: PRODUCT_LIMITS ani clearance okna --
//   ty jsou ověřené jen proti okfish zdrojovému kódu (viz ostatní testy).
//   Snapshot také nemá sloupec `manufacturer`, takže brandSaleDiscounts
//   a brandLimits z něj nelze ověřit vůbec; brandové limity jsou proto
//   ve srovnání níže dodané jako per-kód `productLimits` odvozené ze
//   snapshotu samotného (viz `inferredBrandCapRatio`).

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Decimal from 'decimal.js';
import Papa from 'papaparse';
import { NoOpActionPriceRule } from '../../../domains/pricing/NoOpActionPriceRule.js';
import { BrandSaleDiscountRule } from '../../../domains/pricing/BrandSaleDiscountRule.js';
import { ClearanceWindowRule, type ClearanceEntry } from '../../../domains/pricing/ClearanceWindowRule.js';
import { ProductLimitCompositionRule } from '../../../domains/pricing/ProductLimitCompositionRule.js';
import { HighestDiscountRule } from '../../../domains/pricing/HighestDiscountRule.js';
import { DiscountLimitRule } from '../../../domains/pricing/DiscountLimitRule.js';
import { RoundingRule } from '../../../domains/pricing/RoundingRule.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POLICY_DIR = path.join(__dirname, 'fixtures/okfish-policy');
const readJson = (f: string) => JSON.parse(fs.readFileSync(path.join(POLICY_DIR, f), 'utf-8'));

const policy = readJson('policy-v1.json') as {
    loyaltyTiers: Record<string, number>;
    brandSaleDiscounts: Record<string, number>;
    brandLimits: Record<string, number>;
    categoryLimits: Record<string, number>;
};
const clearanceSaleProducts = readJson('clearance-sale-products.json') as Record<string, ClearanceEntry>;
const zeroDiscountProducts = readJson('zero-discount-products.json') as string[];
const productMaxDiscountOverrides = readJson('product-max-discount-overrides.json') as Record<string, number>;

// okfish config.ts:15-17 -- policy ukládá poměry, worker chce procenta.
const LOYALTY_TIERS_PCT: Record<string, number> = Object.fromEntries(
    Object.entries(policy.loyaltyTiers).map(([tier, ratio]) => [tier, Math.round(ratio * 1e8) / 1e6])
);
const TIER_NAMES = Object.keys(LOYALTY_TIERS_PCT);

const ctxBase = { tenantId: 'ten_okfish', ruleVersion: '1' };
const noOpRule = new NoOpActionPriceRule({ ...ctxBase, ruleId: 'noop-action-price-v1' });
const brandSaleRule = new BrandSaleDiscountRule({ ...ctxBase, ruleId: 'brand-sale-v1' });
const clearanceRule = new ClearanceWindowRule({ ...ctxBase, ruleId: 'clearance-window-v1' });
const limitCompositionRule = new ProductLimitCompositionRule({ ...ctxBase, ruleId: 'product-limit-composition-v1' });
const highestDiscountRule = new HighestDiscountRule({ ...ctxBase, ruleId: 'highest-discount-v1' });
const discountLimitRule = new DiscountLimitRule({ ...ctxBase, ruleId: 'discount-limit-v1' });
const roundingRule = new RoundingRule({ ...ctxBase, ruleId: 'rounding-v1' });

function decimalMap(m: Record<string, number>): Record<string, Decimal> {
    return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, new Decimal(v)]));
}
const LOYALTY_TIERS_RATIO = decimalMap(policy.loyaltyTiers);
const BRAND_SALE_DISCOUNTS = decimalMap(policy.brandSaleDiscounts);
const BRAND_LIMITS = decimalMap(policy.brandLimits);
const CATEGORY_LIMITS = decimalMap(policy.categoryLimits);

// ------------------------------------------------------- okfish oracle 1:1

/** okfish engine/pricing.ts:38-43. */
function okfishParsePrice(val: string | undefined): number | undefined {
    if (!val || val.trim() === '') return undefined;
    const normalized = val.replace(',', '.').replace(/\s/g, '');
    const n = parseFloat(normalized);
    return Number.isNaN(n) ? undefined : n;
}
/** okfish engine/pricing.ts:46-48. */
function round2(n: number): number {
    return Math.round(n * 100) / 100;
}
/** okfish engine/pricing.ts:57-60. */
function applyPercent(basePrice: number, pct: number): number {
    const baseCents = Math.round(basePrice * 100);
    return Math.round((baseCents * (100 - pct)) / 100) / 100;
}

interface OkfishRow {
    code: string;
    price: string;
    actionPrice?: string;
    manufacturer?: string;
    categoryText?: string;
}

/** okfish engine/pricing.ts:71-91. */
function resolveActiveLimit(row: OkfishRow, productLimits: Record<string, number>): number | undefined {
    if (row.code && productLimits[row.code] !== undefined) return productLimits[row.code];
    if (row.manufacturer && policy.brandLimits[row.manufacturer] !== undefined) return policy.brandLimits[row.manufacturer];
    if (row.categoryText && policy.categoryLimits[row.categoryText] !== undefined) return policy.categoryLimits[row.categoryText];
    return undefined;
}

/** okfish engine/pricing.ts:107-185, 1:1 (allowLoyaltyDiscount vždy true — sloupec ve feedu není). */
function okfishCalculateAllTierPrices(
    row: OkfishRow,
    productLimits: Record<string, number>
): Record<string, { price: number; usedActionPrice: boolean }> {
    const basePrice = okfishParsePrice(row.price);
    const result: Record<string, { price: number; usedActionPrice: boolean }> = {};

    if (!basePrice || basePrice <= 0) {
        const fallback = okfishParsePrice(row.price) ?? 0;
        for (const tier of TIER_NAMES) result[tier] = { price: round2(fallback), usedActionPrice: false };
        return result;
    }

    let actionPrice = okfishParsePrice(row.actionPrice);
    if (actionPrice !== undefined && actionPrice >= basePrice) actionPrice = undefined;

    if (actionPrice === undefined) {
        const saleDiscount = row.manufacturer ? policy.brandSaleDiscounts[row.manufacturer] : undefined;
        if (saleDiscount !== undefined) actionPrice = applyPercent(basePrice, saleDiscount * 100);
    }

    const activeLimit = resolveActiveLimit(row, productLimits);
    const minAllowedPrice = activeLimit !== undefined ? applyPercent(basePrice, activeLimit * 100) : 0;

    for (const tier of TIER_NAMES) {
        const discountPct = LOYALTY_TIERS_PCT[tier] ?? 0;
        const loyaltyPrice = applyPercent(basePrice, discountPct);

        let bestPrice = basePrice;
        let usedAction = false;
        if (minAllowedPrice > 0 && actionPrice !== undefined) {
            bestPrice = actionPrice;
            usedAction = true;
        } else if (actionPrice !== undefined && actionPrice < loyaltyPrice) {
            bestPrice = actionPrice;
            usedAction = true;
        } else {
            bestPrice = loyaltyPrice;
        }
        if (!usedAction && minAllowedPrice > 0 && bestPrice < minAllowedPrice) bestPrice = minAllowedPrice;

        result[tier] = { price: round2(bestPrice), usedActionPrice: usedAction };
    }
    return result;
}

// ------------------------------------------------------------ nexus chain

/**
 * Ruční složení chainu z DOPLNĚNÝCH + existujících Rules. Pořadí je závazné:
 *   1. NoOpActionPriceRule   -- zahodí mrtvou akční cenu
 *   2. BrandSaleDiscountRule -- doplní brandovou, jen pokud žádná není
 *   3. (mimo per-produkt smyčku) ClearanceWindow -> ProductLimitComposition
 *   4. HighestDiscountRule   -- akce vs loyalty
 *   5. DiscountLimitRule     -- strop / VAGNER pravidlo
 *   6. RoundingRule
 */
function nexusCalculateAllTierPrices(
    row: OkfishRow,
    productLimits: Record<string, Decimal>
): Record<string, string> {
    const basePriceNum = okfishParsePrice(row.price);
    const basePrice = new Decimal(basePriceNum ?? 0);

    const guarded = noOpRule.evaluate({
        basePrice,
        actionPrice:
            okfishParsePrice(row.actionPrice) !== undefined
                ? new Decimal(okfishParsePrice(row.actionPrice)!)
                : undefined,
    });
    const branded = brandSaleRule.evaluate({
        basePrice,
        effectiveSalePrice: guarded.effectiveSalePrice,
        manufacturer: row.manufacturer,
        brandSaleDiscounts: BRAND_SALE_DISCOUNTS,
    });
    const salePrice = branded.effectiveSalePrice;

    const out: Record<string, string> = {};
    for (const tier of TIER_NAMES) {
        const highest = highestDiscountRule.evaluate({
            basePrice,
            salePrice,
            customerTier: tier,
            allowLoyaltyDiscount: true,
            loyaltyTiers: LOYALTY_TIERS_RATIO,
        });
        let current = highest.applied && highest.price ? highest.price : basePrice;

        const limit = discountLimitRule.evaluate({
            basePrice,
            currentPrice: current,
            salePrice,
            productMaxDiscount: productLimits[row.code],
            manufacturer: row.manufacturer,
            category: row.categoryText,
            brandLimits: BRAND_LIMITS,
            categoryLimits: CATEGORY_LIMITS,
        });
        if (limit.applied && limit.price) current = limit.price;

        const rounded = roundingRule.evaluate({ currentPrice: current });
        out[tier] = (rounded.applied ? rounded.finalPrice : current).toFixed(2);
    }
    return out;
}

// -------------------------------------------------------- PRODUCT_LIMITS

const NOW_IN_WINDOW = '2026-09-02T12:00:00.000Z';
const NOW_AFTER_WINDOW = '2026-09-07T12:00:00.000Z';

function buildProductLimits(nowIso: string): Record<string, Decimal> {
    const activeClearancePct: Record<string, number> = {};
    for (const [code, entry] of Object.entries(clearanceSaleProducts)) {
        const r = clearanceRule.evaluate({ entry, now: nowIso });
        if (r.active && r.pct !== undefined) activeClearancePct[code] = r.pct;
    }
    const composed = limitCompositionRule.evaluate({
        zeroDiscountCodes: zeroDiscountProducts,
        clearanceCodes: Object.keys(clearanceSaleProducts),
        activeClearancePct,
        productMaxDiscountOverridePct: productMaxDiscountOverrides,
    });
    expect(composed.valid).toBe(true);
    return composed.limits;
}

function toNumberLimits(m: Record<string, Decimal>): Record<string, number> {
    return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.toNumber()]));
}

// --------------------------------------------------------------- fixtures

interface SnapshotRow {
    code: string;
    price: string;
    actionPrice?: string;
    expected: Record<string, string>;
}

const TIER_COLUMNS: Array<[string, string]> = [
    ['ZR4', 'pricelist:2:price'],
    ['ZR6', 'pricelist:5:price'],
    ['ZR8', 'pricelist:8:price'],
    ['ZR10', 'pricelist:11:price'],
    ['ZR12', 'pricelist:14:price'],
    ['ZR14', 'pricelist:17:price'],
    ['ZR16', 'pricelist:20:price'],
    ['ZR18', 'pricelist:23:price'],
    ['ZR20', 'pricelist:26:price'],
    ['ZR25', 'pricelist:29:price'],
];

function loadSnapshot(): SnapshotRow[] {
    // PapaParse, ne split(';') -- názvy produktů obsahují středníky uvnitř
    // uvozovek (např. "nástraha FANATIC Larva LUX 3,0; 7,5 cm"), takže
    // naivní rozdělení posune všechny sloupce napravo od názvu.
    const text = fs.readFileSync(
        path.join(POLICY_DIR, 'okfish-products-import-snapshot.csv'),
        'utf-8'
    );
    const parsed = Papa.parse<Record<string, string>>(text, {
        header: true,
        delimiter: ';',
        skipEmptyLines: true,
    });
    return parsed.data.map((r) => {
        const expected: Record<string, string> = {};
        for (const [tier, col] of TIER_COLUMNS) {
            const raw = r[col];
            if (raw === undefined || raw.trim() === '') continue;
            expected[tier] = new Decimal(raw.replace(',', '.')).toFixed(2);
        }
        return {
            code: r['code'] ?? '',
            price: r['price'] ?? '',
            actionPrice: r['actionPrice'] || undefined,
            expected,
        };
    });
}

const snapshot = loadSnapshot();

/**
 * Snapshot nemá sloupec `manufacturer`, takže brandLimits z něj nejde
 * napojit. Strop se proto ODVODÍ ze snapshotu samotného: pokud produkt nemá
 * akční cenu a jeho ZR25 cena je mělčí než plných 25 %, byl na něm aktivní
 * cap -- jeho hodnotu dopočítáme a předáme jako `productMaxDiscount`.
 * Ověřeno, že takto odvozené stropy jsou VÝHRADNĚ 0,10 (brandLimits ~10 %),
 * což odpovídá katalogu; test to i tvrdí.
 */
function inferredBrandCapRatio(row: SnapshotRow): number | undefined {
    const base = okfishParsePrice(row.price);
    if (!base) return undefined;
    let action = okfishParsePrice(row.actionPrice);
    if (action !== undefined && action >= base) action = undefined;
    if (action !== undefined) return undefined;
    const zr25 = row.expected['ZR25'];
    if (zr25 === undefined) return undefined;
    const full25 = applyPercent(base, 25);
    if (Math.abs(Number(zr25) - full25) < 0.005) return undefined;
    return Math.round((1 - Number(zr25) / base) * 100) / 100;
}

// ------------------------------------------------------------------ tests

describe('Snapshot fixture: 100 reálných produktů z okfish produkce', () => {
    it('načte se 100 řádků s deseti ZR cenami', () => {
        expect(snapshot.length).toBe(100);
        for (const r of snapshot) expect(Object.keys(r.expected).length).toBe(10);
    });

    it('odvozené stropy jsou výhradně 10 % (brandLimits), nic jiného v tom snapshotu není', () => {
        const caps = new Set(
            snapshot.map(inferredBrandCapRatio).filter((c): c is number => c !== undefined)
        );
        expect([...caps]).toEqual([0.1]);
    });

    it('OVĚŘENO: snapshot předchází PRODUCT_LIMITS souborům', () => {
        // Tvrzení z hlavičky, zafixované testem, ať se nezmění nepozorovaně.
        const zeroCoded = snapshot.find((r) => zeroDiscountProducts.includes(r.code));
        expect(zeroCoded?.code).toBe('112824');
        const base = okfishParsePrice(zeroCoded!.price)!;
        // Kdyby snapshot znal zero-discount, ZR25 by se rovnalo base.
        expect(Number(zeroCoded!.expected['ZR25'])).toBeLessThan(base * 0.8);

        const windowed = snapshot.find((r) => r.code === '3963P-S');
        expect(windowed).toBeDefined();
        expect(inferredBrandCapRatio(windowed!)).toBe(0.1); // ne 0.20 z clearance
    });
});

describe('Nexus doplněná pravidla vs REÁLNÝ okfish výstup (products_import.csv)', () => {
    it('všech 100 produktů x 10 tierů = 1000 cen sedí na cent', () => {
        const diffs: unknown[] = [];
        for (const row of snapshot) {
            const cap = inferredBrandCapRatio(row);
            const limits: Record<string, Decimal> =
                cap !== undefined ? { [row.code]: new Decimal(cap) } : {};
            const nexus = nexusCalculateAllTierPrices(
                { code: row.code, price: row.price, actionPrice: row.actionPrice },
                limits
            );
            for (const [tier, expected] of Object.entries(row.expected)) {
                if (nexus[tier] !== expected) {
                    diffs.push({ code: row.code, tier, expected, nexus: nexus[tier] });
                }
            }
        }
        expect(diffs).toEqual([]);
    });

    it('a shodně i proti okfish oracle implementaci (ne jen proti CSV)', () => {
        const diffs: unknown[] = [];
        for (const row of snapshot) {
            const cap = inferredBrandCapRatio(row);
            const limitsNum: Record<string, number> = cap !== undefined ? { [row.code]: cap } : {};
            const limitsDec: Record<string, Decimal> =
                cap !== undefined ? { [row.code]: new Decimal(cap) } : {};
            const okfish = okfishCalculateAllTierPrices(
                { code: row.code, price: row.price, actionPrice: row.actionPrice },
                limitsNum
            );
            const nexus = nexusCalculateAllTierPrices(
                { code: row.code, price: row.price, actionPrice: row.actionPrice },
                limitsDec
            );
            for (const tier of TIER_NAMES) {
                const o = okfish[tier]!.price.toFixed(2);
                if (nexus[tier] !== o) diffs.push({ code: row.code, tier, okfish: o, nexus: nexus[tier] });
            }
        }
        expect(diffs).toEqual([]);
    });
});

describe('Brandová syntéza + strop + clearance okno: proti okfish oracle', () => {
    // Snapshot manufacturer nemá, takže brandové chování se ověřuje proti
    // ORACLE implementaci na syntetických, ale REALISTICKÝCH cenách
    // z katalogu (nejnižší, typické, nejvyšší).
    const basePrices = ['0.65', '6.25', '15.97', '27.95', '37.95', '1180', '6830.01'];
    const brands = ['DELPHIN', 'DELPHIN BOMB', 'MIVARDI', 'MIKADO', 'LOWRANCE', 'VAGNER', 'NEZNAMA'];

    it('všechny kombinace cena x značka x tier: shoda s okfish workerem', () => {
        const limits = buildProductLimits(NOW_AFTER_WINDOW);
        const limitsNum = toNumberLimits(limits);
        const diffs: unknown[] = [];
        for (const price of basePrices) {
            for (const manufacturer of brands) {
                const row: OkfishRow = { code: 'SYNTH', price, manufacturer };
                const okfish = okfishCalculateAllTierPrices(row, limitsNum);
                const nexus = nexusCalculateAllTierPrices(row, limits);
                for (const tier of TIER_NAMES) {
                    const o = okfish[tier]!.price.toFixed(2);
                    if (nexus[tier] !== o) diffs.push({ price, manufacturer, tier, okfish: o, nexus: nexus[tier] });
                }
            }
        }
        expect(diffs).toEqual([]);
    });

    it('s no-op akční cenou (actionPrice == price) na každé kombinaci: shoda', () => {
        const limits = buildProductLimits(NOW_AFTER_WINDOW);
        const limitsNum = toNumberLimits(limits);
        const diffs: unknown[] = [];
        for (const price of basePrices) {
            for (const manufacturer of brands) {
                const row: OkfishRow = { code: 'SYNTH', price, actionPrice: price, manufacturer };
                const okfish = okfishCalculateAllTierPrices(row, limitsNum);
                const nexus = nexusCalculateAllTierPrices(row, limits);
                for (const tier of TIER_NAMES) {
                    const o = okfish[tier]!.price.toFixed(2);
                    if (nexus[tier] !== o) diffs.push({ price, manufacturer, tier, okfish: o, nexus: nexus[tier] });
                }
            }
        }
        expect(diffs).toEqual([]);
    });

    it('clearance kód 3963P-S: V OKNĚ dostane 20% strop, PO OKNĚ propadne na loyalty', () => {
        const price = '15.97';
        const rowIn: OkfishRow = { code: '3963P-S', price };

        const inWindow = buildProductLimits(NOW_IN_WINDOW);
        const afterWindow = buildProductLimits(NOW_AFTER_WINDOW);

        // V okně: strop 20 %, ale bez akční ceny je to jen podlaha --
        // mělčí tiery (ZR4..ZR20) zůstávají na svých loyalty cenách,
        // ZR25 (25 % > 20 %) se zvedne na podlahu 12.78.
        const nIn = nexusCalculateAllTierPrices(rowIn, inWindow);
        expect(nIn['ZR4']).toBe('15.33'); // 4 % loyalty, nad podlahou
        expect(nIn['ZR20']).toBe('12.78'); // 20 % == podlaha
        expect(nIn['ZR25']).toBe('12.78'); // zvednuto z 11.98 na podlahu

        // Po okně: žádný product limit, ZR25 padne na plných 25 %.
        const nAfter = nexusCalculateAllTierPrices(rowIn, afterWindow);
        expect(nAfter['ZR25']).toBe('11.98');

        // A obojí sedí na okfish oracle.
        expect(nIn).toEqual(
            Object.fromEntries(
                Object.entries(okfishCalculateAllTierPrices(rowIn, toNumberLimits(inWindow))).map(
                    ([t, v]) => [t, v.price.toFixed(2)]
                )
            )
        );
        expect(nAfter).toEqual(
            Object.fromEntries(
                Object.entries(okfishCalculateAllTierPrices(rowIn, toNumberLimits(afterWindow))).map(
                    ([t, v]) => [t, v.price.toFixed(2)]
                )
            )
        );
    });

    it('zero-discount kód: strop 0 % neznamená "žádný strop" -- MUSÍ zůstat základní cena', () => {
        // Past, do které se dá snadno spadnout: `minAllowedPrice > 0` ve
        // workeru znamená, že strop 0 % se chová jako ŽÁDNÝ strop, protože
        // applyPercent(base, 0) == base > 0 -> podlaha == base, takže
        // každá loyalty cena je pod ní a zvedne se zpátky na base.
        const limits = buildProductLimits(NOW_AFTER_WINDOW);
        const row: OkfishRow = { code: '01011', price: '100' };
        const nexus = nexusCalculateAllTierPrices(row, limits);
        for (const tier of TIER_NAMES) expect(nexus[tier]).toBe('100.00');
        const okfish = okfishCalculateAllTierPrices(row, toNumberLimits(limits));
        for (const tier of TIER_NAMES) expect(okfish[tier]!.price.toFixed(2)).toBe('100.00');
    });

    it('kód s override 10 % (101821): strop se projeví na hlubokých tierech', () => {
        const limits = buildProductLimits(NOW_AFTER_WINDOW);
        const row: OkfishRow = { code: '101821', price: '100' };
        const nexus = nexusCalculateAllTierPrices(row, limits);
        expect(nexus['ZR4']).toBe('96.00'); // 4 % < 10 %, beze změny
        expect(nexus['ZR10']).toBe('90.00'); // přesně na podlaze
        expect(nexus['ZR25']).toBe('90.00'); // zvednuto z 75.00
    });
});
