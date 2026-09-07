// VoucherRedemptionAudit -- výpočet propadlé částky pro MPV účetnictví.
//
// Těžiště: NIKDY tiše nevrátit nulu. Nula v účetním podkladu znamená
// "nic nepropadlo" -- a když to není pravda, klient zaúčtuje špatně.
// Tam, kde si výpočet není jistý, musí vrátit stav, který volajícího
// donutí rozhodnout.

import { describe, it, expect } from 'vitest';
import {
    auditVoucherRedemption,
    shouldPersistBurnedAmount,
    requiresManualReview,
} from '../../domains/voucher/VoucherRedemptionAudit.js';
import { sumOrderDiscountsMinor } from '../../connectors/shoptet/ShoptetApiClient.js';

const recognised = (discountsMinor: number, nominalMinor = 500_00) => ({
    nominalMinor,
    discountsMinor,
    discountsRecognised: true,
});

describe('auditVoucherRedemption -- výpočet propadlé částky', () => {
    it('poukaz 500, nakoupeno za 300 → propadá 200', () => {
        // Přesně scénář z §18.6: z 5000 nakoupeno za 3000, zbytek je
        // ostatní provozní výnos bez DPH.
        const r = auditVoucherRedemption(recognised(300_00));

        expect(r.kind).toBe('PARTIALLY_REDEEMED');
        if (r.kind === 'PARTIALLY_REDEEMED') {
            expect(r.redeemedMinor).toBe(300_00);
            expect(r.burnedUnclaimedMinor).toBe(200_00);
        }
    });

    it('vyčerpáno beze zbytku → nic k zaúčtování', () => {
        const r = auditVoucherRedemption(recognised(500_00));

        expect(r.kind).toBe('FULLY_REDEEMED');
        if (r.kind === 'FULLY_REDEEMED') expect(r.burnedUnclaimedMinor).toBe(0);
    });

    it('propadl celý poukaz kromě haléře', () => {
        const r = auditVoucherRedemption(recognised(1));

        expect(r.kind).toBe('PARTIALLY_REDEEMED');
        if (r.kind === 'PARTIALLY_REDEEMED') expect(r.burnedUnclaimedMinor).toBe(499_99);
    });
});

describe('fail-loud: kde si nejsme jistí, nezapisuje se nula', () => {
    it('nerozpoznaný tvar slev → UNRECOGNISED, ne nula', () => {
        // Kdyby to vrátilo 0, účetní by dostal "nic nepropadlo" -- což
        // může být lež. NULL v databázi říká "ještě nevíme".
        const r = auditVoucherRedemption({
            nominalMinor: 500_00,
            discountsMinor: 0,
            discountsRecognised: false,
        });

        expect(r.kind).toBe('UNRECOGNISED_DISCOUNTS');
        expect(shouldPersistBurnedAmount(r)).toBe(false);
        expect(requiresManualReview(r)).toBe(true);
    });

    it('žádná sleva na objednávce → NO_VOUCHER_DISCOUNT, taky se nezapisuje', () => {
        const r = auditVoucherRedemption(recognised(0));

        expect(r.kind).toBe('NO_VOUCHER_DISCOUNT');
        expect(shouldPersistBurnedAmount(r)).toBe(false);
        // Není to incident -- objednávka prostě poukaz neuplatnila.
        expect(requiresManualReview(r)).toBe(false);
    });

    it('uplatněno VÍC než nominál → OVER_REDEEMED, jde na člověka', () => {
        // Buď objednávka nese i jinou slevu než náš poukaz, nebo se něco
        // pokazilo. Záporné číslo v účetnictví by bylo horší než alert.
        const r = auditVoucherRedemption(recognised(700_00));

        expect(r.kind).toBe('OVER_REDEEMED');
        expect(shouldPersistBurnedAmount(r)).toBe(false);
        expect(requiresManualReview(r)).toBe(true);
    });

    it('záporná sleva se bere jako nepochopený vstup', () => {
        const r = auditVoucherRedemption(recognised(-100));
        expect(r.kind).toBe('UNRECOGNISED_DISCOUNTS');
    });

    it('neceločíselné haléře se berou jako nepochopený vstup', () => {
        const r = auditVoucherRedemption(recognised(100.5));
        expect(r.kind).toBe('UNRECOGNISED_DISCOUNTS');
    });

    it('nesmyslný nominál je chyba volajícího, ne business stav', () => {
        // Poukaz s nulovou nebo zápornou hodnotou nemohl vzniknout --
        // je to bug, ne případ k zaúčtování.
        expect(() => auditVoucherRedemption(recognised(100, 0))).toThrow(/kladné celé číslo/);
        expect(() => auditVoucherRedemption(recognised(100, -5))).toThrow();
    });
});

describe('sumOrderDiscountsMinor -- čtení slev z odpovědi Shoptetu', () => {
    it('sečte pole slev', () => {
        const r = sumOrderDiscountsMinor({
            discounts: [{ value: '300.00' }, { value: '50.50' }],
        });

        expect(r.recognised).toBe(true);
        expect(r.totalMinor).toBe(350_50);
    });

    it('přijme i jednotlivou slevu pod klíčem `discount`', () => {
        // Tvar odpovědi není ověřený proti produkci -- zkoušejí se obě
        // známé varianty.
        const r = sumOrderDiscountsMinor({ discount: { value: 250 } });

        expect(r.recognised).toBe(true);
        expect(r.totalMinor).toBe(250_00);
    });

    it('zápornou hodnotu bere jako kladnou částku slevy', () => {
        const r = sumOrderDiscountsMinor({ discounts: [{ value: '-300.00' }] });
        expect(r.totalMinor).toBe(300_00);
    });

    it('žádné slevy → recognised: false, ne tichá nula', () => {
        // Nevíme, jestli Shoptet slevy nevrátil, nebo jich nebylo.
        const r = sumOrderDiscountsMinor({ code: '2026001620' });

        expect(r.recognised).toBe(false);
        expect(r.totalMinor).toBe(0);
    });

    it('nečitelná hodnota shodí rozpoznání celého součtu', () => {
        // Jedna nepochopená položka znamená, že součtu nelze věřit --
        // sečíst zbytek a tvářit se, že je to celé, by byla lež.
        const r = sumOrderDiscountsMinor({
            discounts: [{ value: '300.00' }, { value: 'sleva 20 %' }],
        });

        expect(r.recognised).toBe(false);
    });

    it('desetinná čárka místo tečky projde', () => {
        const r = sumOrderDiscountsMinor({ discounts: [{ value: '199,90' }] });
        expect(r.totalMinor).toBe(199_90);
    });

    it('tři desetinná místa neprojdou -- to je float chyba výš', () => {
        const r = sumOrderDiscountsMinor({ discounts: [{ value: '1.955' }] });
        expect(r.recognised).toBe(false);
    });
});

describe('celý tok §18.7 -- od odpovědi API k účetnímu podkladu', () => {
    it('objednávka se slevou 300 z poukazu 500 → zapsat 200', () => {
        const order = { code: '2026001620', discounts: [{ value: '300.00' }] };
        const sum = sumOrderDiscountsMinor(order);

        const audit = auditVoucherRedemption({
            nominalMinor: 500_00,
            discountsMinor: sum.totalMinor,
            discountsRecognised: sum.recognised,
        });

        expect(shouldPersistBurnedAmount(audit)).toBe(true);
        if (shouldPersistBurnedAmount(audit)) {
            expect(audit.burnedUnclaimedMinor).toBe(200_00);
        }
    });

    it('objednávka bez slev → NULL v databázi, ne nula', () => {
        const sum = sumOrderDiscountsMinor({ code: '2026001621' });
        const audit = auditVoucherRedemption({
            nominalMinor: 500_00,
            discountsMinor: sum.totalMinor,
            discountsRecognised: sum.recognised,
        });

        expect(audit.kind).toBe('UNRECOGNISED_DISCOUNTS');
        expect(shouldPersistBurnedAmount(audit)).toBe(false);
    });
});
