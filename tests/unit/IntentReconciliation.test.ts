// IntentReconciliation -- uzavření řetězu Execution vrstvy (P1).
//
// Těžiště testů:
//   1. UNKNOWN se DÁ rozřešit -- to je celý smysl vrstvy. Kdyby se nedal,
//      nejistota by v datech zůstala navždy.
//   2. DIVERGED se NEOPRAVUJE automaticky. Buď zasáhl někdo jiný, nebo se
//      zápis provedl částečně -- automatika by mohla přepsat něco, co tam
//      někdo dal schválně.
//   3. Nedostupný vnější systém není důkaz o ničem (UNVERIFIABLE), stav
//      Intentu se nemění a zkusí se později.

import { describe, it, expect } from 'vitest';
import {
    reconcileIntent,
    reconcileBatch,
    type ActualStateReader,
} from '../../core/canonical/outcomes/IntentReconciliation.js';
import type { ExecutionIntent } from '../../core/canonical/outcomes/ExecutionIntent.js';

interface PriceState {
    readonly priceMinor: number;
}

function makeIntent(
    overrides: Partial<ExecutionIntent<unknown, PriceState>> = {},
): ExecutionIntent<unknown, PriceState> {
    return {
        id: 'intent-1',
        tenantId: 'tenant-a',
        createdAt: '2026-09-07T04:00:00Z',
        updatedAt: '2026-09-07T04:00:00Z',
        decisionId: 'decision-1',
        domain: 'pricing',
        connectorType: 'shoptet',
        operation: 'UPDATE_PRICE',
        targetRef: 'product-93683',
        payload: {},
        expectedState: { priceMinor: 1121 },
        state: 'UNKNOWN',
        idempotencyKey: 'k1',
        attempt: 1,
        ...overrides,
    };
}

const matchesPrice = (a: PriceState, b: PriceState): boolean => a.priceMinor === b.priceMinor;

const readerReturning = (state: PriceState): ActualStateReader<PriceState> =>
    async () => ({ found: true, state });

describe('reconcileIntent -- rozřešení nejistoty', () => {
    it('skutečnost == očekávání → CONFIRMED, UNKNOWN se překlopí na EXECUTED', async () => {
        // Tohle je ten mechanismus, kvůli kterému UNKNOWN není terminální.
        const r = await reconcileIntent(
            makeIntent(),
            readerReturning({ priceMinor: 1121 }),
            matchesPrice,
        );

        expect(r.verdict).toBe('CONFIRMED');
        expect(r.nextState).toBe('EXECUTED');
        expect(r.needsManualReview).toBe(false);
    });

    it('skutečnost == stav před zápisem → NOT_EXECUTED, retry bezpečný', async () => {
        const r = await reconcileIntent(
            makeIntent(),
            readerReturning({ priceMinor: 1271 }),
            matchesPrice,
            { priceMinor: 1271 }, // stav před zápisem
        );

        expect(r.verdict).toBe('NOT_EXECUTED');
        expect(r.nextState).toBe('FAILED');
        expect(r.needsManualReview).toBe(false);
    });

    it('skutečnost je něco třetího → DIVERGED, stav se NEMĚNÍ', async () => {
        // Někdo cenu upravil ručně v administraci, nebo se zápis provedl
        // částečně. Automatická oprava by přepsala cizí zásah.
        const r = await reconcileIntent(
            makeIntent(),
            readerReturning({ priceMinor: 999 }),
            matchesPrice,
            { priceMinor: 1271 },
        );

        expect(r.verdict).toBe('DIVERGED');
        expect(r.nextState).toBeUndefined();
        expect(r.needsManualReview).toBe(true);
    });

    it('bez stavu před zápisem se NOT_EXECUTED nerozliší → DIVERGED (fail-closed)', async () => {
        const r = await reconcileIntent(
            makeIntent(),
            readerReturning({ priceMinor: 1271 }),
            matchesPrice,
        );

        expect(r.verdict).toBe('DIVERGED');
        expect(r.needsManualReview).toBe(true);
    });

    it('cíl neexistuje → TARGET_MISSING, ruční kontrola', async () => {
        const r = await reconcileIntent(
            makeIntent(),
            async () => ({ found: false }),
            matchesPrice,
        );

        expect(r.verdict).toBe('TARGET_MISSING');
        expect(r.needsManualReview).toBe(true);
    });

    it('nedostupný vnější systém → UNVERIFIABLE, stav se NEMĚNÍ', async () => {
        // Nedostupnost není důkaz o ničem. Intent zůstane ve frontě.
        const r = await reconcileIntent(
            makeIntent(),
            async () => {
                throw new Error('connection refused');
            },
            matchesPrice,
        );

        expect(r.verdict).toBe('UNVERIFIABLE');
        expect(r.nextState).toBeUndefined();
        // Není to selhání vyžadující člověka -- jen se to opakuje později.
        expect(r.needsManualReview).toBe(false);
    });

    it('reconciliuje i EXECUTED s LOG_INFERRED -- Omega "úspěch" z logu není fakt', async () => {
        const r = await reconcileIntent(
            makeIntent({ state: 'EXECUTED', confirmationQuality: 'LOG_INFERRED' }),
            readerReturning({ priceMinor: 1121 }),
            matchesPrice,
        );

        expect(r.verdict).toBe('CONFIRMED');
    });

    it('odhalí TICHÉ SELHÁNÍ: Omega hlásila úspěch, ale nezapsala', async () => {
        // Přesně proto se LOG_INFERRED reconciliuje. Bez toho by se
        // tenhle případ nikdy nenašel.
        const r = await reconcileIntent(
            makeIntent({
                state: 'EXECUTED',
                confirmationQuality: 'LOG_INFERRED',
                connectorType: 'omega',
            }),
            readerReturning({ priceMinor: 1271 }),
            matchesPrice,
            { priceMinor: 1271 },
        );

        expect(r.verdict).toBe('NOT_EXECUTED');
        expect(r.nextState).toBe('FAILED');
    });

    it('doména si určuje, co je shoda -- tolerance místo exaktní rovnosti', async () => {
        // GenericReconciliation.classifyDrift: zaokrouhlovací šum není rozdíl.
        const withinCent = (a: PriceState, b: PriceState): boolean =>
            Math.abs(a.priceMinor - b.priceMinor) <= 1;

        const r = await reconcileIntent(
            makeIntent(),
            readerReturning({ priceMinor: 1122 }),
            withinCent,
        );

        expect(r.verdict).toBe('CONFIRMED');
    });
});

describe('reconcileBatch -- error isolation', () => {
    it('jedna neověřitelná položka NESHODÍ celý běh', async () => {
        // Master rule: 10 000 položek, 2 chyby -> běh dokončí a nahlásí,
        // nikdy "1 chyba -> STOP".
        const intents = [
            makeIntent({ id: 'i-1', targetRef: 'p1' }),
            makeIntent({ id: 'i-2', targetRef: 'BOOM' }),
            makeIntent({ id: 'i-3', targetRef: 'p3' }),
        ];

        const reader: ActualStateReader<PriceState> = async (intent) => {
            if (intent.targetRef === 'BOOM') throw new Error('connection refused');
            return { found: true, state: { priceMinor: 1121 } };
        };

        const summary = await reconcileBatch(intents, reader, matchesPrice);

        expect(summary.processed).toBe(3);
        expect(summary.confirmed).toBe(2);
        expect(summary.unverifiable).toBe(1);
    });

    it('spočítá všechny kategorie a položky k ruční kontrole', async () => {
        const intents = [
            makeIntent({ id: 'ok', targetRef: 'match' }),
            makeIntent({ id: 'div', targetRef: 'diverged' }),
            makeIntent({ id: 'gone', targetRef: 'missing' }),
        ];

        const reader: ActualStateReader<PriceState> = async (intent) => {
            if (intent.targetRef === 'missing') return { found: false };
            if (intent.targetRef === 'diverged') {
                return { found: true, state: { priceMinor: 777 } };
            }
            return { found: true, state: { priceMinor: 1121 } };
        };

        const summary = await reconcileBatch(intents, reader, matchesPrice);

        expect(summary.confirmed).toBe(1);
        expect(summary.diverged).toBe(1);
        expect(summary.targetMissing).toBe(1);
        // Nenulová hodnota = alert pro obsluhu.
        expect(summary.needsManualReview).toBe(2);
    });

    it('přeskočí Intenty, které reconciliaci nepotřebují', async () => {
        // Zbytečné volání na vnější systém je náklad, ne jen neefektivita.
        let reads = 0;
        const reader: ActualStateReader<PriceState> = async () => {
            reads += 1;
            return { found: true, state: { priceMinor: 1121 } };
        };

        const summary = await reconcileBatch(
            [
                makeIntent({ id: 'ok', state: 'EXECUTED', confirmationQuality: 'SYSTEM_CONFIRMED' }),
                makeIntent({ id: 'planned', state: 'PLANNED' }),
                makeIntent({ id: 'unknown', state: 'UNKNOWN' }),
            ],
            reader,
            matchesPrice,
        );

        expect(summary.processed).toBe(1);
        expect(reads).toBe(1);
    });

    it('prázdná fronta = prázdný souhrn, ne chyba', async () => {
        const summary = await reconcileBatch([], readerReturning({ priceMinor: 0 }), matchesPrice);

        expect(summary.processed).toBe(0);
        expect(summary.needsManualReview).toBe(0);
    });
});
