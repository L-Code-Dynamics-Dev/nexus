// Parity: Nexus ClearanceWindowRule vs okfish `resolveClearancePct`.
//
// Referenční implementace (živý klon okfish, HEAD 3a910e2):
//   cloudflare-worker/src/engine/config.ts:63-68
// Replikovaná níže jako `okfishResolveClearancePct` znak po znaku; jediný
// rozdíl je, že `now` je zde parametr (v okfishi je to modul-level
// `new Date()` z config.ts:70 -- právě ten nedeterminismus, který Nexus
// vědomě nepřebírá, viz hlavička ClearanceWindowRule.ts).
//
// REÁLNÁ DATA: fixtures/okfish-policy/clearance-sale-products.json je
// bitová kopie produkčního souboru: 39 položek v prostém číselném tvaru
// (22 / 29 / 30 %) + jediná okenní položka `3963P-S`
// ({ pct: 20, validFrom: "2026-08-31", validTo: "2026-09-04" }).

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    ClearanceWindowRule,
    type ClearanceEntry,
} from '../../../domains/pricing/ClearanceWindowRule.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clearance = JSON.parse(
    fs.readFileSync(
        path.join(__dirname, 'fixtures/okfish-policy/clearance-sale-products.json'),
        'utf-8'
    )
) as Record<string, ClearanceEntry>;

const CTX = { tenantId: 'ten_okfish', ruleId: 'clearance-window-v1', ruleVersion: '1' };
const rule = new ClearanceWindowRule(CTX);

/** okfish cloudflare-worker/src/engine/config.ts:63-68, 1:1. */
function okfishResolveClearancePct(entry: ClearanceEntry, now: Date): number | undefined {
    if (typeof entry === 'number') return entry;
    if (entry.validFrom && now < new Date(entry.validFrom)) return undefined;
    if (entry.validTo && now > new Date(entry.validTo + 'T23:59:59')) return undefined;
    return entry.pct;
}

function nexusPct(entry: ClearanceEntry, nowIso: string): number | undefined {
    const r = rule.evaluate({ entry, now: nowIso });
    return r.active ? r.pct : undefined;
}

const WINDOWED = clearance['3963P-S'] as { pct: number; validFrom: string; validTo: string };

describe('clearance-sale-products.json fixture: bitová kopie okfish produkce', () => {
    it('39 prostých položek + 1 okenní', () => {
        const entries = Object.entries(clearance);
        const plain = entries.filter(([, e]) => typeof e === 'number');
        const windowed = entries.filter(([, e]) => typeof e === 'object');
        expect(plain.length).toBe(39);
        expect(windowed.length).toBe(1);
        expect(windowed[0]?.[0]).toBe('3963P-S');
    });

    it('okenní položka má očekávaný tvar', () => {
        expect(WINDOWED).toEqual({ pct: 20, validFrom: '2026-08-31', validTo: '2026-09-04' });
    });

    it('prosté položky používají jen sazby 22, 29 a 30 %', () => {
        const pcts = new Set(
            Object.values(clearance).filter((e): e is number => typeof e === 'number')
        );
        expect([...pcts].sort((a, b) => a - b)).toEqual([22, 29, 30]);
    });
});

describe('ClearanceWindowRule -- prostý číselný tvar (bez okna)', () => {
    it.each(['43981', '101267', '105012'])(
        '%s je aktivní v LIBOVOLNÉM okamžiku',
        (code) => {
            const entry = clearance[code]!;
            for (const now of [
                '1999-01-01T00:00:00.000Z',
                '2026-09-07T12:00:00.000Z',
                '2099-12-31T23:59:59.000Z',
            ]) {
                const r = rule.evaluate({ entry, now });
                expect(r.active).toBe(true);
                expect(r.pct).toBe(entry as number);
            }
        }
    );
});

describe('ClearanceWindowRule -- hranice okna 3963P-S (2026-08-31 .. 2026-09-04)', () => {
    // Hranice počítané z okfish sémantiky: validFrom je UTC půlnoc,
    // validTo je LOKÁLNÍ 23:59:59 toho dne. Testy níže používají výhradně
    // časy, kde ta asymetrie nehraje roli (kotvené k UTC půlnoci a k
    // dnům dostatečně daleko), plus explicitní test asymetrie na konci.
    const cases: Array<[string, string, boolean, string | undefined]> = [
        ['den před oknem', '2026-08-30T12:00:00.000Z', false, 'BEFORE_WINDOW'],
        ['vteřinu před začátkem (UTC)', '2026-08-30T23:59:59.000Z', false, 'BEFORE_WINDOW'],
        ['PŘESNĚ začátek okna (UTC půlnoc)', '2026-08-31T00:00:00.000Z', true, undefined],
        ['první den okna, poledne', '2026-08-31T12:00:00.000Z', true, undefined],
        ['prostředek okna', '2026-09-02T08:30:00.000Z', true, undefined],
        ['poslední den okna, poledne', '2026-09-04T12:00:00.000Z', true, undefined],
        ['den po okně', '2026-09-05T12:00:00.000Z', false, 'AFTER_WINDOW'],
        ['dva dny po okně (dnešek)', '2026-09-07T00:00:00.000Z', false, 'AFTER_WINDOW'],
    ];

    it.each(cases)('%s', (_label, now, expectedActive, expectedReason) => {
        const r = rule.evaluate({ entry: WINDOWED, now });
        expect(r.active).toBe(expectedActive);
        expect(r.pct).toBe(expectedActive ? 20 : undefined);
        expect(r.reasonCode).toBe(expectedReason);
    });

    it('shoda s okfish resolveClearancePct na všech výše uvedených okamžicích', () => {
        const diffs = cases
            .map(([label, now]) => ({
                label,
                okfish: okfishResolveClearancePct(WINDOWED, new Date(now)),
                nexus: nexusPct(WINDOWED, now),
            }))
            .filter((d) => d.okfish !== d.nexus);
        expect(diffs).toEqual([]);
    });

    it('shoda s okfishem den po dni přes celý srpen a září 2026', () => {
        const diffs: unknown[] = [];
        for (let d = new Date(Date.UTC(2026, 7, 1)); d < new Date(Date.UTC(2026, 9, 1)); d = new Date(d.getTime() + 86_400_000)) {
            const now = d.toISOString();
            const okfish = okfishResolveClearancePct(WINDOWED, new Date(now));
            const nexus = nexusPct(WINDOWED, now);
            if (okfish !== nexus) diffs.push({ now, okfish, nexus });
        }
        expect(diffs).toEqual([]);
    });
});

describe('ClearanceWindowRule -- jednostranná okna a vadné vstupy', () => {
    it('jen validFrom: neomezené doprava', () => {
        const e: ClearanceEntry = { pct: 15, validFrom: '2026-01-01' };
        expect(nexusPct(e, '2025-12-31T23:59:59.000Z')).toBeUndefined();
        expect(nexusPct(e, '2026-01-01T00:00:00.000Z')).toBe(15);
        expect(nexusPct(e, '2099-01-01T00:00:00.000Z')).toBe(15);
    });

    it('jen validTo: neomezené doleva', () => {
        const e: ClearanceEntry = { pct: 15, validTo: '2026-01-01' };
        expect(nexusPct(e, '1999-01-01T00:00:00.000Z')).toBe(15);
        expect(nexusPct(e, '2026-01-01T12:00:00.000Z')).toBe(15);
        expect(nexusPct(e, '2026-01-03T00:00:00.000Z')).toBeUndefined();
    });

    it('žádná hranice = chová se jako prosté číslo', () => {
        expect(nexusPct({ pct: 15 }, '1999-01-01T00:00:00.000Z')).toBe(15);
    });

    it('validFrom > validTo (nesmyslné okno): nikdy aktivní', () => {
        const e: ClearanceEntry = { pct: 15, validFrom: '2026-09-10', validTo: '2026-09-01' };
        for (const now of ['2026-09-05T12:00:00.000Z', '2026-09-11T12:00:00.000Z', '2026-08-01T12:00:00.000Z']) {
            expect(nexusPct(e, now)).toBeUndefined();
        }
    });

    it('nerozparsovatelné `now`: fail-closed, INVALID_DATE', () => {
        const r = rule.evaluate({ entry: WINDOWED, now: 'zítra odpoledne' });
        expect(r.active).toBe(false);
        expect(r.reasonCode).toBe('INVALID_DATE');
    });

    it('nerozparsovatelné validFrom/validTo: fail-closed, INVALID_DATE', () => {
        expect(
            rule.evaluate({ entry: { pct: 20, validFrom: 'blbost' }, now: '2026-09-07T00:00:00.000Z' })
                .reasonCode
        ).toBe('INVALID_DATE');
        expect(
            rule.evaluate({ entry: { pct: 20, validTo: 'blbost' }, now: '2026-09-07T00:00:00.000Z' })
                .reasonCode
        ).toBe('INVALID_DATE');
    });

    it('DETERMINISMUS: dvě volání se stejným `now` dají identický výsledek', () => {
        const a = rule.evaluate({ entry: WINDOWED, now: '2026-09-04T12:00:00.000Z' });
        const b = rule.evaluate({ entry: WINDOWED, now: '2026-09-04T12:00:00.000Z' });
        expect(a).toEqual(b);
    });
});

describe('Celý fixture soubor vs okfish, napříč kalendářem', () => {
    it('každá položka x 24 měsíců: nulový rozdíl proti okfish implementaci', () => {
        const diffs: unknown[] = [];
        for (const [code, entry] of Object.entries(clearance)) {
            for (let m = 0; m < 24; m++) {
                const d = new Date(Date.UTC(2026, m, 1, 12, 0, 0));
                const now = d.toISOString();
                const okfish = okfishResolveClearancePct(entry, new Date(now));
                const nexus = nexusPct(entry, now);
                if (okfish !== nexus) diffs.push({ code, now, okfish, nexus });
            }
        }
        expect(diffs).toEqual([]);
    });
});
