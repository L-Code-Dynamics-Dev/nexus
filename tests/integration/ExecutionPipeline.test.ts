// Execution pipeline -- integrační test celého řetězu P1.
//
// Řetěz z core/canonical/reconciliation/Reconciliation.ts:
//   DECISION -> EXPECTED -> EXECUTION -> ACTUAL -> RECONCILIATION
//
// Jednotkové testy ověřují každý díl zvlášť. Tenhle soubor ověřuje, že
// SPOLU DRŽÍ -- a hlavně, že projdou scénáře, kvůli kterým vrstva vznikla:
//
//   1. Zápis se povedl, ale my se to nedozvěděli (timeout po odeslání).
//      Bez Execution vrstvy by následoval slepý retry a dvojí zápis.
//   2. Omega hlásila úspěch z logu, ale nic nezapsala (tiché selhání).
//      Bez reconciliace LOG_INFERRED by se to nikdy nenašlo.
//   3. Cenu mezitím přepsal někdo ručně v administraci.
//      Automatická oprava by jeho zásah přemazala.

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryExecutionIntentStore } from '../../core/canonical/outcomes/ExecutionIntentStore.js';
import { executeIntent, type ConnectorSemantics } from '../../core/canonical/outcomes/IntentExecutor.js';
import { reconcileIntent } from '../../core/canonical/outcomes/IntentReconciliation.js';
import {
    ShoptetPriceConnector,
    SHOPTET_PRICE_SEMANTICS,
    type CanonicalProductPrice,
} from '../../connectors/shoptet/ShoptetPriceConnector.js';
import type { TenantContext } from '../../core/tenant/types.js';
import type { ExecutionIntent } from '../../core/canonical/outcomes/ExecutionIntent.js';

const TENANT: TenantContext = { tenantId: 'okfish', platform: 'shoptet' };
const T0 = '2026-09-07T04:00:00Z';
const T1 = '2026-09-07T04:00:30Z';
const T2 = '2026-09-07T04:01:00Z';

interface PriceState {
    readonly priceMinor: number;
}

/** Cena, kterou pricing spočítal. Ve skutečnosti přichází z Decision. */
const DECIDED_PRICE: CanonicalProductPrice = {
    productCode: '93683',
    tierKey: 'ZR25',
    priceMinor: 1121,
    currency: 'EUR',
};

const PRICE_BEFORE: PriceState = { priceMinor: 1271 };
const PRICE_EXPECTED: PriceState = { priceMinor: 1121 };

const matchesPrice = (a: PriceState, b: PriceState): boolean => a.priceMinor === b.priceMinor;

/** Omega: úspěch se odvozuje z logu, žádná deduplikace. */
const OMEGA_SEMANTICS: ConnectorSemantics = {
    confirmationQuality: 'LOG_INFERRED',
    supportsIdempotency: false,
    isDefiniteFailure: (e) => e.includes('invalid input'),
};

describe('Execution pipeline -- plán → provedení → reconciliace', () => {
    let store: InMemoryExecutionIntentStore;
    let connector: ShoptetPriceConnector;

    beforeEach(() => {
        store = new InMemoryExecutionIntentStore();
        connector = new ShoptetPriceConnector('shoptet-okfish', { ZR4: 1, ZR20: 20, ZR25: 25 });
    });

    async function planPriceIntent(id = 'intent-price-1') {
        const write = connector.buildWritePayload(DECIDED_PRICE);
        return store.plan(TENANT, {
            id,
            decisionId: 'decision-pricing-1',
            domain: 'pricing',
            connectorType: 'shoptet',
            operation: 'UPDATE_PRICE',
            targetRef: DECIDED_PRICE.productCode,
            payload: write,
            expectedState: PRICE_EXPECTED,
            idempotencyKey: `pricing:UPDATE_PRICE:${DECIDED_PRICE.productCode}:decision-pricing-1`,
            plannedAt: T0,
        });
    }

    it('šťastná cesta: naplánovat → nárokovat → zapsat → potvrdit', async () => {
        const { intent } = await planPriceIntent();
        expect(intent.state).toBe('PLANNED');

        const claim = await store.claimForExecution(TENANT, intent.id, T1);
        expect(claim.outcome).toBe('CLAIMED');
        if (claim.outcome !== 'CLAIMED') return;

        const out = await executeIntent(claim.intent, SHOPTET_PRICE_SEMANTICS, async () => ({
            externalReference: 'shoptet-patch-1',
        }));

        expect(out.nextState).toBe('EXECUTED');
        await store.recordOutcome(TENANT, {
            intentId: intent.id,
            nextState: out.nextState,
            confirmationQuality: out.confirmationQuality,
            recordedAt: T2,
        });

        // Shoptet je SYSTEM_CONFIRMED -> reconciliaci nepotřebuje.
        expect(await store.findRequiringReconciliation('okfish', 10)).toHaveLength(0);
    });

    it('dry-run: Intent se naplánuje a zahodí, nikam se nezapíše', async () => {
        // Tohle je master rule "dry-run first" vyjádřená typem, ne konvencí.
        const { intent } = await planPriceIntent();

        await store.recordOutcome(TENANT, {
            intentId: intent.id,
            nextState: 'ABANDONED',
            recordedAt: T1,
        });

        const after = await store.findById('okfish', intent.id);
        expect(after?.state).toBe('ABANDONED');
        expect(await store.findPending('okfish', 10)).toHaveLength(0);
    });

    it('SCÉNÁŘ 1 -- timeout po odeslání: UNKNOWN, retry ZAKÁZÁN, reconciliace potvrdí', async () => {
        // Zápis se povedl, ale odpověď se ztratila. Bez Execution vrstvy
        // by následoval slepý retry a cena by se zapsala dvakrát.
        const { intent } = await planPriceIntent();
        const claim = await store.claimForExecution(TENANT, intent.id, T1);
        if (claim.outcome !== 'CLAIMED') throw new Error('claim failed');

        const out = await executeIntent(claim.intent, SHOPTET_PRICE_SEMANTICS, async () => {
            throw new Error('network timeout after 30s');
        });

        expect(out.result.outcome).toBe('UNKNOWN');
        // Shoptet nemá server-side dedup -> retry se nesmí.
        expect(out.retrySafe).toBe(false);

        await store.recordOutcome(TENANT, {
            intentId: intent.id,
            nextState: 'UNKNOWN',
            failureReason: 'network timeout',
            recordedAt: T2,
        });

        // Intent je ve frontě nejistot.
        const queue = await store.findRequiringReconciliation('okfish', 10);
        expect(queue.map((i) => i.id)).toContain(intent.id);

        // Reconciliace zjistí, že zápis PROBĚHL -- nejistota se rozřeší.
        const verdict = await reconcileIntent(
            queue[0] as ExecutionIntent<unknown, PriceState>,
            async () => ({ found: true, state: PRICE_EXPECTED }),
            matchesPrice,
            PRICE_BEFORE,
        );

        expect(verdict.verdict).toBe('CONFIRMED');
        expect(verdict.nextState).toBe('EXECUTED');

        await store.recordOutcome(TENANT, {
            intentId: intent.id,
            nextState: 'EXECUTED',
            confirmationQuality: 'SYSTEM_CONFIRMED',
            recordedAt: '2026-09-07T04:05:00Z',
        });
        expect(await store.findRequiringReconciliation('okfish', 10)).toHaveLength(0);
    });

    it('SCÉNÁŘ 1b -- timeout a zápis NEPROBĚHL: reconciliace to pozná, retry se povolí', async () => {
        const { intent } = await planPriceIntent();
        const claim = await store.claimForExecution(TENANT, intent.id, T1);
        if (claim.outcome !== 'CLAIMED') throw new Error('claim failed');

        await store.recordOutcome(TENANT, {
            intentId: intent.id,
            nextState: 'UNKNOWN',
            failureReason: 'timeout',
            recordedAt: T2,
        });

        const queue = await store.findRequiringReconciliation('okfish', 10);
        const verdict = await reconcileIntent(
            queue[0] as ExecutionIntent<unknown, PriceState>,
            // Cena je pořád původní -> nic se nezapsalo.
            async () => ({ found: true, state: PRICE_BEFORE }),
            matchesPrice,
            PRICE_BEFORE,
        );

        expect(verdict.verdict).toBe('NOT_EXECUTED');
        expect(verdict.nextState).toBe('FAILED');

        // Teď je retry bezpečný -- a Intent se dá nárokovat znovu.
        await store.recordOutcome(TENANT, {
            intentId: intent.id,
            nextState: 'FAILED',
            failureReason: 'reconciliace: zápis neproběhl',
            recordedAt: '2026-09-07T04:05:00Z',
        });

        const retry = await store.claimForExecution(TENANT, intent.id, '2026-09-07T04:06:00Z');
        expect(retry.outcome).toBe('CLAIMED');
        if (retry.outcome === 'CLAIMED') {
            expect(retry.intent.attempt).toBe(2);
        }
    });

    it('SCÉNÁŘ 2 -- Omega hlásila úspěch z logu, ale NIC NEZAPSALA', async () => {
        // Tiché selhání. Bez reconciliace LOG_INFERRED by se nikdy nenašlo.
        const { intent } = await store.plan(TENANT, {
            id: 'intent-omega-1',
            decisionId: 'decision-invoice-1',
            domain: 'omega',
            connectorType: 'omega',
            operation: 'ISSUE_DOCUMENT',
            targetRef: 'invoice-2026-001',
            payload: { doc: 'R01' },
            expectedState: { priceMinor: 1121 },
            idempotencyKey: 'omega:ISSUE_DOCUMENT:invoice-2026-001:decision-invoice-1',
            plannedAt: T0,
        });

        const claim = await store.claimForExecution(TENANT, intent.id, T1);
        if (claim.outcome !== 'CLAIMED') throw new Error('claim failed');

        // Log obsahoval řetězec, který vypadal jako potvrzení.
        const out = await executeIntent(claim.intent, OMEGA_SEMANTICS, async () => ({
            externalReference: 'log-line-4821',
        }));

        expect(out.nextState).toBe('EXECUTED');
        expect(out.confirmationQuality).toBe('LOG_INFERRED');

        await store.recordOutcome(TENANT, {
            intentId: intent.id,
            nextState: 'EXECUTED',
            confirmationQuality: 'LOG_INFERRED',
            executionReference: 'log-line-4821',
            recordedAt: T2,
        });

        // KLÍČOVÉ: i "úspěšný" Omega zápis je ve frontě k ověření.
        const queue = await store.findRequiringReconciliation('okfish', 10);
        expect(queue.map((i) => i.id)).toContain(intent.id);

        // A ověření odhalí, že se nic nezapsalo.
        const verdict = await reconcileIntent(
            queue[0] as ExecutionIntent<unknown, PriceState>,
            async () => ({ found: false }),
            matchesPrice,
        );

        expect(verdict.verdict).toBe('TARGET_MISSING');
        expect(verdict.needsManualReview).toBe(true);
    });

    it('SCÉNÁŘ 3 -- cenu mezitím přepsal člověk: DIVERGED, automatika nesahá', async () => {
        const { intent } = await planPriceIntent();
        const claim = await store.claimForExecution(TENANT, intent.id, T1);
        if (claim.outcome !== 'CLAIMED') throw new Error('claim failed');

        await store.recordOutcome(TENANT, {
            intentId: intent.id,
            nextState: 'UNKNOWN',
            failureReason: 'timeout',
            recordedAt: T2,
        });

        const queue = await store.findRequiringReconciliation('okfish', 10);
        const verdict = await reconcileIntent(
            queue[0] as ExecutionIntent<unknown, PriceState>,
            // Ani očekávaná, ani původní cena -- někdo sáhl do administrace.
            async () => ({ found: true, state: { priceMinor: 999 } }),
            matchesPrice,
            PRICE_BEFORE,
        );

        expect(verdict.verdict).toBe('DIVERGED');
        // Stav se NEMĚNÍ a jde to na člověka. Automatická oprava by
        // přepsala cizí zásah.
        expect(verdict.nextState).toBeUndefined();
        expect(verdict.needsManualReview).toBe(true);
    });

    it('idempotence: dvojí naplánování téhož zápisu nevyrobí dva Intenty', async () => {
        const first = await planPriceIntent('intent-a');
        const second = await planPriceIntent('intent-b');

        expect(second.alreadyPlanned).toBe(true);
        expect(second.intent.id).toBe(first.intent.id);
        expect(await store.findPending('okfish', 10)).toHaveLength(1);
    });

    it('konektor je jen překladač -- cenu nepočítá, jen ji přenese', async () => {
        // Kdyby konektor cenu upravoval, byla by business logika na dvou
        // místech a shadow parita by ztratila smysl.
        const write = connector.buildWritePayload(DECIDED_PRICE);

        expect(write.body).toEqual({ pricelists: [{ id: 25, price: '11.21' }] });
        // 1121 haléřů dovnitř, "11.21" ven -- žádný přepočet.
        expect(connector.toCanonical({
            code: '93683',
            pricelistId: 25,
            price: '11.21',
            currency: 'EUR',
        }).priceMinor).toBe(1121);
    });
});
