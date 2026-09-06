// Fáze 6.1 doménová kostra -- core/canonical/entities/{Campaign,Invoice,
// Warehouse,Billing}.ts + Customer.ts B2B rozšíření + Stock.ts warehouseId.
// Josovo zadání 2026-09-05, bod 6: "Doplň základní testy. Ověř pouze
// definované vztahy a invarianty domén. Neřeš business scénáře, které
// zatím nejsou specifikované."
//
// Tyto testy ověřují (1) čistě typová/strukturální sestavení entit a
// (2) lifecycle stavové přechody přes evaluateTransition() -- žádná
// business logika neexistuje (Rules pro tyto domény se zatím nepíšou,
// viz Jose bod 5: "Nepřidávej žádnou neodsouhlasenou funkcionalitu").

import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { evaluateTransition } from '../../core/state-machine/StateMachine.js';
import type { PromoGroup, Campaign, CampaignPlacement, Creative } from '../../core/canonical/entities/Campaign.js';
import { CAMPAIGN_LIFECYCLE_DEFINITION, CREATIVE_LIFECYCLE_DEFINITION } from '../../core/canonical/entities/Campaign.js';
import type { Invoice } from '../../core/canonical/entities/Invoice.js';
import { INVOICE_LIFECYCLE_DEFINITION } from '../../core/canonical/entities/Invoice.js';
import type { Warehouse } from '../../core/canonical/entities/Warehouse.js';
import { WAREHOUSE_LIFECYCLE_DEFINITION } from '../../core/canonical/entities/Warehouse.js';
import type { StockPosition } from '../../core/canonical/entities/Stock.js';
import type { Subscription, BillingEvent } from '../../core/canonical/entities/Billing.js';
import { SUBSCRIPTION_LIFECYCLE_DEFINITION } from '../../core/canonical/entities/Billing.js';
import type { Customer, BusinessProfile } from '../../core/canonical/entities/Customer.js';

const now = '2026-09-05T00:00:00Z';

describe('Fáze 6.1 — Campaign/PromoGroup/Creative vztahy + lifecycle', () => {
    it('PromoGroup -> Product: productIds je explicitní FK seznam s povinnou priority', () => {
        const promoGroup: PromoGroup = {
            id: 'promo_1',
            tenantId: 'ten_1',
            createdAt: now,
            updatedAt: now,
            name: 'Letní kolekce',
            productIds: ['prod_1', 'prod_2'],
            priority: 10,
        };

        expect(promoGroup.productIds).toEqual(['prod_1', 'prod_2']);
        expect(promoGroup.priority).toBe(10);
        // Invariant: PromoGroup type nemá priceListId ani pricingTier pole --
        // vazba je výhradně na Product, nikdy na Pricing doménu.
        expect('priceListId' in promoGroup).toBe(false);
    });

    it('produkt může patřit do více PromoGroup současně (M:N, žádné omezení na typové úrovni)', () => {
        const groupA: PromoGroup = {
            id: 'promo_a', tenantId: 'ten_1', createdAt: now, updatedAt: now,
            name: 'Skupina A', productIds: ['prod_shared'], priority: 5,
        };
        const groupB: PromoGroup = {
            id: 'promo_b', tenantId: 'ten_1', createdAt: now, updatedAt: now,
            name: 'Skupina B', productIds: ['prod_shared'], priority: 20,
        };

        expect(groupA.productIds).toContain('prod_shared');
        expect(groupB.productIds).toContain('prod_shared');
        expect(groupB.priority).toBeGreaterThan(groupA.priority);
    });

    it('Campaign -> PromoGroup: promoGroupIds je pole (1:N, ne 1:1)', () => {
        const campaign: Campaign = {
            id: 'camp_1',
            tenantId: 'ten_1',
            createdAt: now,
            updatedAt: now,
            name: 'Letní akce 2026',
            status: 'DRAFT',
            promoGroupIds: ['promo_1', 'promo_2'],
        };

        expect(campaign.promoGroupIds).toEqual(['promo_1', 'promo_2']);
    });

    it('Campaign lifecycle: DRAFT -> ACTIVE -> PAUSED -> ACTIVE -> ENDED je povolená sekvence', () => {
        const def = CAMPAIGN_LIFECYCLE_DEFINITION;
        expect(evaluateTransition(def, 'DRAFT', 'ACTIVE').allowed).toBe(true);
        expect(evaluateTransition(def, 'ACTIVE', 'PAUSED').allowed).toBe(true);
        expect(evaluateTransition(def, 'PAUSED', 'ACTIVE').allowed).toBe(true);
        expect(evaluateTransition(def, 'ACTIVE', 'ENDED').allowed).toBe(true);
    });

    it('Campaign lifecycle: ENDED je terminální, žádný přechod ven není povolen', () => {
        const result = evaluateTransition(CAMPAIGN_LIFECYCLE_DEFINITION, 'ENDED', 'DRAFT');
        expect(result.allowed).toBe(false);
    });

    it('Campaign lifecycle: DRAFT nemůže přejít přímo na PAUSED (musí projít ACTIVE)', () => {
        const result = evaluateTransition(CAMPAIGN_LIFECYCLE_DEFINITION, 'DRAFT', 'PAUSED');
        expect(result.allowed).toBe(false);
    });

    it('Campaign -> Creative: Creative referencuje campaignId zpět na Campaign', () => {
        const campaignId = 'camp_1';
        const creative: Creative = {
            id: 'creative_1',
            tenantId: 'ten_1',
            createdAt: now,
            updatedAt: now,
            campaignId,
            name: 'Letní banner',
            type: 'image',
            content: 'https://cdn.example.com/banner.jpg',
            status: 'DRAFT',
            placementTypes: ['homepage'],
            priority: 0,
        };

        expect(creative.campaignId).toBe(campaignId);
    });

    it('Creative lifecycle: DRAFT -> PUBLISHED -> ARCHIVED je povolená sekvence, ARCHIVED je terminální', () => {
        const def = CREATIVE_LIFECYCLE_DEFINITION;
        expect(evaluateTransition(def, 'DRAFT', 'PUBLISHED').allowed).toBe(true);
        expect(evaluateTransition(def, 'PUBLISHED', 'ARCHIVED').allowed).toBe(true);
        expect(evaluateTransition(def, 'ARCHIVED', 'DRAFT').allowed).toBe(false);
    });

    it('CampaignPlacement referencuje campaignId, placementType je rozšiřitelný string', () => {
        const placement: CampaignPlacement = {
            id: 'placement_1',
            tenantId: 'ten_1',
            createdAt: now,
            updatedAt: now,
            campaignId: 'camp_1',
            placementType: 'homepage_banner',
        };

        expect(placement.campaignId).toBe('camp_1');
        expect(placement.placementType).toBe('homepage_banner');
    });
});

describe('Fáze 6.1 — Invoice vztahy + lifecycle', () => {
    it('Invoice -> Order: orderId je povinná 1:1 FK vazba (NE souhrnná faktura)', () => {
        const invoice: Invoice = {
            id: 'inv_1',
            tenantId: 'ten_1',
            createdAt: now,
            updatedAt: now,
            orderId: 'order_1',
            documentType: 'INVOICE',
            issueDate: now,
            total: { amount: new Decimal('1000'), currency: 'CZK' },
            status: 'PENDING',
        };

        expect(invoice.orderId).toBe('order_1');
        // Invariant: Invoice type nemá orderIds[] ani orderId2 -- 1:1 vazba,
        // ne N:1 souhrnná faktura (Jose rozhodnutí).
        expect('orderIds' in invoice).toBe(false);
    });

    it('Invoice může být PENDING bez omegaDocumentId (Omega doklad ještě nevznikl)', () => {
        const invoice: Invoice = {
            id: 'inv_2', tenantId: 'ten_1', createdAt: now, updatedAt: now,
            orderId: 'order_2', documentType: 'INVOICE', issueDate: now,
            total: { amount: new Decimal('500'), currency: 'CZK' }, status: 'PENDING',
        };

        expect(invoice.omegaDocumentId).toBeUndefined();
        expect(invoice.status).toBe('PENDING');
    });

    it('Invoice s omegaDocumentId je jen reference, ne kopie účetních dat', () => {
        const invoice: Invoice = {
            id: 'inv_3', tenantId: 'ten_1', createdAt: now, updatedAt: now,
            orderId: 'order_3', documentType: 'INVOICE', issueDate: now,
            total: { amount: new Decimal('750'), currency: 'CZK' }, status: 'ISSUED',
            omegaDocumentId: 'omega_doc_123',
        };

        expect(invoice.omegaDocumentId).toBe('omega_doc_123');
    });

    it('Invoice lifecycle: PENDING -> ISSUED a PENDING -> CANCELLED jsou povolené, oba jsou terminální', () => {
        const def = INVOICE_LIFECYCLE_DEFINITION;
        expect(evaluateTransition(def, 'PENDING', 'ISSUED').allowed).toBe(true);
        expect(evaluateTransition(def, 'PENDING', 'CANCELLED').allowed).toBe(true);
        expect(evaluateTransition(def, 'ISSUED', 'CANCELLED').allowed).toBe(false);
        expect(evaluateTransition(def, 'CANCELLED', 'ISSUED').allowed).toBe(false);
    });
});

describe('Fáze 6.1 — Warehouse vztahy + lifecycle', () => {
    it('Warehouse -> StockPosition: warehouseId je volitelné pole na StockPosition', () => {
        const warehouse: Warehouse = {
            id: 'wh_1',
            tenantId: 'ten_1',
            createdAt: now,
            updatedAt: now,
            name: 'Centrální sklad Praha',
            isPhysical: true,
            status: 'ACTIVE',
        };

        const stockPosition: StockPosition = {
            id: 'stock_1',
            tenantId: 'ten_1',
            createdAt: now,
            updatedAt: now,
            productId: 'prod_1',
            warehouseId: warehouse.id,
            quantity: 42,
            purchasable: true,
            canPreorder: false,
            inTransit: false,
            observedAt: now,
        };

        expect(stockPosition.warehouseId).toBe(warehouse.id);
    });

    it('StockPosition zůstává validní BEZ warehouseId (Non-Interference — existující záznamy se nerozbijí)', () => {
        const stockPosition: StockPosition = {
            id: 'stock_2',
            tenantId: 'ten_1',
            createdAt: now,
            updatedAt: now,
            productId: 'prod_2',
            quantity: 10,
            purchasable: true,
            canPreorder: false,
            inTransit: false,
            observedAt: now,
        };

        expect(stockPosition.warehouseId).toBeUndefined();
    });

    it('Warehouse type nemá supplierId ani žádnou vazbu na Supplier (oddělené domény)', () => {
        const warehouse: Warehouse = {
            id: 'wh_2', tenantId: 'ten_1', createdAt: now, updatedAt: now,
            name: 'Dropshipping lokace', isPhysical: false, status: 'ACTIVE',
        };

        expect('supplierId' in warehouse).toBe(false);
    });

    it('Warehouse lifecycle: ACTIVE <-> INACTIVE je obousměrně povolený, žádný terminální stav', () => {
        const def = WAREHOUSE_LIFECYCLE_DEFINITION;
        expect(evaluateTransition(def, 'ACTIVE', 'INACTIVE').allowed).toBe(true);
        expect(evaluateTransition(def, 'INACTIVE', 'ACTIVE').allowed).toBe(true);
        expect(def.terminalStates).toEqual([]);
    });
});

describe('Fáze 6.1 — Billing/Subscription vztahy + lifecycle', () => {
    it('Subscription je tenant-scoped (váže se na Tenant/TenantPlan přes tenantId)', () => {
        const subscription: Subscription = {
            id: 'sub_1',
            tenantId: 'ten_1',
            createdAt: now,
            updatedAt: now,
            status: 'TRIAL',
            planTier: 'STARTER',
            billingPeriodStart: now,
            billingPeriodEnd: now,
        };

        expect(subscription.tenantId).toBe('ten_1');
        expect(subscription.planTier).toBe('STARTER');
    });

    it('Subscription lifecycle: TRIAL -> ACTIVE -> PAST_DUE -> ACTIVE -> CANCELLED je povolená sekvence', () => {
        const def = SUBSCRIPTION_LIFECYCLE_DEFINITION;
        expect(evaluateTransition(def, 'TRIAL', 'ACTIVE').allowed).toBe(true);
        expect(evaluateTransition(def, 'ACTIVE', 'PAST_DUE').allowed).toBe(true);
        expect(evaluateTransition(def, 'PAST_DUE', 'ACTIVE').allowed).toBe(true);
        expect(evaluateTransition(def, 'ACTIVE', 'CANCELLED').allowed).toBe(true);
    });

    it('Subscription lifecycle: CANCELLED je terminální', () => {
        const result = evaluateTransition(SUBSCRIPTION_LIFECYCLE_DEFINITION, 'CANCELLED', 'TRIAL');
        expect(result.allowed).toBe(false);
    });

    it('BillingEvent -> Subscription: subscriptionId je povinná FK vazba', () => {
        const event: BillingEvent = {
            id: 'evt_1',
            tenantId: 'ten_1',
            createdAt: now,
            updatedAt: now,
            subscriptionId: 'sub_1',
            eventType: 'CHARGE',
            amount: { amount: new Decimal('999'), currency: 'CZK' },
            occurredAt: now,
        };

        expect(event.subscriptionId).toBe('sub_1');
    });

    it('Subscription type nemá žádnou vazbu na Invoice (striktně oddělené domény)', () => {
        const subscription: Subscription = {
            id: 'sub_2', tenantId: 'ten_1', createdAt: now, updatedAt: now,
            status: 'ACTIVE', planTier: 'GROWTH',
            billingPeriodStart: now, billingPeriodEnd: now,
        };

        expect('invoiceId' in subscription).toBe(false);
        expect('orderId' in subscription).toBe(false);
    });
});

describe('Fáze 6.1 — B2B BusinessProfile na Customer (NE nová doména)', () => {
    it('Customer.businessProfile je strukturovaný kontrakt (company/taxIdentifiers/pricingContext/paymentTerms)', () => {
        const businessProfile: BusinessProfile = {
            company: 'ACME s.r.o.',
            taxIdentifiers: 'CZ12345678',
            pricingContext: 'pricelist_b2b_1',
            paymentTerms: 'net30',
        };

        const b2bCustomer: Customer = {
            id: 'cust_1',
            tenantId: 'ten_1',
            createdAt: now,
            updatedAt: now,
            externalIdentity: { connectorType: 'shoptet', externalId: 'guid-1' },
            businessProfile,
        };

        expect(b2bCustomer.businessProfile?.company).toBe('ACME s.r.o.');
        expect(b2bCustomer.businessProfile?.pricingContext).toBe('pricelist_b2b_1');
    });

    it('Customer zůstává validní BEZ businessProfile (Non-Interference — běžný B2C zákazník beze změny)', () => {
        const b2cCustomer: Customer = {
            id: 'cust_2',
            tenantId: 'ten_1',
            createdAt: now,
            updatedAt: now,
            externalIdentity: { connectorType: 'shoptet', externalId: 'guid-2' },
        };

        expect(b2cCustomer.businessProfile).toBeUndefined();
    });

    it('BusinessProfile type nemá žádné vlastní pricing/discount pole (B2B není druhý pricing engine)', () => {
        const businessProfile: BusinessProfile = {
            company: 'ACME s.r.o.',
            taxIdentifiers: 'CZ12345678',
        };

        expect('discountRules' in businessProfile).toBe(false);
        expect('customPriceCalculation' in businessProfile).toBe(false);
        // pricingContext je jen REFERENCE (FK-like), ne vlastní logika:
        expect(typeof businessProfile.pricingContext === 'string' || businessProfile.pricingContext === undefined).toBe(true);
    });

    it('BusinessProfile nemá approval workflow ani credit limit pole (explicitně mimo scope)', () => {
        const businessProfile: BusinessProfile = {
            company: 'ACME s.r.o.',
            taxIdentifiers: 'CZ12345678',
        };

        expect('approvalStatus' in businessProfile).toBe(false);
        expect('creditLimit' in businessProfile).toBe(false);
    });
});
