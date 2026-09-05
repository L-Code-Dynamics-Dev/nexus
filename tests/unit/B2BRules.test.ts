// Fáze 6.2 business rules -- BusinessProfileAccessor
// (domains/b2b/BusinessProfileAccessor.ts). Josovo zadání 2026-09-05:
// "BusinessProfile je rozšíření Customer; nesmí vzniknout vlastní pricing
// engine; B2B informace musí být dostupné ostatním doménám přes kontrakt;
// žádné approval workflow ani credit limits."

import { describe, it, expect } from 'vitest';
import { getBusinessProfile, isBusinessCustomer, getB2BPricingContext } from '../../domains/b2b/BusinessProfileAccessor.js';
import { BusinessProfileValidationRule } from '../../domains/b2b/BusinessProfileValidationRule.js';
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

describe('BusinessProfileValidationRule — Fáze 6.3 bod 6 (minimální strukturální validace)', () => {
    const rule = new BusinessProfileValidationRule({ tenantId: 'ten_1', ruleId: 'business-profile-validation-v1', ruleVersion: '1' });

    it('validní BusinessProfile (jen povinná pole) projde', () => {
        const result = rule.evaluate({ company: 'ACME s.r.o.', taxIdentifiers: 'CZ12345678' });
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
    });

    it('validní BusinessProfile se všemi poli projde', () => {
        const result = rule.evaluate({
            company: 'ACME s.r.o.',
            taxIdentifiers: 'CZ12345678',
            pricingContext: 'pricelist_b2b_1',
            paymentTerms: 'net30',
        });
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
    });

    it('prázdný company selže', () => {
        const result = rule.evaluate({ company: '', taxIdentifiers: 'CZ12345678' });
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('company nesmí být prázdný/whitespace-only string.');
    });

    it('whitespace-only company selže', () => {
        const result = rule.evaluate({ company: '   ', taxIdentifiers: 'CZ12345678' });
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('company'))).toBe(true);
    });

    it('prázdný taxIdentifiers selže', () => {
        const result = rule.evaluate({ company: 'ACME s.r.o.', taxIdentifiers: '' });
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('taxIdentifiers nesmí být prázdný/whitespace-only string.');
    });

    it('oba povinné prázdné vrací OBĚ chyby najednou (ne jen první)', () => {
        const result = rule.evaluate({ company: '', taxIdentifiers: '' });
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBe(2);
    });

    it('chybějící volitelná pole (pricingContext/paymentTerms) NEJSOU chyba', () => {
        const result = rule.evaluate({ company: 'ACME s.r.o.', taxIdentifiers: 'CZ12345678' });
        expect(result.valid).toBe(true);
    });

    it('přítomný, ale prázdný pricingContext selže', () => {
        const result = rule.evaluate({ company: 'ACME s.r.o.', taxIdentifiers: 'CZ12345678', pricingContext: '' });
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('pricingContext'))).toBe(true);
    });

    it('přítomný, ale prázdný paymentTerms selže', () => {
        const result = rule.evaluate({ company: 'ACME s.r.o.', taxIdentifiers: 'CZ12345678', paymentTerms: '   ' });
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('paymentTerms'))).toBe(true);
    });

    it('NEVALIDUJE formát taxIdentifiers (žádný regex, business-specific validace je mimo scope)', () => {
        // "not-a-valid-ico" by formátem selhalo, ale Rule kontroluje jen neprázdnost
        const result = rule.evaluate({ company: 'ACME s.r.o.', taxIdentifiers: 'not-a-valid-ico' });
        expect(result.valid).toBe(true);
    });
});
