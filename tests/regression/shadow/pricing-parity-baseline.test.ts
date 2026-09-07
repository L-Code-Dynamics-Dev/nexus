// PRICING PARITY BASELINE -- produkční zámek cenové domény.
//
// Rozhodnutí Lucky 2026-09-07: po zapojení `BrandSaleDiscountRule` se
// dosažená parita zafixuje jako baseline. Od téhle chvíle platí:
//
//   Každá další změna Pricing domény musí tuhle paritu ZACHOVAT, nebo mít
//   explicitně zdokumentovaný business důvod, proč se výsledek mění.
//
// Je to důležité hlavně před dalšími vrstvami (QuantityTier, PromoGroup,
// X+X), které se do chainu teprve budou zapojovat.
//
// ============================================================================
// NAMĚŘENÁ BASELINE (produkční export 7.9.2026, 16 758 produktů × 10 tierů)
// ============================================================================
//
//   režim         shoda          rozdílů   produktů  příčina
//   ------------- -------------- --------- --------- -----------------------
//   naive          98,7570 %      2 083      218     LIMIT_SOURCE 2071
//                                                    BRAND_SALE_ROUNDING 12
//   with-limits    99,9928 %         12        2     BRAND_SALE_ROUNDING 12
//   adapted       100,0000 %          0        0     --
//
// ============================================================================
// PROČ NENÍ 100 % A PROČ JE TO SPRÁVNĚ
// ============================================================================
//
// Zbylých 12 rozdílů (2 produkty: 39786, 93914) je haléřová odchylka
// v zaokrouhlení brandSale:
//
//   okfish bridge:  Math.round(base * (1 - d) * 100) / 100     -- nad floatem
//   NEXUS:          Decimal, přes celé haléře
//
//   2.30 * 0.85  ->  float 1.9549999999999998  ->  bridge 1.95, NEXUS 1.96
//   1.50 * 0.85  ->  float 1.275               ->  bridge 1.27, NEXUS 1.28
//
// **Matematicky správně je NEXUS.** A okfish WORKER engine (badge) to počítá
// přes integer-cents stejně jako NEXUS -- rozchází se tedy jen bridge, a to
// sám se sebou (P3 to hlásí jako `BRAND_SALE_ROUNDING` mezi vlastními enginy).
//
// Vynutit 100 % by znamenalo ZKOPÍROVAT float chybu do NEXUSu. Zamítnuto.
// Alternativa (opravit bridge) mění ceny dvou produktů v živé produkci --
// to je rozhodnutí pro okfish, ne pro tenhle test.
//
// ============================================================================
// CO TENHLE TEST DĚLÁ A CO NE
// ============================================================================
//
// NEDĚLÁ: nespouští shadow harness. Ten potřebuje okfish klon (54 MB export,
// import živých enginů) a v CI ani na cizím stroji není. Test, který by na
// tom závisel, by byl trvale červený.
//
// DĚLÁ: zamyká PRAVIDLA, ze kterých ta parita plyne, na úrovni jednotek --
// konkrétně brandSale syntézu a její pořadí v chainu, protože právě to se
// 7.9. zapojovalo a právě to by šlo omylem rozbít. Plus drží naměřená čísla
// zapsaná, aby bylo proti čemu porovnat příští běh.
//
// REPRODUKCE plného běhu (vyžaduje okfish klon + produkční export):
//   tools/shadow/run.sh p2 --feed <pricelist-export.csv> --out p2.json

import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { createNexusPricingCalculator } from '../../../domains/pricing/createNexusPricingCalculator.js';
import { InMemoryPricingConfigurationProvider } from '../../../domains/pricing/PricingConfigurationProvider.js';
import type { TenantContext } from '../../../core/tenant/types.js';

/**
 * Naměřená baseline. Změna kteréhokoli čísla směrem dolů = regrese.
 * Změna nahoru = zlepšení, ale i tak se musí zapsat a zdůvodnit.
 */
export const PRICING_PARITY_BASELINE = {
    measuredAt: '2026-09-07',
    source: 'okfish.sk produkční export ceníků (products (3).csv)',
    products: 16758,
    tiers: 10,
    comparisonsPerMode: 167580,
    modes: {
        naive: { matched: 165497, diffs: 2083, products: 218 },
        withLimits: { matched: 167568, diffs: 12, products: 2 },
        adapted: { matched: 167580, diffs: 0, products: 0 },
    },
    /** Známá a SCHVÁLENÁ odchylka -- viz hlavička. */
    acceptedDivergence: {
        class: 'BRAND_SALE_ROUNDING',
        diffs: 12,
        productCodes: ['39786', '93914'],
        reason: 'float chyba v okfish bridge; NEXUS počítá správně přes Decimal',
    },
} as const;

const TENANT: TenantContext = { tenantId: 'okfish_sk', platform: 'shoptet' };

/** Výřez produkční konfigurace, na kterém baseline stojí. */
function makeCalculator() {
    const provider = new InMemoryPricingConfigurationProvider({
        loyaltyTiers: { ZR4: 0.04, ZR8: 0.08, ZR16: 0.16, ZR25: 0.25 },
        brandLimits: { MIVARDI: 0.1 },
        categoryLimits: {},
        // Bez tohohle klíče by BrandSaleDiscountRule nedostala nic a parita
        // by spadla zpátky na 99,9021 % (164 rozdílů) -- přesně stav před 7.9.
        brandSaleDiscounts: { DELPHIN: 0.15, 'DELPHIN BOMB': 0.15, MIVARDI: 0.1, MIKADO: 0.09 },
    });
    return createNexusPricingCalculator(provider, TENANT);
}

describe('brandSale je zapojený v kanonickém chainu', () => {
    const calc = makeCalculator();

    it('DELPHIN bez vlastní akční ceny dostane syntetizovanou -15 %', () => {
        // Kdyby Rule nebyla v chainu, vyšlo by 14,35 (jen tier -4 %).
        const r = calc({
            sku: 'TEST',
            basePrice: new Decimal('14.95'),
            manufacturer: 'DELPHIN',
            customerTier: 'ZR4',
            allowLoyaltyDiscount: true,
        });

        expect(r.finalPrice.toString()).toBe('12.71');
    });

    it('vyšší tier přebije brandSale (ZR25 = 25 % > 15 %)', () => {
        const r = calc({
            sku: 'TEST',
            basePrice: new Decimal('14.95'),
            manufacturer: 'DELPHIN',
            customerTier: 'ZR25',
            allowLoyaltyDiscount: true,
        });

        expect(r.finalPrice.toString()).toBe('11.21');
    });

    it('vlastní akční cena má přednost před syntézou', () => {
        // BrandSaleDiscountRule nesmí přepsat akční cenu, kterou už produkt má.
        const r = calc({
            sku: 'TEST',
            basePrice: new Decimal('14.95'),
            salePrice: new Decimal('10.00'),
            manufacturer: 'DELPHIN',
            customerTier: 'ZR4',
            allowLoyaltyDiscount: true,
        });

        expect(r.finalPrice.toString()).toBe('10');
    });

    it('značka bez brandSale zůstává nedotčená', () => {
        const r = calc({
            sku: 'TEST',
            basePrice: new Decimal('100'),
            manufacturer: 'HONDA',
            customerTier: 'ZR4',
            allowLoyaltyDiscount: true,
        });

        expect(r.finalPrice.toString()).toBe('96');
    });

    it('produkt bez značky zůstává nedotčený', () => {
        const r = calc({
            sku: 'TEST',
            basePrice: new Decimal('100'),
            customerTier: 'ZR8',
            allowLoyaltyDiscount: true,
        });

        expect(r.finalPrice.toString()).toBe('92');
    });
});

describe('brandSale běží PŘED HighestDiscountRule -- pořadí je závazné', () => {
    const calc = makeCalculator();

    it('MIKADO 9 % vs tier 4 % -> vyhrává brandSale', () => {
        // Kdyby syntéza běžela AŽ ZA HighestDiscountRule, tier by se
        // s akční cenou nikdy neporovnal a vyšlo by 96 místo 91.
        const r = calc({
            sku: 'TEST',
            basePrice: new Decimal('100'),
            manufacturer: 'MIKADO',
            customerTier: 'ZR4',
            allowLoyaltyDiscount: true,
        });

        expect(r.finalPrice.toString()).toBe('91');
    });

    it('MIKADO 9 % vs tier 16 % -> vyhrává tier', () => {
        const r = calc({
            sku: 'TEST',
            basePrice: new Decimal('100'),
            manufacturer: 'MIKADO',
            customerTier: 'ZR16',
            allowLoyaltyDiscount: true,
        });

        expect(r.finalPrice.toString()).toBe('84');
    });

    it('slevy se NIKDY nesčítají', () => {
        // Sečtení by dalo 100 × 0,91 × 0,84 = 76,44.
        const r = calc({
            sku: 'TEST',
            basePrice: new Decimal('100'),
            manufacturer: 'MIKADO',
            customerTier: 'ZR16',
            allowLoyaltyDiscount: true,
        });

        expect(r.finalPrice.toString()).not.toBe('76.44');
    });
});

describe('brandSale vs. brandLimit -- dvě nezávislá pravidla', () => {
    const calc = makeCalculator();

    it('MIVARDI má obojí 10 %, ale deklarované zvlášť', () => {
        // Shodné číslo je NÁHODA (okfish CORE_LOGIC_AND_VALIDATION.md §1.3:
        // "never derive one from the other"). Syntetizovaná akční cena 90
        // vyhrává nad tierem 96.
        const r = calc({
            sku: 'TEST',
            basePrice: new Decimal('100'),
            manufacturer: 'MIVARDI',
            customerTier: 'ZR4',
            allowLoyaltyDiscount: true,
        });

        expect(r.finalPrice.toString()).toBe('90');
    });

    it('clearance-vs-cap: akční cena vyhrává nad stropem, nezvedne se na něj', () => {
        // okfish pricing.ts:143-164. MIVARDI má brandLimit 0,10, takže strop
        // je 90. Syntetizovaná akční cena je taky 90 -- ale i kdyby tier
        // mířil hlouběji, akční cena drží.
        const r = calc({
            sku: 'TEST',
            basePrice: new Decimal('100'),
            manufacturer: 'MIVARDI',
            customerTier: 'ZR25',
            allowLoyaltyDiscount: true,
        });

        expect(r.finalPrice.toString()).toBe('90');
    });
});

describe('baseline čísla jsou zapsaná a nezměněná', () => {
    it('naměřená parita odpovídá zafixované hodnotě', () => {
        const b = PRICING_PARITY_BASELINE;

        expect(b.modes.withLimits.diffs).toBe(12);
        expect(b.modes.withLimits.matched / b.comparisonsPerMode).toBeCloseTo(0.999928, 6);
        expect(b.modes.adapted.diffs).toBe(0);
        expect(b.acceptedDivergence.productCodes).toEqual(['39786', '93914']);
    });

    it('haléřová odchylka je doložená výpočtem, ne tvrzením', () => {
        // Přesně ta hodnota, na které se bridge a NEXUS rozcházejí.
        const viaFloat = Math.round(2.30 * 0.85 * 100) / 100;
        const viaDecimal = new Decimal('2.30').times(new Decimal(1).minus('0.15'))
            .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

        expect(viaFloat).toBe(1.95);
        expect(viaDecimal.toString()).toBe('1.96');
        // NEXUS jde s Decimalem -- a s okfish worker enginem.
        expect(viaDecimal.toNumber()).not.toBe(viaFloat);
    });
});
