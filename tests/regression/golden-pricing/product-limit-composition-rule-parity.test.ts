// Parity: Nexus ProductLimitCompositionRule vs okfish PRODUCT_LIMITS.
//
// Referenční implementace (živý klon okfish, HEAD 3a910e2):
//   cloudflare-worker/src/engine/config.ts:92-115  (Stage 1 conflict check)
//   cloudflare-worker/src/engine/config.ts:117-123 (PRODUCT_LIMITS spread)
// Obojí replikováno níže; okfish verze je použita jako oracle.
//
// REÁLNÁ DATA (bitové kopie produkčních souborů z okfishe):
//   zero-discount-products.json          206 kódů
//   clearance-sale-products.json          40 kódů (39 prostých + 3963P-S s oknem)
//   product-max-discount-overrides.json    2 kódy (101821: 10 %, 101800: 10 %)
// V produkci se tyhle tři množiny NEPŘEKRÝVAJÍ -- Stage 1 tedy na reálných
// datech projde, což je samo o sobě tvrzení, které tu chceme mít zafixované.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Decimal from 'decimal.js';
import {
    ProductLimitCompositionRule,
    type ProductLimitCompositionRuleInput,
} from '../../../domains/pricing/ProductLimitCompositionRule.js';
import {
    ClearanceWindowRule,
    type ClearanceEntry,
} from '../../../domains/pricing/ClearanceWindowRule.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POLICY_DIR = path.join(__dirname, 'fixtures/okfish-policy');
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(POLICY_DIR, f), 'utf-8'));

const zeroDiscountProducts = read('zero-discount-products.json') as string[];
const clearanceSaleProducts = read('clearance-sale-products.json') as Record<string, ClearanceEntry>;
const productMaxDiscountOverrides = read('product-max-discount-overrides.json') as Record<string, number>;

const CTX = { tenantId: 'ten_okfish', ruleId: 'product-limit-composition-v1', ruleVersion: '1' };
const rule = new ProductLimitCompositionRule(CTX);
const clearanceRule = new ClearanceWindowRule({
    tenantId: 'ten_okfish',
    ruleId: 'clearance-window-v1',
    ruleVersion: '1',
});

// ---------------------------------------------------------------- oracle

/** okfish config.ts:63-68. */
function okfishResolveClearancePct(entry: ClearanceEntry, now: Date): number | undefined {
    if (typeof entry === 'number') return entry;
    if (entry.validFrom && now < new Date(entry.validFrom)) return undefined;
    if (entry.validTo && now > new Date(entry.validTo + 'T23:59:59')) return undefined;
    return entry.pct;
}

/** okfish config.ts:92-109 -- hází při konfliktu. */
function okfishAssertNoCrossFileConflicts(sources: Record<string, string[]>): void {
    const entries = Object.entries(sources);
    for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
            const entryA = entries[i];
            const entryB = entries[j];
            if (entryA === undefined || entryB === undefined) continue;
            const [nameA, codesA] = entryA;
            const [nameB, codesB] = entryB;
            const setB = new Set<string>(codesB);
            const conflicts = codesA.filter((code: string) => setB.has(code));
            if (conflicts.length > 0) {
                throw new Error(
                    `Product code(s) ${conflicts.join(', ')} appear in BOTH ${nameA} and ${nameB}.`
                );
            }
        }
    }
}

/** okfish config.ts:70-73 + 117-123, s `now` jako parametrem. */
function okfishProductLimits(
    zero: string[],
    clearanceMap: Record<string, ClearanceEntry>,
    overrides: Record<string, number>,
    now: Date
): Record<string, number> {
    const activeClearanceEntries = Object.entries(clearanceMap)
        .map(([code, entry]) => [code, okfishResolveClearancePct(entry, now)] as const)
        .filter((pair): pair is [string, number] => pair[1] !== undefined);

    okfishAssertNoCrossFileConflicts({
        'zero-discount-products.json': zero,
        'clearance-sale-products.json': Object.keys(clearanceMap),
        'product-max-discount-overrides.json': Object.keys(overrides),
    });

    return {
        ...Object.fromEntries(zero.map((code) => [code, 0])),
        ...Object.fromEntries(activeClearanceEntries.map(([code, pct]) => [code, pct / 100])),
        ...Object.fromEntries(Object.entries(overrides).map(([code, pct]) => [code, pct / 100])),
    };
}

// ---------------------------------------------------------------- helpers

function activeClearanceFor(
    clearanceMap: Record<string, ClearanceEntry>,
    nowIso: string
): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [code, entry] of Object.entries(clearanceMap)) {
        const r = clearanceRule.evaluate({ entry, now: nowIso });
        if (r.active && r.pct !== undefined) out[code] = r.pct;
    }
    return out;
}

function runNexus(
    nowIso: string,
    overrides?: Partial<ProductLimitCompositionRuleInput>
) {
    return rule.evaluate({
        zeroDiscountCodes: zeroDiscountProducts,
        clearanceCodes: Object.keys(clearanceSaleProducts),
        activeClearancePct: activeClearanceFor(clearanceSaleProducts, nowIso),
        productMaxDiscountOverridePct: productMaxDiscountOverrides,
        ...overrides,
    });
}

function toNumberMap(m: Record<string, Decimal>): Record<string, number> {
    return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.toNumber()]));
}

// ---------------------------------------------------------------- tests

describe('Fixture soubory jsou bitové kopie okfish produkce', () => {
    it('očekávané velikosti a obsah', () => {
        expect(zeroDiscountProducts.length).toBe(206);
        expect(Object.keys(clearanceSaleProducts).length).toBe(40);
        expect(productMaxDiscountOverrides).toEqual({ '101821': 10, '101800': 10 });
    });

    it('v produkci se tři zdroje NEPŘEKRÝVAJÍ (Stage 1 projde)', () => {
        expect(() =>
            okfishAssertNoCrossFileConflicts({
                'zero-discount-products.json': zeroDiscountProducts,
                'clearance-sale-products.json': Object.keys(clearanceSaleProducts),
                'product-max-discount-overrides.json': Object.keys(productMaxDiscountOverrides),
            })
        ).not.toThrow();
    });
});

describe('Kompozice PRODUCT_LIMITS proti reálným datům', () => {
    // Tři okamžiky: PŘED oknem 3963P-S, V okně, PO okně.
    const moments: Array<[string, string, boolean]> = [
        ['před oknem 3963P-S', '2026-08-15T12:00:00.000Z', false],
        ['v okně 3963P-S', '2026-09-02T12:00:00.000Z', true],
        ['po okně 3963P-S (dnešek)', '2026-09-07T12:00:00.000Z', false],
    ];

    it.each(moments)('%s: shoda s okfish PRODUCT_LIMITS na každém klíči', (_l, nowIso) => {
        const nexus = runNexus(nowIso);
        expect(nexus.valid).toBe(true);
        const okfish = okfishProductLimits(
            zeroDiscountProducts,
            clearanceSaleProducts,
            productMaxDiscountOverrides,
            new Date(nowIso)
        );
        expect(toNumberMap(nexus.limits)).toEqual(okfish);
    });

    it.each(moments)('%s: 3963P-S je v mapě právě když je okno aktivní', (_l, nowIso, inWindow) => {
        const nexus = runNexus(nowIso);
        if (inWindow) {
            expect(nexus.limits['3963P-S']?.toString()).toBe('0.2');
            expect(nexus.sources['3963P-S']).toBe('clearance-sale-products.json');
        } else {
            // NEAKTIVNÍ okno != strop 0. Klíč v mapě VŮBEC NENÍ, takže
            // DiscountLimitRule propadne na brand/category fallback.
            expect(nexus.limits['3963P-S']).toBeUndefined();
            expect(nexus.sources['3963P-S']).toBeUndefined();
        }
    });

    it('velikost mapy: 206 + 39 + 2 mimo okno, o jedna víc v okně', () => {
        expect(Object.keys(runNexus('2026-09-07T12:00:00.000Z').limits).length).toBe(247);
        expect(Object.keys(runNexus('2026-09-02T12:00:00.000Z').limits).length).toBe(248);
    });

    it('převod jednotek: pct -> poměr, zero -> 0', () => {
        const { limits, sources } = runNexus('2026-09-07T12:00:00.000Z');
        expect(limits['43981']?.toString()).toBe('0.22'); // clearance 22 %
        expect(limits['101267']?.toString()).toBe('0.3'); // clearance 30 %
        expect(limits['105012']?.toString()).toBe('0.29'); // clearance 29 %
        expect(limits['101821']?.toString()).toBe('0.1'); // override 10 %
        expect(limits['01011']?.toString()).toBe('0'); // zero-discount
        expect(sources['01011']).toBe('zero-discount-products.json');
        expect(sources['101821']).toBe('product-max-discount-overrides.json');
    });

    it('žádná ztráta přesnosti: 29 / 100 je přesně 0.29 (Decimal, ne float)', () => {
        const limits = runNexus('2026-09-07T12:00:00.000Z').limits;
        expect(limits['105012']?.equals(new Decimal('0.29'))).toBe(true);
        // Pro srovnání: okfishova float cesta 29/100 je zde bez chyby, ale
        // Decimal to garantuje bez ohledu na hodnotu.
        expect(limits['105012']?.toFixed(20)).toBe('0.29000000000000000000');
    });
});

describe('Stage 1: cross-file conflict check', () => {
    it('kód ve dvou zdrojích: mapa se NEPOSTAVÍ', () => {
        const r = runNexus('2026-09-07T12:00:00.000Z', {
            zeroDiscountCodes: [...zeroDiscountProducts, '43981'], // 43981 je i v clearance
        });
        expect(r.valid).toBe(false);
        expect(r.limits).toEqual({});
        expect(r.sources).toEqual({});
        expect(r.conflicts).toEqual([
            {
                code: '43981',
                sourceA: 'zero-discount-products.json',
                sourceB: 'clearance-sale-products.json',
            },
        ]);
        expect(r.reason).toContain('43981');
        expect(r.reason).toContain('appear in BOTH');
    });

    it('konflikt zero x overrides', () => {
        const r = runNexus('2026-09-07T12:00:00.000Z', {
            zeroDiscountCodes: [...zeroDiscountProducts, '101821'],
        });
        expect(r.valid).toBe(false);
        expect(r.conflicts[0]).toEqual({
            code: '101821',
            sourceA: 'zero-discount-products.json',
            sourceB: 'product-max-discount-overrides.json',
        });
    });

    it('konflikt clearance x overrides', () => {
        const r = runNexus('2026-09-07T12:00:00.000Z', {
            productMaxDiscountOverridePct: { ...productMaxDiscountOverrides, '43981': 5 },
        });
        expect(r.valid).toBe(false);
        expect(r.conflicts[0]).toEqual({
            code: '43981',
            sourceA: 'clearance-sale-products.json',
            sourceB: 'product-max-discount-overrides.json',
        });
    });

    it('více konfliktů se vrátí VŠECHNY, ne jen první', () => {
        const r = runNexus('2026-09-07T12:00:00.000Z', {
            zeroDiscountCodes: [...zeroDiscountProducts, '43981', '101267'],
        });
        expect(r.conflicts.map((c) => c.code).sort()).toEqual(['101267', '43981']);
    });

    it('konflikt se hlásí i u kódu s NEAKTIVNÍM oknem', () => {
        // okfish config.ts:113 porovnává Object.keys(clearanceSaleProducts),
        // tedy všechny klíče bez ohledu na datum. Vada konfigurace je vada
        // konfigurace, i když ta položka zrovna neplatí.
        const nowPastWindow = '2026-09-07T12:00:00.000Z';
        const r = runNexus(nowPastWindow, {
            zeroDiscountCodes: [...zeroDiscountProducts, '3963P-S'],
        });
        expect(r.valid).toBe(false);
        expect(r.conflicts[0]?.code).toBe('3963P-S');
        // Ověření, že to opravdu je mimo okno:
        expect(activeClearanceFor(clearanceSaleProducts, nowPastWindow)['3963P-S']).toBeUndefined();
    });

    it('Nexus a okfish se shodnou na TOM, ZDA konflikt je (okfish hází, Nexus vrací data)', () => {
        const zeroWithConflict = [...zeroDiscountProducts, '43981'];
        expect(() =>
            okfishAssertNoCrossFileConflicts({
                'zero-discount-products.json': zeroWithConflict,
                'clearance-sale-products.json': Object.keys(clearanceSaleProducts),
                'product-max-discount-overrides.json': Object.keys(productMaxDiscountOverrides),
            })
        ).toThrow(/43981/);
        expect(runNexus('2026-09-07T12:00:00.000Z', { zeroDiscountCodes: zeroWithConflict }).valid).toBe(false);
    });
});

describe('Prázdné a degenerované vstupy', () => {
    it('všechny zdroje prázdné: platná prázdná mapa', () => {
        const r = rule.evaluate({
            zeroDiscountCodes: [],
            clearanceCodes: [],
            activeClearancePct: {},
            productMaxDiscountOverridePct: {},
        });
        expect(r.valid).toBe(true);
        expect(r.limits).toEqual({});
        expect(r.conflicts).toEqual([]);
    });

    it('determinismus: dvě volání stejného vstupu dají stejnou mapu', () => {
        const a = toNumberMap(runNexus('2026-09-02T12:00:00.000Z').limits);
        const b = toNumberMap(runNexus('2026-09-02T12:00:00.000Z').limits);
        expect(a).toEqual(b);
    });
});
