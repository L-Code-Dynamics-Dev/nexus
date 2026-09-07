// Shadow harness -- načtení reálných okfish dat OFFLINE.
//
// ZERO PRODUCTION WRITES: tenhle modul umí právě dvě věci -- přečíst lokální
// CSV soubor a udělat HTTP GET na veřejný master feed. Nic jiného. Žádný
// Shoptet token, žádný PATCH, žádný zápis do okfish repa ani do jeho
// stavových souborů (.sync_state.json / .reconciliation_state.json).
//
// PROČ VLASTNÍ PARSER A NE PAPAPARSE: chci bajt-přesně stejnou sémantiku,
// jakou má okfish `cloudflare-worker/src/csv/csv-parser.ts` (oddělovač ';',
// quote '"', zdvojená uvozovka jako escape, chybějící sloupec -> ''). Feed
// má 592 sloupců a ~17 500 řádků; papaparse by fungoval taky, ale jakýkoli
// rozdíl v parsování by se v porovnání projevil jako falešný cenový rozdíl,
// a to je přesně ta chyba, kterou shadow nesmí udělat.

import * as fs from 'fs';

export const MASTER_FEED_URL =
    'https://www.okfish.sk/export/products.csv' +
    '?patternId=32&partnerId=4' +
    '&hash=REDACTED_OKFISH_EXPORT_HASH';

export type CsvRow = Record<string, string>;

/**
 * Parser 1:1 podle okfish `CsvParserStream`, jen synchronní nad celým
 * řetězcem místo streamu. Stejné pravidlo pro uvozovky: hodnota se odkvótuje
 * jen tehdy, když začíná I končí uvozovkou, a `""` uvnitř se složí na `"`.
 */
export function parseCsv(text: string, delimiter = ';', quoteChar = '"'): CsvRow[] {
    // BOM: feed i products.csv začínají UTF-8 BOM. Bez odstranění by první
    // sloupec nesl jméno "﻿code" a `row['code']` by bylo undefined --
    // tichý 100% mismatch na všem.
    const str = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

    const rows: CsvRow[] = [];
    let headers: string[] | null = null;
    let row: string[] = [];
    let inQuotes = false;
    let start = 0;

    const dq = new RegExp(quoteChar + quoteChar, 'g');
    const unquote = (val: string): string => {
        if (val.length >= 2 && val.charCodeAt(0) === quoteChar.charCodeAt(0)
            && val.charCodeAt(val.length - 1) === quoteChar.charCodeAt(0)) {
            return val.substring(1, val.length - 1).replace(dq, quoteChar);
        }
        return val;
    };

    const pushRow = (): void => {
        if (!headers) {
            headers = row;
        } else {
            const obj: CsvRow = {};
            for (let j = 0; j < headers.length; j++) obj[headers[j]!] = row[j] ?? '';
            rows.push(obj);
        }
        row = [];
    };

    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        if (c === quoteChar.charCodeAt(0)) {
            if (inQuotes && i + 1 < str.length && str.charCodeAt(i + 1) === quoteChar.charCodeAt(0)) {
                i++; // escapovaná uvozovka
            } else {
                inQuotes = !inQuotes;
            }
        } else if (c === delimiter.charCodeAt(0) && !inQuotes) {
            row.push(unquote(str.substring(start, i)));
            start = i + 1;
        } else if ((c === 10 || c === 13) && !inQuotes) {
            const isCrLf = c === 13 && i + 1 < str.length && str.charCodeAt(i + 1) === 10;
            row.push(unquote(str.substring(start, i)));
            if (isCrLf) i++;
            pushRow();
            start = i + 1;
        }
    }
    if (start < str.length) row.push(unquote(str.substring(start)));
    if (row.length > 0 && headers) pushRow();

    return rows;
}

export interface FeedLoadResult {
    rows: CsvRow[];
    source: string;
    bytes: number;
    fetchedAt: string;
}

/**
 * Načte feed. Priorita:
 *   1. explicitní cesta (`--feed <path>` / env SHADOW_FEED_FILE) -- offline,
 *   2. cache soubor, pokud existuje a není starší než `maxAgeMs`,
 *   3. HTTP GET na veřejný master feed (jediné povolené síťové volání),
 *   4. fallback na `products.csv` v okfish klonu (má míň sloupců -- viz report).
 *
 * Stažený feed se cachuje do /tmp, ne do okfish repa.
 */
export async function loadFeed(opts: {
    filePath?: string;
    cachePath?: string;
    allowNetwork?: boolean;
    fallbackPath?: string;
    maxAgeMs?: number;
}): Promise<FeedLoadResult> {
    const { filePath, cachePath, allowNetwork = true, fallbackPath, maxAgeMs = 6 * 3600 * 1000 } = opts;

    const readLocal = (p: string, label: string): FeedLoadResult => {
        const text = fs.readFileSync(p, 'utf-8');
        return { rows: parseCsv(text), source: `${label}:${p}`, bytes: Buffer.byteLength(text), fetchedAt: fs.statSync(p).mtime.toISOString() };
    };

    if (filePath) return readLocal(filePath, 'file');

    if (cachePath && fs.existsSync(cachePath)) {
        const age = Date.now() - fs.statSync(cachePath).mtimeMs;
        if (age < maxAgeMs) return readLocal(cachePath, 'cache');
    }

    if (allowNetwork) {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 300_000);
            try {
                // GET, nic jiného. Read-only operace na veřejné URL.
                const res = await fetch(MASTER_FEED_URL, { method: 'GET', signal: controller.signal });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const text = await res.text();
                if (cachePath) {
                    try { fs.writeFileSync(cachePath, text, 'utf-8'); } catch { /* cache je nice-to-have */ }
                }
                return { rows: parseCsv(text), source: 'network:master-feed', bytes: Buffer.byteLength(text), fetchedAt: new Date().toISOString() };
            } finally {
                clearTimeout(timer);
            }
        } catch (err) {
            console.warn(`[NEXUS_SHADOW] feed fetch selhal (${err instanceof Error ? err.message : String(err)}), zkouším cache/fallback.`);
        }
    }

    if (cachePath && fs.existsSync(cachePath)) return readLocal(cachePath, 'cache-stale');
    if (fallbackPath && fs.existsSync(fallbackPath)) return readLocal(fallbackPath, 'fallback');

    throw new Error('loadFeed: žádný dostupný zdroj dat (síť selhala, cache ani fallback neexistují).');
}

/** Argument parser pro harness skripty. */
export function parseArgs(argv: string[]): Record<string, string | boolean> {
    const out: Record<string, string | boolean> = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        if (!a.startsWith('--')) continue;
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
        else out[key] = true;
    }
    return out;
}
