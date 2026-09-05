// OrderInvoiceOmegaFlow -- Fáze 6.4 business flow testy. Kompozice nad
// InvoiceLifecycleRule, žádná nová validace -- testy ověřují, že flow
// věrně deleguje na Rule (happy path + edge case dělení odpovědnosti).

import { describe, it, expect } from 'vitest';
import { evaluateOrderInvoiceOmegaFlow } from '../../domains/invoice/OrderInvoiceOmegaFlow.js';

const ctx = { tenantId: 'ten_1', ruleId: 'order-invoice-omega-flow-v1', ruleVersion: '1' };

describe('evaluateOrderInvoiceOmegaFlow', () => {
    it('povolí vystavení faktury (PENDING -> ISSUED) s orderId i omegaDocumentId', () => {
        const result = evaluateOrderInvoiceOmegaFlow(ctx, {
            orderId: 'order_1',
            currentInvoiceStatus: 'PENDING',
            targetInvoiceStatus: 'ISSUED',
            omegaDocumentId: 'omega_doc_1',
        });
        expect(result.allowed).toBe(true);
    });

    it('zamítne vystavení faktury bez omegaDocumentId ("bez účetního dokladu není faktura vystavená")', () => {
        const result = evaluateOrderInvoiceOmegaFlow(ctx, {
            orderId: 'order_1',
            currentInvoiceStatus: 'PENDING',
            targetInvoiceStatus: 'ISSUED',
        });
        expect(result.allowed).toBe(false);
        expect(result.reason).toMatch(/omegaDocumentId/i);
    });

    it('zamítne vystavení faktury s prázdným orderId', () => {
        const result = evaluateOrderInvoiceOmegaFlow(ctx, {
            orderId: '',
            currentInvoiceStatus: 'PENDING',
            targetInvoiceStatus: 'ISSUED',
            omegaDocumentId: 'omega_doc_1',
        });
        expect(result.allowed).toBe(false);
        expect(result.reason).toMatch(/orderId/i);
    });

    it('povolí zrušení faktury (PENDING -> CANCELLED) bez ohledu na omegaDocumentId', () => {
        const result = evaluateOrderInvoiceOmegaFlow(ctx, {
            orderId: 'order_1',
            currentInvoiceStatus: 'PENDING',
            targetInvoiceStatus: 'CANCELLED',
        });
        expect(result.allowed).toBe(true);
    });

    it('zamítne přechod z terminálního ISSUED stavu (deleguje na INVOICE_LIFECYCLE_DEFINITION)', () => {
        const result = evaluateOrderInvoiceOmegaFlow(ctx, {
            orderId: 'order_1',
            currentInvoiceStatus: 'ISSUED',
            targetInvoiceStatus: 'CANCELLED',
        });
        expect(result.allowed).toBe(false);
    });

    it('vrátí omegaDocumentNote jako informační poznámku, ne jako podmínku navíc', () => {
        const result = evaluateOrderInvoiceOmegaFlow(ctx, {
            orderId: 'order_1',
            currentInvoiceStatus: 'PENDING',
            targetInvoiceStatus: 'ISSUED',
            omegaDocumentId: 'omega_doc_1',
        });
        expect(result.omegaDocumentNote).toBeDefined();
    });

    it('flow NEGENERUJE omegaDocumentId -- výstupní shape ho neobsahuje jako pole k zápisu', () => {
        const result = evaluateOrderInvoiceOmegaFlow(ctx, {
            orderId: 'order_1',
            currentInvoiceStatus: 'PENDING',
            targetInvoiceStatus: 'ISSUED',
            omegaDocumentId: 'omega_doc_1',
        });
        expect('omegaDocumentId' in result).toBe(false);
    });

    it('je čistá funkce -- stejný vstup vždy stejný výstup', () => {
        const input = {
            orderId: 'order_1',
            currentInvoiceStatus: 'PENDING' as const,
            targetInvoiceStatus: 'ISSUED' as const,
            omegaDocumentId: 'omega_doc_1',
        };
        const first = evaluateOrderInvoiceOmegaFlow(ctx, input);
        const second = evaluateOrderInvoiceOmegaFlow(ctx, input);
        expect(first).toEqual(second);
    });
});
