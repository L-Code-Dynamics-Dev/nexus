// Parity: Nexus NoOpActionPriceRule vs okfish no-op actionPrice guard.
//
// Referenční implementace (živý klon okfish, HEAD 3a910e2):
//   engine/pricing.ts:125            `if (actionPrice !== undefined && actionPrice >= basePrice) actionPrice = undefined;`
//   shoptet-api/pricing-bridge.ts:56 `p.actionPrice && Number(p.actionPrice) < basePriceNum ? p.actionPrice : undefined`
// Obě větve jsou zde replikované a Rule se testuje proti OBĚMA.
//
// REÁLNÁ DATA: fixtures/okfish-policy/okfish-products-actionprice-sample.csv
// je výřez z okfish products.csv (16633 řádků) pokrývající všechny čtyři
// třídy, které se v katalogu vyskytují:
//   actionPrice == price  8908 řádků  -> no-op, MUSÍ se zahodit
//   actionPrice <  price  5643 řádků  -> reálná akce, MUSÍ projít
//   actionPrice >  price    26 řádků  -> no-op, MUSÍ se zahodit
//   actionPrice prázdné   2056 řádků  -> žádná akce
// Ve fixture je 8 + 8 + 8 + 4 skutečných řádků z produkce.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Decimal from 'decimal.js';
import { NoOpActionPriceRule } from '../../../domains/pricing/NoOpActionPriceRule.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(
    __dirname,
    'fixtures/okfish-policy/okfish-products-actionprice-sample.csv'
);

const CTX = { tenantId: 'ten_okfish', ruleId: 'noop-action-price-v1', ruleVersion: '1' };
const rule = new NoOpActionPriceRule(CTX);

/** okfish engine/pricing.ts:38-43 -- čárka jako desetinný oddělovač. */
function okfishParsePrice(val: string | undefined): number | undefined {
    if (!val || val.trim() === '') return undefined;
    const normalized = val.replace(',', '.').replace(/\s/g, '');
    const n = parseFloat(normalized);
    return Number.isNaN(n) ? undefined : n;
}

/** okfish engine/pricing.ts:125 (worker mini-engine). */
function okfishWorkerGuard(
    basePrice: number,
    actionPrice: number | undefined
): number | undefined {
    if (actionPrice !== undefined && actionPrice >= basePrice) return undefined;
    return actionPrice;
}

/** okfish shoptet-api/pricing-bridge.ts:56 (produkční zápisová cesta). */
function okfishBridgeGuard(
    basePrice: number,
    actionPrice: number | undefined
): number | undefined {
    return actionPrice && Number(actionPrice) < basePrice ? actionPrice : undefined;
}

function runNexus(basePrice: number, actionPrice: number | undefined) {
    const r = rule.evaluate({
        basePrice: new Decimal(basePrice),
        actionPrice: actionPrice !== undefined ? new Decimal(actionPrice) : undefined,
    });
    return r.effectiveSalePrice === undefined ? undefined : r.effectiveSalePrice.toNumber();
}

interface CatalogRow {
    code: string;
    price: number;
    actionPrice: number | undefined;
}

function loadSample(): CatalogRow[] {
    const text = fs.readFileSync(SAMPLE, 'utf-8').replace(/^﻿/, '');
    const lines = text.split('\n').filter((l) => l.trim() !== '');
    const out: CatalogRow[] = [];
    for (const line of lines.slice(1)) {
        const cols = line.split(';').map((c) => c.replace(/^"|"$/g, ''));
        const price = okfishParsePrice(cols[3]);
        if (price === undefined) continue;
        out.push({ code: cols[0] ?? '', price, actionPrice: okfishParsePrice(cols[9]) });
    }
    return out;
}

const catalog = loadSample();

describe('NoOpActionPriceRule -- syntetické hraniční případy', () => {
    it('actionPrice PŘESNĚ rovná basePrice se zahodí (`>=`, ne `>`)', () => {
        const r = rule.evaluate({ basePrice: new Decimal('1167.20'), actionPrice: new Decimal('1167.20') });
        expect(r.applied).toBe(true);
        expect(r.effectiveSalePrice).toBeUndefined();
    });

    it('actionPrice vyšší než basePrice se zahodí', () => {
        expect(runNexus(3.39, 3.47)).toBeUndefined();
    });

    it('actionPrice o jeden cent nižší projde', () => {
        expect(runNexus(100, 99.99)).toBe(99.99);
    });

    it('actionPrice = 0 PROJDE jako platná akce (0 < base)', () => {
        // Kritický rozdíl mezi Nexusem/workerem a okfish bridge: bridge
        // používá `p.actionPrice && ...`, takže numerická 0 je falsy a
        // spadne na undefined. Worker `!== undefined` ji propustí.
        // Nexus následuje WORKER. Viz test níže, který ten rozdíl fixuje.
        const r = rule.evaluate({ basePrice: new Decimal('100'), actionPrice: new Decimal('0') });
        expect(r.applied).toBe(false);
        expect(r.effectiveSalePrice!.toString()).toBe('0');
    });

    it('actionPrice undefined zůstane undefined a rule není applied', () => {
        const r = rule.evaluate({ basePrice: new Decimal('100'), actionPrice: undefined });
        expect(r.applied).toBe(false);
        expect(r.effectiveSalePrice).toBeUndefined();
    });

    it('basePrice = 0 a actionPrice = 0: zahozeno (0 >= 0)', () => {
        expect(runNexus(0, 0)).toBeUndefined();
    });
});

describe('ZDOKUMENTOVANÝ ROZDÍL: actionPrice = 0 -- worker vs bridge', () => {
    it('okfish worker propustí 0, okfish bridge ji zahodí; Nexus jde s workerem', () => {
        expect(okfishWorkerGuard(100, 0)).toBe(0);
        expect(okfishBridgeGuard(100, 0)).toBeUndefined();
        expect(runNexus(100, 0)).toBe(0);
    });
});

describe('Parity proti REÁLNÝM řádkům okfish products.csv', () => {
    it('fixture pokrývá všechny čtyři třídy', () => {
        const eq = catalog.filter((r) => r.actionPrice !== undefined && r.actionPrice === r.price);
        const lower = catalog.filter((r) => r.actionPrice !== undefined && r.actionPrice < r.price);
        const higher = catalog.filter((r) => r.actionPrice !== undefined && r.actionPrice > r.price);
        const none = catalog.filter((r) => r.actionPrice === undefined);
        expect(eq.length).toBeGreaterThan(0);
        expect(lower.length).toBeGreaterThan(0);
        expect(higher.length).toBeGreaterThan(0);
        expect(none.length).toBeGreaterThan(0);
        expect(catalog.length).toBe(28);
    });

    it('Nexus se shoduje s okfish WORKER guardem na každém řádku', () => {
        const diffs = catalog
            .map((r) => ({
                code: r.code,
                okfish: okfishWorkerGuard(r.price, r.actionPrice),
                nexus: runNexus(r.price, r.actionPrice),
            }))
            .filter((d) => d.okfish !== d.nexus);
        expect(diffs).toEqual([]);
    });

    it('Nexus se shoduje i s okfish BRIDGE guardem (na reálných datech tam 0 není)', () => {
        const diffs = catalog
            .map((r) => ({
                code: r.code,
                okfish: okfishBridgeGuard(r.price, r.actionPrice),
                nexus: runNexus(r.price, r.actionPrice),
            }))
            .filter((d) => d.okfish !== d.nexus);
        expect(diffs).toEqual([]);
    });

    it('všech 8 no-op řádků (actionPrice == price) je zahozeno', () => {
        const eq = catalog.filter((r) => r.actionPrice !== undefined && r.actionPrice === r.price);
        for (const r of eq) {
            expect(runNexus(r.price, r.actionPrice)).toBeUndefined();
        }
    });
});
