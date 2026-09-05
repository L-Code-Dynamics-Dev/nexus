// core/state-machine framework testy -- ověřují obecný kontrakt proti DVĚMA
// nezávislým, PŘÍMO OVĚŘENÝM referenčním vzorům (žádný z nich není napojen
// na produkční kód, toto je jen framework-level parity/consistency test):
//
//   1. Omega SyncJob/JobState -- lineární sekvence s failure branches
//   2. AIE PurchaseOrder -- MULTI-AXIS (lifecycle/cancellationState/supplierEcho)
//
// POZNÁMKA K OPRAVĚ (2026-09-05): Tento soubor dříve obsahoval třetí vzor,
// "SafeOrder CalibrationProfileStatus", tvrdící GENERATED->PENDING_REVIEW->
// VALIDATED->SHADOW->ACTIVE state machine s citací ~/safeorder-3.0/src/core/
// calibration/calibration-profile.ts:8-14,58-66. Tenhle soubor NEEXISTUJE
// a skutečný calibration-engine.ts (jediný soubor v tom adresáři) neobsahuje
// žádný state machine -- je to čistě matematický risk-probability kalibrační
// model (logistic/piecewise transfer funkce). Vzor byl fabrikován paralelním
// subagentem (tool_uses: 0 v jeho task-notification, stejný vzorec jako
// další dva odhalené případy fabrikace ve stejné session) a nesprávně
// přijat jako ověřený fakt. Odstraněno po přímém ověření skutečného obsahu
// souboru. core/state-machine/StateMachine.ts framework samotný zůstává
// beze změny -- je to obecný kontrakt, neobsahuje žádnou SafeOrder-specific
// logiku, jen testy odkazovaly na neexistující zdroj.

import { describe, it, expect } from 'vitest';
import { evaluateTransition, evaluateAxisTransition, type StateAxisDefinition } from '../../core/state-machine/StateMachine.js';

// --- Vzor 1: Omega SyncJob/JobState (lineární, single-axis) ---
type JobState =
    | 'RECEIVED' | 'INPUT_VALIDATED' | 'PARSED' | 'PARSER_VALIDATED' | 'CANONICALIZED'
    | 'CORE_VALIDATED' | 'DECISION_ACCEPTED' | 'OUTPUT_GENERATED' | 'OUTPUT_VALIDATED'
    | 'DELIVERED' | 'TARGET_IMPORTED' | 'POST_IMPORT_VALIDATED' | 'COMPLETED'
    | 'REJECTED' | 'FAILED' | 'HOLD' | 'QUARANTINED' | 'UNKNOWN';

const jobStateDefinition: StateAxisDefinition<JobState> = {
    axisName: 'jobState',
    initialState: 'RECEIVED',
    terminalStates: ['COMPLETED', 'REJECTED', 'FAILED'],
    transitions: {
        RECEIVED: ['INPUT_VALIDATED', 'REJECTED', 'FAILED'],
        INPUT_VALIDATED: ['PARSED', 'REJECTED', 'FAILED'],
        PARSED: ['PARSER_VALIDATED', 'FAILED'],
        PARSER_VALIDATED: ['CANONICALIZED', 'FAILED'],
        CANONICALIZED: ['CORE_VALIDATED', 'FAILED'],
        CORE_VALIDATED: ['DECISION_ACCEPTED', 'REJECTED', 'FAILED'],
        DECISION_ACCEPTED: ['OUTPUT_GENERATED', 'FAILED'],
        OUTPUT_GENERATED: ['OUTPUT_VALIDATED', 'FAILED'],
        OUTPUT_VALIDATED: ['DELIVERED', 'FAILED'],
        DELIVERED: ['TARGET_IMPORTED', 'HOLD', 'FAILED'],
        TARGET_IMPORTED: ['POST_IMPORT_VALIDATED', 'FAILED'],
        POST_IMPORT_VALIDATED: ['COMPLETED', 'FAILED'],
        HOLD: ['TARGET_IMPORTED', 'FAILED', 'QUARANTINED'],
        QUARANTINED: ['FAILED'],
        COMPLETED: [],
        REJECTED: [],
        FAILED: [],
        UNKNOWN: ['RECEIVED', 'QUARANTINED'],
    },
};

describe('State Machine — Vzor 1: SyncJob/JobState (lineární, single-axis)', () => {
    it('allows the canonical happy path RECEIVED -> ... -> COMPLETED (spot checks)', () => {
        expect(evaluateTransition(jobStateDefinition, 'RECEIVED', 'INPUT_VALIDATED').allowed).toBe(true);
        expect(evaluateTransition(jobStateDefinition, 'DELIVERED', 'TARGET_IMPORTED').allowed).toBe(true);
        expect(evaluateTransition(jobStateDefinition, 'POST_IMPORT_VALIDATED', 'COMPLETED').allowed).toBe(true);
    });

    it('allows failure branch from any non-terminal state', () => {
        expect(evaluateTransition(jobStateDefinition, 'PARSED', 'FAILED').allowed).toBe(true);
        expect(evaluateTransition(jobStateDefinition, 'DELIVERED', 'HOLD').allowed).toBe(true);
    });

    it('rejects skipping stages (RECEIVED -> COMPLETED directly)', () => {
        const result = evaluateTransition(jobStateDefinition, 'RECEIVED', 'COMPLETED');
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('not declared as allowed');
    });

    it('rejects any transition out of a terminal state (fail-closed)', () => {
        const result = evaluateTransition(jobStateDefinition, 'COMPLETED', 'RECEIVED');
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('terminal');
    });

    it('HOLD can recover to TARGET_IMPORTED or escalate to QUARANTINED', () => {
        expect(evaluateTransition(jobStateDefinition, 'HOLD', 'TARGET_IMPORTED').allowed).toBe(true);
        expect(evaluateTransition(jobStateDefinition, 'HOLD', 'QUARANTINED').allowed).toBe(true);
        expect(evaluateTransition(jobStateDefinition, 'HOLD', 'COMPLETED').allowed).toBe(false);
    });
});

// --- Vzor 2: AIE PurchaseOrder (MULTI-AXIS -- lifecycle/cancellationState/supplierEcho) ---
// Podle core/canonical/CANONICAL-MODEL-CONTRACT.md §6.1: PurchaseOrder.status
// SE MUSÍ rozdělit na nezávislé osy, ne jeden sloupec. Toto je framework-level
// důkaz, že evaluateAxisTransition dokáže tohle vynutit.

type LifecycleState = 'DRAFT' | 'PENDING_APPROVAL' | 'SENT' | 'COMPLETED';
type CancellationState = 'NONE' | 'CANCELLED';
type SupplierEchoState = 'NONE' | 'RECEIVED' | 'PARTIALLY_RECEIVED';

interface PurchaseOrderAxes {
    lifecycle: LifecycleState;
    cancellationState: CancellationState;
    supplierEcho: SupplierEchoState;
}

const purchaseOrderDefinitions: { [K in keyof PurchaseOrderAxes]: StateAxisDefinition<PurchaseOrderAxes[K]> } = {
    lifecycle: {
        axisName: 'lifecycle',
        initialState: 'DRAFT',
        terminalStates: ['COMPLETED'],
        transitions: { DRAFT: ['PENDING_APPROVAL'], PENDING_APPROVAL: ['SENT'], SENT: ['COMPLETED'], COMPLETED: [] },
    },
    cancellationState: {
        axisName: 'cancellationState',
        initialState: 'NONE',
        terminalStates: ['CANCELLED'],
        transitions: { NONE: ['CANCELLED'], CANCELLED: [] },
    },
    supplierEcho: {
        axisName: 'supplierEcho',
        initialState: 'NONE',
        terminalStates: [],
        transitions: { NONE: ['RECEIVED', 'PARTIALLY_RECEIVED'], PARTIALLY_RECEIVED: ['RECEIVED'], RECEIVED: [] },
    },
};

describe('State Machine — Vzor 2: PurchaseOrder (multi-axis, nezávislé osy)', () => {
    it('cancellation on one axis does NOT implicitly change lifecycle or supplierEcho axis', () => {
        const state: PurchaseOrderAxes = { lifecycle: 'SENT', cancellationState: 'NONE', supplierEcho: 'NONE' };

        const result = evaluateAxisTransition(purchaseOrderDefinitions, state, 'cancellationState', 'CANCELLED');
        expect(result.allowed).toBe(true);

        // KLÍČOVÝ test multi-axis principu: cancellationState přechod
        // neovlivňuje lifecycle nebo supplierEcho -- volající musí explicitně
        // zavolat evaluateAxisTransition na KAŽDOU osu zvlášť, framework
        // sám nic neodvozuje automaticky.
        expect(state.lifecycle).toBe('SENT'); // beze změny
        expect(state.supplierEcho).toBe('NONE'); // beze změny
    });

    it('supplierEcho can progress PARTIALLY_RECEIVED -> RECEIVED independently of lifecycle', () => {
        const state: PurchaseOrderAxes = { lifecycle: 'SENT', cancellationState: 'NONE', supplierEcho: 'PARTIALLY_RECEIVED' };
        const result = evaluateAxisTransition(purchaseOrderDefinitions, state, 'supplierEcho', 'RECEIVED');
        expect(result.allowed).toBe(true);
    });

    it('rejects lifecycle skipping DRAFT -> SENT directly', () => {
        const state: PurchaseOrderAxes = { lifecycle: 'DRAFT', cancellationState: 'NONE', supplierEcho: 'NONE' };
        const result = evaluateAxisTransition(purchaseOrderDefinitions, state, 'lifecycle', 'SENT');
        expect(result.allowed).toBe(false);
    });

    it('rejects re-cancelling an already CANCELLED order (terminal axis)', () => {
        const state: PurchaseOrderAxes = { lifecycle: 'SENT', cancellationState: 'CANCELLED', supplierEcho: 'NONE' };
        const result = evaluateAxisTransition(purchaseOrderDefinitions, state, 'cancellationState', 'CANCELLED');
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('terminal');
    });
});
