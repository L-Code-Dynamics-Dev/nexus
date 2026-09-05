// Fáze 6.2 business rules -- BusinessProfileAccessor
// (domains/b2b/BusinessProfileAccessor.ts). Josovo zadání 2026-09-05:
// "BusinessProfile je rozšíření Customer; nesmí vzniknout vlastní pricing
// engine; B2B informace musí být dostupné ostatním doménám přes kontrakt;
// žádné approval workflow ani credit limits."

import { describe, it, expect } from 'vitest';
import { getBusinessProfile, isBusinessCustomer, getB2BPricingContext } from '../../domains/b2b/BusinessProfileAccessor.js';
import type { Customer, BusinessProfile } from '../../core/canonical/entities/Customer.js';

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

describe('getBusinessProfile — kontrakt pro ostatní domény', () => {
    it('vrací BusinessProfile, pokud je na zákazníkovi nastavený', () => {
        const businessProfile: BusinessProfile = { company: 'ACME s.r.o.', taxIdentifiers: 'CZ12345678' };
        const customer = makeCustomer(businessProfile);

        expect(getBusinessProfile(customer)).toBe(businessProfile);
    });

    it('vrací undefined pro běžného B2C zákazníka (Non-Interference)', () => {
        const customer = makeCustomer(undefined);
        expect(getBusinessProfile(customer)).toBeUndefined();
    });
});

describe('isBusinessCustomer — explicitní B2B test', () => {
    it('vrací true, pokud businessProfile existuje', () => {
        const customer = makeCustomer({ company: 'ACME s.r.o.', taxIdentifiers: 'CZ12345678' });
        expect(isBusinessCustomer(customer)).toBe(true);
    });

    it('vrací false pro B2C zákazníka bez businessProfile', () => {
        const customer = makeCustomer(undefined);
        expect(isBusinessCustomer(customer)).toBe(false);
    });
});

describe('getB2BPricingContext — REFERENCE na ceník, žádný vlastní výpočet', () => {
    it('vrací pricingContext, pokud je vyplněný', () => {
        const customer = makeCustomer({
            company: 'ACME s.r.o.',
            taxIdentifiers: 'CZ12345678',
            pricingContext: 'pricelist_b2b_1',
        });

        expect(getB2BPricingContext(customer)).toBe('pricelist_b2b_1');
    });

    it('vrací undefined, pokud B2B profil existuje, ale pricingContext ne', () => {
        const customer = makeCustomer({ company: 'ACME s.r.o.', taxIdentifiers: 'CZ12345678' });
        expect(getB2BPricingContext(customer)).toBeUndefined();
    });

    it('vrací undefined pro B2C zákazníka bez businessProfile vůbec', () => {
        const customer = makeCustomer(undefined);
        expect(getB2BPricingContext(customer)).toBeUndefined();
    });
});

describe('Fáze 6.2 invariant — BusinessProfile nesmí obsahovat vlastní pricing/discount logiku', () => {
    it('BusinessProfile type nemá žádné cenové/slevové pole nad rámec pricingContext reference', () => {
        const businessProfile: BusinessProfile = { company: 'ACME s.r.o.', taxIdentifiers: 'CZ12345678' };

        expect('discountRules' in businessProfile).toBe(false);
        expect('customPriceCalculation' in businessProfile).toBe(false);
        expect('priceOverrides' in businessProfile).toBe(false);
        expect('discountPercent' in businessProfile).toBe(false);
    });

    it('BusinessProfile type nemá approval workflow ani credit limit pole (explicitně mimo scope)', () => {
        const businessProfile: BusinessProfile = { company: 'ACME s.r.o.', taxIdentifiers: 'CZ12345678' };

        expect('approvalStatus' in businessProfile).toBe(false);
        expect('creditLimit' in businessProfile).toBe(false);
        expect('approvedBy' in businessProfile).toBe(false);
    });
});
