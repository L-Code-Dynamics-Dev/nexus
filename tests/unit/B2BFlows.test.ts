// Fáze 6.4 business flow -- CustomerBusinessContextFlow
// (domains/b2b/CustomerBusinessContextFlow.ts). Josovo zadání 2026-09-05:
// "Customer -> BusinessProfile -> ostatní domény" flow, čistá kompozice
// isBusinessCustomer() + BusinessProfileValidationRule + getB2BPricingContext().

import { describe, it, expect } from 'vitest';
import { resolveCustomerBusinessContext } from '../../domains/b2b/CustomerBusinessContextFlow.js';
import type { Customer, BusinessProfile } from '../../core/canonical/entities/Customer.js';

const ctx = { tenantId: 'ten_1', ruleId: 'customer-business-context-flow-v1', ruleVersion: '1' };
const now = '2026-09-05T00:00:00Z';

function makeCustomer(businessProfile?: BusinessProfile): Customer {
    return {
        id: 'cust_1',
        tenantId: 'ten_1',
        createdAt: now,
        updatedAt: now,
        externalIdentity: { connectorType: 'shoptet', externalId: 'guid-1' },
        businessProfile,
    };
}

describe('resolveCustomerBusinessContext — B2C zákazník', () => {
    it('B2C zákazník (bez businessProfile) nemá B2B kontext', () => {
        const customer = makeCustomer(undefined);
        const result = resolveCustomerBusinessContext(ctx, customer);

        expect(result.isB2B).toBe(false);
        expect(result.profileValid).toBeUndefined();
        expect(result.validationErrors).toBeUndefined();
        expect(result.pricingContext).toBeUndefined();
    });
});

describe('resolveCustomerBusinessContext — validní B2B zákazník', () => {
    it('validní BusinessProfile s pricingContext -- isB2B true, profileValid true, pricingContext vrácen', () => {
        const customer = makeCustomer({
            company: 'ACME s.r.o.',
            taxIdentifiers: 'CZ12345678',
            pricingContext: 'pricelist_b2b_1',
        });

        const result = resolveCustomerBusinessContext(ctx, customer);

        expect(result.isB2B).toBe(true);
        expect(result.profileValid).toBe(true);
        expect(result.validationErrors).toBeUndefined();
        expect(result.pricingContext).toBe('pricelist_b2b_1');
    });

    it('validní BusinessProfile BEZ pricingContext -- isB2B true, profileValid true, pricingContext undefined', () => {
        const customer = makeCustomer({ company: 'ACME s.r.o.', taxIdentifiers: 'CZ12345678' });
        const result = resolveCustomerBusinessContext(ctx, customer);

        expect(result.isB2B).toBe(true);
        expect(result.profileValid).toBe(true);
        expect(result.pricingContext).toBeUndefined();
    });
});

describe('resolveCustomerBusinessContext — neplatný B2B profil se reportuje, ne skrývá', () => {
    it('prázdný company -- profileValid false s validationErrors', () => {
        const customer = makeCustomer({ company: '', taxIdentifiers: 'CZ12345678' });
        const result = resolveCustomerBusinessContext(ctx, customer);

        expect(result.isB2B).toBe(true);
        expect(result.profileValid).toBe(false);
        expect(result.validationErrors).toBeDefined();
        expect(result.validationErrors!.some((e) => e.includes('company'))).toBe(true);
    });

    it('prázdný taxIdentifiers -- profileValid false, pricingContext se přesto vrátí (validace neblokuje čtení reference)', () => {
        const customer = makeCustomer({
            company: 'ACME s.r.o.',
            taxIdentifiers: '',
            pricingContext: 'pricelist_b2b_1',
        });
        const result = resolveCustomerBusinessContext(ctx, customer);

        expect(result.isB2B).toBe(true);
        expect(result.profileValid).toBe(false);
        expect(result.pricingContext).toBe('pricelist_b2b_1');
    });

    it('prázdný pricingContext (přítomný, ale blank) -- profileValid false', () => {
        const customer = makeCustomer({ company: 'ACME s.r.o.', taxIdentifiers: 'CZ12345678', pricingContext: '   ' });
        const result = resolveCustomerBusinessContext(ctx, customer);

        expect(result.isB2B).toBe(true);
        expect(result.profileValid).toBe(false);
    });
});

describe('resolveCustomerBusinessContext — je čistá funkce', () => {
    it('stejný vstup vždy vrací stejný výsledek', () => {
        const customer = makeCustomer({ company: 'ACME s.r.o.', taxIdentifiers: 'CZ12345678', pricingContext: 'pricelist_b2b_1' });
        const first = resolveCustomerBusinessContext(ctx, customer);
        const second = resolveCustomerBusinessContext(ctx, customer);
        expect(first).toEqual(second);
    });
});
