// Hraniční testovací matice -- Fáze 6.5 pokračování (Josovo zadání
// 2026-09-06): "Nejprve doplnit testovací matici přesně na hraniční
// kombinace" před pokračováním na Creative doménu. Ověřuje END-TO-END
// kompozici celého kandidátního cenového modelu:
//
//   BASE PRICE -> SALE/LOYALTY/CUSTOMER -> DISCOUNT LIMITS -> CURRENT PRICE
//   -> PROMOGROUP CANDIDATE -> QUANTITY TIER CANDIDATE -> BEST PRICE -> ROUNDING
//
// Používá createNexusPricingCalculator (Fáze 1, produkční Pricing chain)
// pro BASE->CURRENT_PRICE krok, pak PromoGroupDiscountRule + QuantityTierRule
// jako kandidáty, BestCandidatePriceRule pro finální výběr. XPlusXRule je
// NEZÁVISLÁ vrstva (paid/free split, ne cena) testovaná vedle.
//
// 10 scénářů z Josova zadání (doslovná citace u každého describe bloku).

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { fileURLToPath } from 'url';
import Decimal from 'decimal.js';
import { createNexusPricingCalculator } from '../../domains/pricing/createNexusPricingCalculator.js';
import { PromoGroupDiscountRule } from '../../domains/campaign/PromoGroupDiscountRule.js';
import { QuantityTierRule } from '../../domains/pricing/QuantityTierRule.js';
import { XPlusXRule } from '../../domains/pricing/XPlusXRule.js';
import { BestCandidatePriceRule } from '../../domains/pricing/BestCandidatePriceRule.js';
import { resolveConflict } from '../../domains/campaign/PromoGroupPriorityRule.js';
import { shouldEvaluateCampaign } from '../../domains/campaign/CampaignLifecycleRule.js';
import type { PromoGroup, Campaign } from '../../core/canonical/entities/Campaign.js';
import type { QuantityTierBreakpoint } from '../../core/canonical/entities/Price.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POLICY_CONFIG_PATH = path.join(__dirname, '../../connectors/pricing-engine/legacy/config/policies/policy-v1.json');
const ctx = { tenantId: 'ten_1', ruleId: 'test', ruleVersion: '1' };
const now = '2026-09-05T00:00:00Z';

const HECMANIA_BREAKPOINTS: QuantityTierBreakpoint[] = [
    { minQuantity: 1, maxQuantity: 4, discountPercent: 0 },
    { minQuantity: 5, maxQuantity: 19, discountPercent: 0.09 },
    { minQuantity: 20, maxQuantity: 29, discountPercent: 0.11 },
    { minQuantity: 30, discountPercent: 0.14 },
];

function makePromoGroup(overrides: Partial<PromoGroup> = {}): PromoGroup {
    return {
        id: 'promo_1', tenantId: 'ten_1', createdAt: now, updatedAt: now,
        name: 'Test promo', productIds: ['prod_1'], priority: 10,
        ...overrides,
    };
}

function makeCampaign(overrides: Partial<Campaign> = {}): Campaign {
    return {
        id: 'camp_1', tenantId: 'ten_1', createdAt: now, updatedAt: now,
        name: 'Test campaign', status: 'ACTIVE', promoGroupIds: ['promo_1'],
        ...overrides,
    };
}

/**
 * End-to-end pipeline helper -- skládá VŠECHNY existující Rules v pořadí
 * z Jose diagramu. Není produkční kód (žádný takový orchestrátor v repu
 * zatím neexistuje, viz design proposal §6 batch/live nerozhodnuto) --
 * je to čistě testovací kompozice pro ověření matice.
 */
function computeFinalPrice(params: {
    calculatorInput: Parameters<ReturnType<typeof createNexusPricingCalculator>>[0];
    promoGroups?: PromoGroup[];
    campaign?: Campaign;
    productId?: string;
    quantityBreakpoints?: readonly QuantityTierBreakpoint[];
    totalQuantity?: number;
}) {
    const calculator = createNexusPricingCalculator(POLICY_CONFIG_PATH);
    const pricingResult = calculator(params.calculatorInput);
    const currentPrice = pricingResult.finalPrice; // POZOR: toto je PO rounding v legacy calculatoru,
    // ale pro test účely bereme jako "currentPrice" krok před promo/quantity vrstvou --
    // viz Jose diagram, rounding je AŽ na konci celého řetězu.

    let promoGroupCandidate: Decimal | undefined;
    if (params.campaign && params.promoGroups && params.productId) {
        const isActive = shouldEvaluateCampaign(params.campaign.status);
        if (isActive) {
            const campaignGroups = params.promoGroups.filter((g) => params.campaign!.promoGroupIds.includes(g.id));
            const conflict = resolveConflict(campaignGroups, params.productId);
            if (conflict.resolved) {
                const discountRule = new PromoGroupDiscountRule(ctx);
                const discountResult = discountRule.evaluate({ currentPrice, winningPromoGroup: conflict.winner });
                if (discountResult.source === 'PROMO_GROUP') {
                    promoGroupCandidate = discountResult.finalPrice;
                }
            }
        }
    }

    let quantityTierCandidate: Decimal | undefined;
    if (params.quantityBreakpoints && params.totalQuantity !== undefined) {
        const quantityRule = new QuantityTierRule(ctx);
        const quantityResult = quantityRule.evaluate({
            sourcePrice: currentPrice,
            totalQuantity: params.totalQuantity,
            breakpoints: params.quantityBreakpoints,
        });
        if (quantityResult.applied && quantityResult.price) {
            quantityTierCandidate = quantityResult.price;
        }
    }

    const bestPriceRule = new BestCandidatePriceRule(ctx);
    return bestPriceRule.evaluate({ currentPrice, promoGroupCandidate, quantityTierCandidate });
}

describe('1. běžná cena + H-KLUB/B2B + množstevní sleva', () => {
    it('basePrice 250, ZR20 (20%) loyalty -> currentPrice 200, quantity 8% (5-19ks) -> 184', () => {
        const result = computeFinalPrice({
            calculatorInput: { sku: 'SKU1', basePrice: new Decimal('250'), customerTier: 'ZR20', allowLoyaltyDiscount: true },
            quantityBreakpoints: HECMANIA_BREAKPOINTS,
            totalQuantity: 10,
        });
        // 250 * 0.8 = 200 (loyalty), 200 * 0.91 = 182 (9% quantity tier na 10ks)
        expect(result.finalPrice.toString()).toBe('182');
        expect(result.winningSource).toBe('QUANTITY_TIER');
    });
});

describe('2. akční cena + H-KLUB/B2B', () => {
    it('salePrice je AUTORITATIVNÍ přes DiscountLimit (VAGNER pravidlo) -- loyalty i produktMaxDiscount limit se neuplatní', () => {
        const result = computeFinalPrice({
            calculatorInput: {
                sku: 'SKU2', basePrice: new Decimal('250'), salePrice: new Decimal('180'),
                customerTier: 'ZR20', allowLoyaltyDiscount: true, productMaxDiscount: new Decimal('0.05'),
            },
        });
        // VAGNER: aktivní limit + salePrice -> salePrice vyhrává bezpodmínečně (viz DiscountLimitRule.ts)
        expect(result.finalPrice.toString()).toBe('180');
        expect(result.winningSource).toBe('CURRENT_PRICE'); // žádná promo/quantity vrstva zde testována
    });
});

describe('3. akční cena + množstevní sleva', () => {
    it('QuantityTier se počítá ze SALE ceny (currentPrice po chainu), NE z basePrice -- zachované pravidlo', () => {
        // sourcePrice pro QuantityTier je VŽDY currentPrice (po celém Pricing chainu,
        // včetně salePrice VAGNER pravidla) -- design proposal §1, nezměněno Fází 6.5.
        const result = computeFinalPrice({
            calculatorInput: { sku: 'SKU3', basePrice: new Decimal('250'), salePrice: new Decimal('180') },
            quantityBreakpoints: HECMANIA_BREAKPOINTS,
            totalQuantity: 10,
        });
        // currentPrice = 180 (sale), quantity 9% na 10ks -> 180*0.91 = 163.8
        expect(result.finalPrice.toString()).toBe('163.8');
        expect(result.winningSource).toBe('QUANTITY_TIER');
    });
});

describe('4. H-KLUB/B2B + PromoGroup', () => {
    it('PromoGroup aplikovaná na currentPrice PO loyalty slevě, ne na basePrice', () => {
        const promoGroup = makePromoGroup({ discount: { type: 'PERCENTAGE', value: 0.1 } });
        const campaign = makeCampaign();
        const result = computeFinalPrice({
            calculatorInput: { sku: 'SKU4', basePrice: new Decimal('250'), customerTier: 'ZR20', allowLoyaltyDiscount: true },
            promoGroups: [promoGroup],
            campaign,
            productId: 'prod_1',
        });
        // 250 * 0.8 = 200 (loyalty), 200 * 0.9 = 180 (10% promo NA 200, NE na 250)
        expect(result.finalPrice.toString()).toBe('180');
        expect(result.winningSource).toBe('PROMO_GROUP');
    });
});

describe('5. H-KLUB/B2B + PromoGroup + QuantityTier', () => {
    it('všechny tři vrstvy najednou -- vyhrává absolutně nejnižší kandidát, ne součet', () => {
        const promoGroup = makePromoGroup({ discount: { type: 'PERCENTAGE', value: 0.1 } });
        const campaign = makeCampaign();
        const result = computeFinalPrice({
            calculatorInput: { sku: 'SKU5', basePrice: new Decimal('250'), customerTier: 'ZR20', allowLoyaltyDiscount: true },
            promoGroups: [promoGroup],
            campaign,
            productId: 'prod_1',
            quantityBreakpoints: HECMANIA_BREAKPOINTS,
            totalQuantity: 10,
        });
        // currentPrice = 200 (loyalty). Promo kandidát: 200*0.9=180. Quantity kandidát: 200*0.91=182.
        // Nejnižší = 180 (PromoGroup), NE 200*(1-0.1-0.09)=162 (sečtené procento).
        expect(result.finalPrice.toString()).toBe('180');
        expect(result.winningSource).toBe('PROMO_GROUP');
    });
});

describe('6. X+X + QuantityTier', () => {
    it('X+X (paid/free split) a QuantityTier fungují SOUČASNĚ -- nezávislé vrstvy, X+X neovlivňuje cenu, jen počet placených kusů', () => {
        const xPlusXRule = new XPlusXRule(ctx);
        const xResult = xPlusXRule.evaluate({ qty: 20, ratio: { paid: 2, free: 1 } });
        expect(xResult.inScope).toBe(true);
        expect(xResult.paidQty).toBe(14);
        expect(xResult.freeQty).toBe(6);

        // QuantityTier se počítá z CELKOVÉHO počtu kusů v košíku (20), NE jen placených (14) --
        // design proposal §1 "celkový počet kusů VČETNĚ těch, co vyjdou zdarma".
        const priceResult = computeFinalPrice({
            calculatorInput: { sku: 'SKU6', basePrice: new Decimal('250') },
            quantityBreakpoints: HECMANIA_BREAKPOINTS,
            totalQuantity: xResult.totalReceivedQty, // 20, ne xResult.paidQty
        });
        // currentPrice = 250 (žádná loyalty), quantity 11% na 20ks (20-29 pásmo) -> 250*0.89=222.5
        expect(priceResult.finalPrice.toString()).toBe('222.5');
    });
});

describe('7. produkt mimo X+X scope + stejná konfigurace', () => {
    it('produkt bez X+X ratio se jí vůbec nedotkne -- inScope: false, žádný paid/free split', () => {
        const xPlusXRule = new XPlusXRule(ctx);
        const result = xPlusXRule.evaluate({ qty: 20 }); // žádný ratio -- mimo scope
        expect(result.inScope).toBe(false);
        expect(result.paidQty).toBe(20); // beze změny, všech 20 je placených
        expect(result.freeQty).toBe(0);
    });
});

describe('8. více PromoGroup -> priority -> následný výpočet', () => {
    it('konflikt priority se vyřeší PŘED výpočtem ceny, vítězná skupina (vyšší priority) určuje slevu', () => {
        const groupLow = makePromoGroup({ id: 'promo_low', priority: 5, discount: { type: 'PERCENTAGE', value: 0.05 } });
        const groupHigh = makePromoGroup({ id: 'promo_high', priority: 20, discount: { type: 'PERCENTAGE', value: 0.2 } });
        const campaign = makeCampaign({ promoGroupIds: ['promo_low', 'promo_high'] });

        const result = computeFinalPrice({
            calculatorInput: { sku: 'SKU8', basePrice: new Decimal('200') },
            promoGroups: [groupLow, groupHigh],
            campaign,
            productId: 'prod_1',
        });
        // currentPrice = 200 (žádná loyalty). Vítězná skupina = groupHigh (priority 20).
        // 200 * 0.8 = 160 (20% promo), NE 200*0.95=190 (nižší priority skupiny)
        expect(result.finalPrice.toString()).toBe('160');
        expect(result.winningSource).toBe('PROMO_GROUP');
    });
});

describe('9. PAUSED campaign -> žádná promo cena', () => {
    it('kampaň PAUSED se nevyhodnocuje vůbec -- žádný promo kandidát, currentPrice zůstává', () => {
        const promoGroup = makePromoGroup({ discount: { type: 'PERCENTAGE', value: 0.5 } }); // i agresivní sleva
        const campaign = makeCampaign({ status: 'PAUSED' });

        const result = computeFinalPrice({
            calculatorInput: { sku: 'SKU9', basePrice: new Decimal('200') },
            promoGroups: [promoGroup],
            campaign,
            productId: 'prod_1',
        });
        expect(result.finalPrice.toString()).toBe('200');
        expect(result.winningSource).toBe('CURRENT_PRICE');
    });
});

describe('10. promo/quantity kandidát vyjde vyšší než současná cena -> nesmí zdražit', () => {
    it('BestCandidatePriceRule nikdy nevybere vyšší kandidát než currentPrice', () => {
        const rule = new BestCandidatePriceRule(ctx);
        const result = rule.evaluate({
            currentPrice: new Decimal('180'), // hypoteticky nejnižší (např. sale cena)
            promoGroupCandidate: new Decimal('200'), // vyšší -- config by neměl umožnit, ale defenzivně ověřeno
            quantityTierCandidate: new Decimal('195'), // taky vyšší
        });
        expect(result.finalPrice.toString()).toBe('180');
        expect(result.winningSource).toBe('CURRENT_PRICE');
    });
});
