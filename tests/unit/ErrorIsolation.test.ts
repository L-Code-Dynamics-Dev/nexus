// core/error-isolation framework testy. Ověřují obecný batch-izolace
// kontrakt proti PricelistWriter.processDiff() vzoru
// (~/okfish-pricing-engine/cloudflare-worker/src/shoptet-api/
// pricelist-writer.ts) -- žádné napojení na produkční kód, čistě
// framework-level test.

import { describe, it, expect } from 'vitest';
import { runBatchWithIsolation, type ItemOutcome } from '../../core/error-isolation/ErrorIsolation.js';

interface PriceDiffItem {
    code: string;
    newPrice: number;
}

describe('runBatchWithIsolation — základní izolace', () => {
    it('batch se 3 úspěšnými + 2 neúspěšnými položkami pokračuje a vrátí obojí odděleně', async () => {
        const items: PriceDiffItem[] = [
            { code: 'A', newPrice: 10 },
            { code: 'B', newPrice: 20 },
            { code: 'C', newPrice: 30 },
            { code: 'D', newPrice: 40 },
            { code: 'E', newPrice: 50 },
        ];

        const result = await runBatchWithIsolation(items, async (item): Promise<ItemOutcome<PriceDiffItem, string>> => {
            if (item.code === 'B' || item.code === 'D') {
                return { kind: 'FAILURE', item, reason: `write failed for ${item.code}`, errorClass: 'RETRYABLE' };
            }
            return { kind: 'SUCCESS', item, result: `confirmed ${item.newPrice}` };
        });

        expect(result.totalCount).toBe(5);
        expect(result.successes).toHaveLength(3);
        expect(result.failures).toHaveLength(2);
        expect(result.successes.map((s) => s.item.code)).toEqual(['A', 'C', 'E']);
        expect(result.failures.map((f) => f.item.code)).toEqual(['B', 'D']);
    });

    it('žádná selhaná položka nezastaví zpracování zbytku batche (ani při throw uvnitř processItem)', async () => {
        const items: PriceDiffItem[] = [
            { code: 'A', newPrice: 10 },
            { code: 'B', newPrice: 20 },
            { code: 'C', newPrice: 30 },
        ];
        const processed: string[] = [];

        const result = await runBatchWithIsolation(items, async (item): Promise<ItemOutcome<PriceDiffItem, string>> => {
            processed.push(item.code);
            if (item.code === 'B') {
                throw new Error('unexpected network error');
            }
            return { kind: 'SUCCESS', item, result: 'ok' };
        });

        // Všechny tři položky musely být zpracovány, throw u B nezastavil C.
        expect(processed).toEqual(['A', 'B', 'C']);
        expect(result.successes.map((s) => s.item.code)).toEqual(['A', 'C']);
        expect(result.failures).toHaveLength(1);
        const failure = result.failures[0]!;
        expect(failure.item.code).toBe('B');
        // Neočekávaná výjimka je izolována jako NON_RETRYABLE (framework
        // neví, jestli je bezpečné to zkusit znovu bez doménového kontextu).
        expect(failure.errorClass).toBe('NON_RETRYABLE');
        expect(failure.reason).toContain('unexpected network error');
    });

    it('prázdný batch vrátí prázdný výsledek beze zpracování', async () => {
        const result = await runBatchWithIsolation<PriceDiffItem, string>([], async (item) => ({
            kind: 'SUCCESS',
            item,
            result: 'unreachable',
        }));

        expect(result.totalCount).toBe(0);
        expect(result.successes).toHaveLength(0);
        expect(result.failures).toHaveLength(0);
        expect(result.verificationFailures).toHaveLength(0);
    });
});

describe('runBatchWithIsolation — chunking (jeden chunk selže, další pokračují)', () => {
    it('selhání celého chunku (systémová chyba) nezastaví zpracování dalších chunků', async () => {
        const items: PriceDiffItem[] = [
            { code: 'A', newPrice: 1 }, { code: 'B', newPrice: 2 }, // chunk 1 -- oba selžou
            { code: 'C', newPrice: 3 }, { code: 'D', newPrice: 4 }, // chunk 2 -- oba uspějí
        ];

        const result = await runBatchWithIsolation(
            items,
            async (item): Promise<ItemOutcome<PriceDiffItem, string>> => {
                if (item.code === 'A' || item.code === 'B') {
                    throw new Error(`chunk 1 systémová chyba: ${item.code}`);
                }
                return { kind: 'SUCCESS', item, result: 'ok' };
            },
            { chunkSize: 2 }
        );

        expect(result.successes.map((s) => s.item.code)).toEqual(['C', 'D']);
        expect(result.failures.map((f) => f.item.code)).toEqual(['A', 'B']);
    });
});

describe('runBatchWithIsolation — reprodukce PricelistWriter vzoru (pricelist-writer.ts:29-208)', () => {
    /**
     * Reprodukuje klíčový bug/fix z produkce (INC-010, 2026-08-14/15):
     * Shoptet umí vrátit HTTP 200 (write "úspěšný") a přesto nic reálně
     * nezapsat -- VERIFICATION_FAILURE je oddělená kategorie od FAILURE,
     * protože write samotný neselhal, ale post-write verifikace zjistila
     * nesoulad. Volající (successfulDiffs v produkci) nesmí tohle sloučit
     * s prostým úspěchem, jinak hrozí cache poisoning (:195-197 komentář).
     */
    it('rozlišuje SUCCESS (verifikovaný zápis) od VERIFICATION_FAILURE (tichý no-op)', async () => {
        const items: PriceDiffItem[] = [
            { code: '93280', newPrice: 199.9 }, // "tiše no-op" -- HTTP 200, ale hodnota se nezapsala
            { code: '93281', newPrice: 149.5 }, // opravdu zapsáno a verifikováno
        ];

        const result = await runBatchWithIsolation(items, async (item): Promise<ItemOutcome<PriceDiffItem, string>> => {
            // Simulace: "write" vždy vrátí HTTP 200 bez chyby, ale skutečná
            // hodnota v cíli (simulovaná) se liší pro 93280.
            const actualValueAfterWrite = item.code === '93280' ? null : String(item.newPrice);

            if (actualValueAfterWrite !== String(item.newPrice)) {
                return {
                    kind: 'VERIFICATION_FAILURE',
                    item,
                    expected: String(item.newPrice),
                    actual: actualValueAfterWrite,
                };
            }
            return { kind: 'SUCCESS', item, result: `verified ${item.newPrice}` };
        });

        expect(result.successes).toHaveLength(1);
        expect(result.successes[0]!.item.code).toBe('93281');

        expect(result.verificationFailures).toHaveLength(1);
        const verificationFailure = result.verificationFailures[0]!;
        expect(verificationFailure.item.code).toBe('93280');
        expect(verificationFailure.expected).toBe('199.9');
        expect(verificationFailure.actual).toBeNull();

        // Klíčový invariant: 93280 NENÍ ve `failures` (write neselhal) ani
        // v `successes` (hodnota není potvrzená) -- jen ve verificationFailures.
        expect(result.failures).toHaveLength(0);
    });
});
