// IntentExecutor -- P1 Execution vrstva (core/canonical/outcomes/).
//
// CO SE TU TESTUJE PŘEDEVŠÍM: rozdíl mezi FAILED a UNKNOWN.
// Není to akademické rozlišení -- `isRetrySafe` na něm stojí, a špatná
// odpověď znamená duplicitní fakturu v Omeze (nededuplikuje) nebo dvojí
// odečet kreditu. Většina testů níž je proto o tom, že se nejistota
// NESMÍ zamaskovat jako selhání.

import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
    interpretWriteResult,
    nextIntentState,
    isRetrySafe,
    executeIntent,
    type ConnectorSemantics,
    type RawWriteResult,
} from '../../core/canonical/outcomes/IntentExecutor.js';
import {
    canTransitionIntent,
    isTerminalIntentState,
    requiresReconciliation,
    type ExecutionIntent,
} from '../../core/canonical/outcomes/ExecutionIntent.js';

/** Pohoda mServer: strojová odpověď, server-side dedup. */
const POHODA: ConnectorSemantics = {
    confirmationQuality: 'SYSTEM_CONFIRMED',
    supportsIdempotency: true,
    isDefiniteFailure: (e) => e.includes('validation') || e.includes('400'),
};

/** Omega .bat agent: úspěch z logu regexem, ŽÁDNÁ deduplikace. */
const OMEGA: ConnectorSemantics = {
    confirmationQuality: 'LOG_INFERRED',
    supportsIdempotency: false,
    isDefiniteFailure: (e) => e.includes('invalid input'),
};

function makeIntent(overrides: Partial<ExecutionIntent> = {}): ExecutionIntent {
    return {
        id: 'intent-1',
        tenantId: 'tenant-abc',
        createdAt: '2026-09-07T00:00:00Z',
        updatedAt: '2026-09-07T00:00:00Z',
        decisionId: 'decision-1',
        domain: 'pricing',
        connectorType: 'shoptet',
        operation: 'UPDATE_PRICE',
        targetRef: 'product-123',
        payload: { price: 199 },
        expectedState: { price: 199 },
        // EXECUTING, ne PLANNED: `executeIntent` provádí Intent, který už
        // byl PERZISTOVANĚ nárokovaný přes `claimForExecution`. Kdyby
        // přijímal PLANNED a přechod dělal sám, obešel by atomický claim
        // a dva paralelní běhy by mohly zapsat dvakrát.
        state: 'EXECUTING',
        idempotencyKey: 'pricing:UPDATE_PRICE:product-123:decision-1',
        attempt: 1,
        ...overrides,
    };
}

describe('interpretWriteResult -- rozlišení FAILED vs UNKNOWN', () => {
    it('reference bez chyby = EXECUTED s kvalitou potvrzení konektoru', () => {
        const r = interpretWriteResult({ externalReference: 'doc-42' }, POHODA);

        expect(r.outcome).toBe('EXECUTED');
        if (r.outcome === 'EXECUTED') {
            expect(r.confirmationQuality).toBe('SYSTEM_CONFIRMED');
            expect(r.executionReference).toBe('doc-42');
        }
    });

    it('rozpoznaná trvalá chyba = FAILED, retryable (nic se nezapsalo)', () => {
        const r = interpretWriteResult({ error: 'validation failed: missing VAT' }, POHODA);

        expect(r.outcome).toBe('FAILED');
        if (r.outcome === 'FAILED') expect(r.retryable).toBe(true);
    });

    it('NEROZPOZNANÁ chyba = UNKNOWN, nikdy FAILED', () => {
        // Fail-closed směrem k nejistotě: konektor netvrdí, že se nic
        // nezapsalo, takže se to nesmí předpokládat.
        const r = interpretWriteResult({ error: 'connection reset by peer' }, POHODA);

        expect(r.outcome).toBe('UNKNOWN');
    });

    it('timeout u Omegy = UNKNOWN -- tohle je ten případ z produkce', () => {
        const r = interpretWriteResult({ error: 'process killed after timeout' }, OMEGA);

        expect(r.outcome).toBe('UNKNOWN');
    });

    it('chyba MÁ PŘEDNOST před referencí -- částečný úspěch není úspěch', () => {
        // INC-016: Shoptet vrátí 200 OK, ale jednotlivé položky uvnitř
        // neuspějí. Konektor vrátí obojí; číst to jako úspěch by znamenalo
        // tvrdit, že se zapsalo něco, co se nezapsalo.
        const r = interpretWriteResult(
            { externalReference: 'batch-7', error: 'partial: 3 of 10 items rejected' },
            POHODA,
        );

        expect(r.outcome).not.toBe('EXECUTED');
        expect(r.outcome).toBe('UNKNOWN');
    });

    it('LOG_INFERRED konektor, který mlčí (ani reference, ani chyba) = UNKNOWN', () => {
        // Omega: log neobsahuje ani úspěch, ani chybu. Nevíme nic.
        const r = interpretWriteResult({}, OMEGA);

        expect(r.outcome).toBe('UNKNOWN');
    });

    it('SYSTEM_CONFIRMED konektor bez reference = EXECUTED (D1 vrací changes, ne id)', () => {
        // Ne každý strojově potvrzující zápis vrací identifikátor --
        // D1 UPDATE vrátí `meta.changes`, žádnou referenci.
        const r = interpretWriteResult({}, POHODA);

        expect(r.outcome).toBe('EXECUTED');
    });

    it('prázdný string v error se nepočítá jako chyba', () => {
        const r = interpretWriteResult({ externalReference: 'x', error: '' }, POHODA);

        expect(r.outcome).toBe('EXECUTED');
    });
});

describe('isRetrySafe -- ochrana proti duplicitní faktuře', () => {
    it('UNKNOWN u systému BEZ idempotence (Omega) = retry ZAKÁZÁN', () => {
        // Tohle je jádro celé vrstvy. Slepý retry tady vyrobí druhou fakturu.
        const r = interpretWriteResult({ error: 'timeout' }, OMEGA);

        expect(isRetrySafe(r, OMEGA)).toBe(false);
    });

    it('UNKNOWN u systému S idempotencí (Pohoda) = retry povolen', () => {
        const r = interpretWriteResult({ error: 'connection reset' }, POHODA);

        expect(isRetrySafe(r, POHODA)).toBe(true);
    });

    it('FAILED s retryable = retry povolen i u systému bez idempotence', () => {
        // Prokazatelně se nic nezapsalo -> duplicita nehrozí.
        const r = interpretWriteResult({ error: 'invalid input' }, OMEGA);

        expect(r.outcome).toBe('FAILED');
        expect(isRetrySafe(r, OMEGA)).toBe(true);
    });

    it('EXECUTED = retry zakázán', () => {
        const r = interpretWriteResult({ externalReference: 'ok' }, POHODA);

        expect(isRetrySafe(r, POHODA)).toBe(false);
    });
});

describe('executeIntent -- provedení a mapování stavu', () => {
    it('úspěšný zápis -> EXECUTED, retry zakázán', async () => {
        const out = await executeIntent(makeIntent(), POHODA, async () => ({
            externalReference: 'doc-1',
        }));

        expect(out.nextState).toBe('EXECUTED');
        expect(out.retrySafe).toBe(false);
        expect(out.confirmationQuality).toBe('SYSTEM_CONFIRMED');
    });

    it('VÝJIMKA při zápisu = UNKNOWN, NIKDY FAILED', async () => {
        // Request mohl odejít a odpověď se ztratit. Vyhodnotit to jako
        // "nezapsalo se" je nejnebezpečnější možná interpretace.
        const out = await executeIntent(makeIntent(), OMEGA, async () => {
            throw new Error('socket hang up');
        });

        expect(out.result.outcome).toBe('UNKNOWN');
        expect(out.nextState).toBe('UNKNOWN');
        // Omega nededuplikuje -> retry zakázán, musí přijít reconciliace.
        expect(out.retrySafe).toBe(false);
    });

    it('výjimka u systému s idempotencí retry povolí', async () => {
        const out = await executeIntent(makeIntent(), POHODA, async () => {
            throw new Error('socket hang up');
        });

        expect(out.result.outcome).toBe('UNKNOWN');
        expect(out.retrySafe).toBe(true);
    });

    it('Intent v terminálním stavu se odmítne provést', async () => {
        await expect(
            executeIntent(makeIntent({ state: 'EXECUTED' }), POHODA, async () => ({
                externalReference: 'x',
            })),
        ).rejects.toThrow(/jen Intent ve stavu EXECUTING/);
    });

    it('NENÁROKOVANÝ Intent (PLANNED) se odmítne provést', async () => {
        // Kdyby executeIntent přijal PLANNED a přechod udělal sám, obešel
        // by atomický claim ve store -- a dva paralelní běhy by zapsaly
        // do vnějšího systému dvakrát.
        await expect(
            executeIntent(makeIntent({ state: 'PLANNED' }), POHODA, async () => ({
                externalReference: 'x',
            })),
        ).rejects.toThrow(/claimForExecution/);
    });

    it('actualState se čte jen při úspěchu, ne po chybě', async () => {
        let readCount = 0;
        const read = async () => {
            readCount += 1;
            return { price: 199 };
        };

        await executeIntent(makeIntent(), POHODA, async () => ({ error: 'timeout' }), read);
        expect(readCount).toBe(0);

        await executeIntent(makeIntent(), POHODA, async () => ({ externalReference: 'ok' }), read);
        expect(readCount).toBe(1);
    });

    it('selhání čtení actualState nezpochybní úspěšný zápis', async () => {
        const out = await executeIntent(
            makeIntent(),
            POHODA,
            async () => ({ externalReference: 'ok' }),
            async () => {
                throw new Error('read failed');
            },
        );

        expect(out.nextState).toBe('EXECUTED');
    });
});

describe('ExecutionIntent -- stavový model', () => {
    it('UNKNOWN NENÍ terminální -- reconciliace ho musí umět dorovnat', () => {
        // Kdyby byl terminální, nejistota by v datech zůstala navždy.
        expect(isTerminalIntentState('UNKNOWN')).toBe(false);
        expect(canTransitionIntent('UNKNOWN', 'EXECUTED')).toBe(true);
        expect(canTransitionIntent('UNKNOWN', 'FAILED')).toBe(true);
    });

    it('FAILED není terminální -- retry téhož Intentu je legitimní', () => {
        expect(isTerminalIntentState('FAILED')).toBe(false);
        expect(canTransitionIntent('FAILED', 'EXECUTING')).toBe(true);
    });

    it('EXECUTED je terminální, žádný přechod ven', () => {
        expect(isTerminalIntentState('EXECUTED')).toBe(true);
        expect(canTransitionIntent('EXECUTED', 'EXECUTING')).toBe(false);
        expect(canTransitionIntent('EXECUTED', 'FAILED')).toBe(false);
    });

    it('fail-closed: nedeklarovaný přechod je zakázaný', () => {
        expect(canTransitionIntent('PLANNED', 'EXECUTED')).toBe(false);
        expect(canTransitionIntent('ABANDONED', 'EXECUTING')).toBe(false);
    });

    it('dry-run: PLANNED -> ABANDONED bez provedení', () => {
        expect(canTransitionIntent('PLANNED', 'ABANDONED')).toBe(true);
    });
});

describe('requiresReconciliation', () => {
    it('UNKNOWN vyžaduje reconciliaci', () => {
        expect(requiresReconciliation({ state: 'UNKNOWN' })).toBe(true);
    });

    it('EXECUTED s LOG_INFERRED vyžaduje reconciliaci -- potvrzení je odvozené', () => {
        // Omega "úspěch" je regex nad logem. Bez ověření to není fakt.
        expect(
            requiresReconciliation({ state: 'EXECUTED', confirmationQuality: 'LOG_INFERRED' }),
        ).toBe(true);
    });

    it('EXECUTED se SYSTEM_CONFIRMED reconciliaci nepotřebuje', () => {
        expect(
            requiresReconciliation({ state: 'EXECUTED', confirmationQuality: 'SYSTEM_CONFIRMED' }),
        ).toBe(false);
    });
});

describe('nextIntentState -- mapování výsledku na stav', () => {
    it('mapuje všechny tři outcomes', () => {
        expect(nextIntentState({ outcome: 'EXECUTED', confirmationQuality: 'SYSTEM_CONFIRMED', actualState: null })).toBe('EXECUTED');
        expect(nextIntentState({ outcome: 'FAILED', retryable: true, reason: 'x' })).toBe('FAILED');
        expect(nextIntentState({ outcome: 'UNKNOWN', reason: 'x' })).toBe('UNKNOWN');
    });
});

describe('Intent nese peníze jako Decimal, ne float', () => {
    it('payload s Decimal projde beze změny hodnoty', async () => {
        const intent = makeIntent({
            payload: { priceMinor: new Decimal('199.99') },
        }) as ExecutionIntent<{ priceMinor: Decimal }>;

        let seen: Decimal | undefined;
        await executeIntent(intent, POHODA, async (p) => {
            seen = p.priceMinor;
            return { externalReference: 'ok' };
        });

        expect(seen?.toString()).toBe('199.99');
    });
});
