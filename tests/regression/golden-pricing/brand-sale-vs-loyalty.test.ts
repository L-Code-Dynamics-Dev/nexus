// BUSINESS PRAVIDLO: brandSale vs. loyalty tier -- potvrzeno Luckym 2026-09-07.
//
// Doslovné znění:
//   "DELPHIN má celoroční akci 15 %. Když má tier nižší %, zákazník automaticky
//    dostává 15 %. Když je tier vyšší než 15 %, dostane cenu toho tieru -- ale
//    musí se zohlednit, jestli produkt nemá strop pro maximální slevu."
//
// Tedy:
//   1. max(brandSale, loyaltyTier) -- vyhrává VYŠŠÍ sleva, NIKDY se nesčítají
//   2. POTOM se aplikuje strop (productMaxDiscount / brandLimits)
//
// PROČ TENHLE SOUBOR EXISTUJE:
//   Pravidlo bylo doteď jen v hlavách a v chování legacy kódu. Shadow analýza
//   z 7.9. našla, že se okfish enginy na DELPHIN produktech rozcházejí
//   (93683 ZR25: badge 12,71 vs ceník 11,21) -- a bez zapsaného pravidla
//   nešlo rozhodnout, KTERÝ z nich má pravdu. Teď to rozhodnuté je a tenhle
//   test to drží: kdyby někdo změnil pořadí nebo začal slevy sčítat, spadne to.
//
// Data jsou reálná, z produkčního feedu okfish.sk:
//   93683 "Čelovka DELPHIN Compact", base 14,94, akční 12,70 (= 14,94 × 0,85)

import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { HighestDiscountRule } from '../../../domains/pricing/HighestDiscountRule.js';
import { DiscountLimitRule } from '../../../domains/pricing/DiscountLimitRule.js';
import type { RuleContext } from '../../../core/canonical/rules/Rule.js';

const CTX: RuleContext = {
    tenantId: 'okfish',
    ruleVersion: '1',
    ruleId: 'brand-sale-vs-loyalty-test',
} as RuleContext;

/** loyaltyTiers z produkčního policy-v1.json. */
const TIERS: Record<string, Decimal> = {
    ZR4: new Decimal('0.04'),
    ZR6: new Decimal('0.06'),
    ZR8: new Decimal('0.08'),
    ZR10: new Decimal('0.10'),
    ZR12: new Decimal('0.12'),
    ZR14: new Decimal('0.14'),
    ZR16: new Decimal('0.16'),
    ZR18: new Decimal('0.18'),
    ZR20: new Decimal('0.20'),
    ZR25: new Decimal('0.25'),
};

/** 93683 Čelovka DELPHIN Compact -- reálná data z feedu. */
const BASE = new Decimal('14.94');
/** Celoroční akce DELPHIN 15 % (policy-v1.json brandSaleDiscounts). */
const BRAND_SALE = new Decimal('12.70');

const highest = new HighestDiscountRule(CTX);

describe('brandSale vs. loyalty -- vyhrává VYŠŠÍ sleva, nesčítá se', () => {
    it('tier NIŽŠÍ než akce (ZR8 = 8 % < 15 %) → vyhrává AKCE', () => {
        const r = highest.evaluate({
            basePrice: BASE,
            salePrice: BRAND_SALE,
            customerTier: 'ZR8',
            allowLoyaltyDiscount: true,
            loyaltyTiers: TIERS,
        });

        expect(r.applied).toBe(true);
        expect(r.rule).toBe('SALE');
        expect(r.price?.toString()).toBe('12.7');
    });

    it('tier VYŠŠÍ než akce (ZR25 = 25 % > 15 %) → vyhrává TIER', () => {
        // 14,94 × 0,75 = 11,205. Tohle je hodnota, kterou má ceník --
        // a tedy ta správná. Badge s 12,71 je chybný.
        const r = highest.evaluate({
            basePrice: BASE,
            salePrice: BRAND_SALE,
            customerTier: 'ZR25',
            allowLoyaltyDiscount: true,
            loyaltyTiers: TIERS,
        });

        expect(r.applied).toBe(true);
        expect(r.rule).toBe('LOYALTY');
        expect(r.price?.toString()).toBe('11.205');
    });

    it('NIKDY se nesčítají: ZR25 na akční cenu by dalo 9,525 -- to se stát nesmí', () => {
        // 12,70 × 0,75 = 9,525. Kdyby se slevy sčítaly, vyšlo by tohle.
        const r = highest.evaluate({
            basePrice: BASE,
            salePrice: BRAND_SALE,
            customerTier: 'ZR25',
            allowLoyaltyDiscount: true,
            loyaltyTiers: TIERS,
        });

        expect(r.price?.toString()).not.toBe('9.525');
        // Počítá se z BASE, ne z akční ceny.
        expect(r.price?.toString()).toBe('11.205');
    });

    it('hranice: tier přesně na úrovni akce → ROVNOST jde do LOYALTY větve', () => {
        // Legacy chování (bod 4 v hlavičce HighestDiscountRule): strict
        // lessThan, ne <=. Při shodné ceně vyhrává LOYALTY.
        const fifteen = { ZR15: new Decimal('0.15') };
        const r = highest.evaluate({
            basePrice: BASE,
            salePrice: BRAND_SALE,
            customerTier: 'ZR15',
            allowLoyaltyDiscount: true,
            loyaltyTiers: fifteen,
        });

        expect(r.rule).toBe('LOYALTY');
        expect(r.price?.toString()).toBe('12.699');
    });

    it('produkt bez akce → platí čistě tier', () => {
        const r = highest.evaluate({
            basePrice: BASE,
            customerTier: 'ZR25',
            allowLoyaltyDiscount: true,
            loyaltyTiers: TIERS,
        });

        expect(r.rule).toBe('LOYALTY');
        expect(r.price?.toString()).toBe('11.205');
    });

    it('allowLoyaltyDiscount = false → platí jen akce, i u vysokého tieru', () => {
        // Přesně tenhle příznak posílá pricing-bridge.ts:87 natvrdo jako
        // `true` místo čtení z feedu -- odtud rozdíl mezi enginy.
        const r = highest.evaluate({
            basePrice: BASE,
            salePrice: BRAND_SALE,
            customerTier: 'ZR25',
            allowLoyaltyDiscount: false,
            loyaltyTiers: TIERS,
        });

        expect(r.rule).toBe('SALE');
        expect(r.price?.toString()).toBe('12.7');
    });
});

describe('krok 2 -- strop se uplatní AŽ PO výběru vyšší slevy', () => {
    const limit = new DiscountLimitRule(CTX);

    it('strop 10 % osekne tier 25 % zpět na 13,446', () => {
        // Pořadí z Luckyho pravidla: nejdřív max(akce, tier), pak strop.
        const chosen = highest.evaluate({
            basePrice: BASE,
            salePrice: BRAND_SALE,
            customerTier: 'ZR25',
            allowLoyaltyDiscount: true,
            loyaltyTiers: TIERS,
        });
        expect(chosen.price?.toString()).toBe('11.205');

        const capped = limit.evaluate({
            basePrice: BASE,
            currentPrice: chosen.price as Decimal,
            productMaxDiscount: new Decimal('0.10'),
            brandLimits: {},
            categoryLimits: {},
        });

        // 14,94 × 0,90 = 13,446
        expect(capped.applied).toBe(true);
        expect(capped.price?.toString()).toBe('13.446');
    });

    it('DELPHIN v produkci strop NEMÁ -- 11,205 projde nedotčeno', () => {
        // policy-v1.json: DELPHIN je v brandSaleDiscounts, ale ne v brandLimits.
        const capped = limit.evaluate({
            basePrice: BASE,
            currentPrice: new Decimal('11.205'),
            manufacturer: 'DELPHIN',
            brandLimits: {},
            categoryLimits: {},
        });

        expect(capped.applied).toBe(false);
    });

    it('strop 0 % (zero-discount produkt) vrátí cenu na základní', () => {
        // Potvrzeno Luckym: "strop je jako že tam nesmí být žádná sleva".
        const capped = limit.evaluate({
            basePrice: BASE,
            currentPrice: new Decimal('11.205'),
            productMaxDiscount: new Decimal(0),
            brandLimits: {},
            categoryLimits: {},
        });

        expect(capped.applied).toBe(true);
        expect(capped.price?.toString()).toBe('14.94');
    });
});
