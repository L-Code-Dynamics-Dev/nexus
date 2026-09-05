// InvoiceLifecycleRule -- Fáze 6.2 business rules testy. Pokrývá lifecycle
// přechody + orderId invariant + omegaDocumentNote (informační, ne blokující).

import { describe, it, expect } from 'vitest';
import { InvoiceLifecycleRule } from '../../domains/invoice/InvoiceLifecycleRule.js';

describe('InvoiceLifecycleRule', () => {
    const rule = new InvoiceLifecycleRule({ tenantId: 'ten_1', ruleId: 'invoice-lifecycle-v1', ruleVersion: '1' });

    it('povolí PENDING -> ISSUED s neprázdným orderId', () => {
        const result = rule.evaluate({ currentStatus: 'PENDING', targetStatus: 'ISSUED', orderId: 'order_1' });
        expect(result.allowed).toBe(true);
    });

    it('povolí PENDING -> CANCELLED bez ohledu na omegaDocumentId', () => {
        const result = rule.evaluate({ currentStatus: 'PENDING', targetStatus: 'CANCELLED', orderId: 'order_1' });
        expect(result.allowed).toBe(true);
    });

    it('zamítne ISSUED -> CANCELLED (ISSUED je terminální)', () => {
        const result = rule.evaluate({ currentStatus: 'ISSUED', targetStatus: 'CANCELLED', orderId: 'order_1' });
        expect(result.allowed).toBe(false);
        expect(result.reason).toBeDefined();
    });

    it('zamítne CANCELLED -> ISSUED (CANCELLED je terminální)', () => {
        const result = rule.evaluate({ currentStatus: 'CANCELLED', targetStatus: 'ISSUED', orderId: 'order_1' });
        expect(result.allowed).toBe(false);
    });

    it('zamítne PENDING -> ISSUED s prázdným orderId ("")', () => {
        const result = rule.evaluate({ currentStatus: 'PENDING', targetStatus: 'ISSUED', orderId: '' });
        expect(result.allowed).toBe(false);
        expect(result.reason).toMatch(/orderId/i);
    });

    it('zamítne PENDING -> ISSUED s orderId jen z bílých znaků ("   ")', () => {
        const result = rule.evaluate({ currentStatus: 'PENDING', targetStatus: 'ISSUED', orderId: '   ' });
        expect(result.allowed).toBe(false);
    });

    it('povolí PENDING -> CANCELLED i s prázdným orderId (pravidlo se týká jen ISSUED)', () => {
        const result = rule.evaluate({ currentStatus: 'PENDING', targetStatus: 'CANCELLED', orderId: '' });
        expect(result.allowed).toBe(true);
    });

    it('vrátí omegaDocumentNote, když je omegaDocumentId přítomné', () => {
        const result = rule.evaluate({
            currentStatus: 'PENDING',
            targetStatus: 'ISSUED',
            orderId: 'order_1',
            omegaDocumentId: 'omega_doc_123',
        });
        expect(result.allowed).toBe(true);
        expect(result.omegaDocumentNote).toBeDefined();
        expect(result.omegaDocumentNote).toMatch(/reference/i);
    });

    it('NEVRÁTÍ omegaDocumentNote, když omegaDocumentId chybí', () => {
        const result = rule.evaluate({ currentStatus: 'PENDING', targetStatus: 'ISSUED', orderId: 'order_1' });
        expect(result.allowed).toBe(true);
        expect(result.omegaDocumentNote).toBeUndefined();
    });

    it('NIKDY negeneruje omegaDocumentId -- výstupní shape ho vůbec neobsahuje jako pole k zápisu', () => {
        const result = rule.evaluate({ currentStatus: 'PENDING', targetStatus: 'ISSUED', orderId: 'order_1' });
        expect('omegaDocumentId' in result).toBe(false);
    });

    it('je čistá funkce -- stejný vstup vždy stejný výstup', () => {
        const input = { currentStatus: 'PENDING' as const, targetStatus: 'ISSUED' as const, orderId: 'order_1' };
        const first = rule.evaluate(input);
        const second = rule.evaluate(input);
        expect(first).toEqual(second);
    });
});
