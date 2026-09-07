// Parity: Nexus BrandSaleDiscountRule vs okfish brandSaleDiscounts syntéza.
//
// Referenční implementace (živý klon okfish, HEAD 3a910e2), obě
// REPLIKOVANÉ zde jako `okfishWorkerApplyPercent` / `okfishBridgeSynthesize`,
// protože okfish repo není závislostí Nexusu -- replika je znak po znaku
// stejná, viz odkazy na řádky u každé funkce.
//
// Očekávané výsledky NEJSOU vymyšlené: jsou převzaté z okfish
// tests/brand-sale-discounts.test.ts, který běží proti skutečnému
// engine/pricing.ts a pricing-bridge.ts.
//
// Reálná data: fixtures/okfish-policy/policy-v1.json je BITOVÁ KOPIE
// produkčního policy souboru z okfishe.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Decimal from 'decimal.js';
import {
    BrandSaleDiscountRule,
    type BrandSaleDiscountRuleInput,
} from '../../../domains/pricing/BrandSaleDiscountRule.js';
import { NoOpActionPriceRule } from '../../../domains/pricing/NoOpActionPriceRule.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POLICY_DIR = path.join(__dirname, 'fixtures/okfish-policy');

const policy = JSON.parse(
    fs.readFileSync(path.join(POLICY_DIR, 'policy-v1.json'), 'utf-8')
) as {
    loyaltyTiers: Record<string, number>;
    brandSaleDiscounts: Record<string, number>;
    brandLimits: Record<string, number>;
};

const CTX = { tenantId: 'ten_okfish', ruleId: 'brand-sale-v1', ruleVersion: '1' };
const NOOP_CTX = { tenantId: 'ten_okfish', ruleId: 'noop-action-price-v1', ruleVersion: '1' };

function decimalMap(m: Record<string, number>): Record<string, Decimal> {
    const out: Record<string, Decimal> = {};
    for (const [k, v] of Object.entries(m)) out[k] = new Decimal(v);
    return out;
}

const BRAND_SALE_DISCOUNTS = decimalMap(policy.brandSaleDiscounts);

/** okfish cloudflare-worker/src/engine/pricing.ts:57-60 -- integer-cents. */
function okfishWorkerApplyPercent(basePrice: number, pct: number): number {
    const baseCents = Math.round(basePrice * 100);
    return Math.round((baseCents * (100 - pct)) / 100) / 100;
}

/** okfish cloudflare-worker/src/shoptet-api/pricing-bridge.ts:69 -- naivní float. */
function okfishBridgeSynthesize(basePrice: number, ratio: number): number {
    return Math.round(basePrice * (1 - ratio) * 100) / 100;
}

function runRule(
    basePrice: string,
    manufacturer?: string,
    effectiveSalePrice?: string
) {
    const rule = new BrandSaleDiscountRule(CTX);
    const input: BrandSaleDiscountRuleInput = {
        basePrice: new Decimal(basePrice),
        effectiveSalePrice:
            effectiveSalePrice !== undefined ? new Decimal(effectiveSalePrice) : undefined,
        manufacturer,
        brandSaleDiscounts: BRAND_SALE_DISCOUNTS,
    };
    return rule.evaluate(input);
}

describe('policy-v1.json fixture: brandSaleDiscounts je bitová kopie okfish produkce', () => {
    // Zrcadlí okfish tests/brand-sale-discounts.test.ts:28-53.
    it('má přesně čtyři potvrzená brandová pravidla', () => {
        expect(policy.brandSaleDiscounts).toEqual({
            DELPHIN: 0.15,
            'DELPHIN BOMB': 0.15,
            MIVARDI: 0.1,
            MIKADO: 0.09,
        });
    });

    it('DELPHIN, DELPHIN BOMB a MIKADO NEMAJÍ odpovídající brandLimits záznam', () => {
        // Nejdůležitější tvrzení: brandSaleDiscount se nikdy nesmí tiše
        // proměnit ve strop. Kdyby někdo "užitečně" doplnil brandLimits,
        // tenhle test padne.
        expect(policy.brandLimits['DELPHIN']).toBeUndefined();
        expect(policy.brandLimits['DELPHIN BOMB']).toBeUndefined();
        expect(policy.brandLimits['MIKADO']).toBeUndefined();
    });

    it('MIVARDI má záměrně OBOJÍ, nezávisle deklarované', () => {
        expect(policy.brandSaleDiscounts['MIVARDI']).toBe(0.1);
        expect(policy.brandLimits['MIVARDI']).toBe(0.1);
    });
});

describe('BrandSaleDiscountRule -- syntéza akční ceny', () => {
    it('DELPHIN bez vlastní akční ceny: syntetizuje -15 %', () => {
        const r = runRule('100', 'DELPHIN');
        expect(r.applied).toBe(true);
        expect(r.effectiveSalePrice!.toFixed(2)).toBe('85.00');
        expect(r.synthesizedFromBrand).toBe('DELPHIN');
    });

    it('DELPHIN BOMB (přesný řetězec s mezerou): také -15 %', () => {
        const r = runRule('100', 'DELPHIN BOMB');
        expect(r.applied).toBe(true);
        expect(r.effectiveSalePrice!.toFixed(2)).toBe('85.00');
    });

    it('MIVARDI: -10 %', () => {
        expect(runRule('100', 'MIVARDI').effectiveSalePrice!.toFixed(2)).toBe('90.00');
    });

    it('MIKADO: -9 %', () => {
        expect(runRule('100', 'MIKADO').effectiveSalePrice!.toFixed(2)).toBe('91.00');
    });

    it('neznámá značka: no-op, žádná syntéza', () => {
        const r = runRule('100', 'SOME_OTHER_BRAND');
        expect(r.applied).toBe(false);
        expect(r.effectiveSalePrice).toBeUndefined();
        expect(r.synthesizedFromBrand).toBeUndefined();
    });

    it('značka bez slevy = přesně ta samá cesta jako žádný manufacturer', () => {
        expect(runRule('100', undefined).applied).toBe(false);
        expect(runRule('100', '').applied).toBe(false); // prázdný string je falsy
    });

    it('existující vlastní akční cena se NIKDY nepřepíše', () => {
        const r = runRule('100', 'DELPHIN', '70');
        expect(r.applied).toBe(false);
        expect(r.effectiveSalePrice!.toFixed(2)).toBe('70.00');
        expect(r.synthesizedFromBrand).toBeUndefined();
    });

    it('vlastní akční cena MĚLČÍ než brandová (95 > 85) se přesto respektuje', () => {
        // okfish syntetizuje jen když salePrice === undefined -- nikdy
        // neporovnává, která je hlubší. Zachováno 1:1.
        const r = runRule('100', 'DELPHIN', '95');
        expect(r.applied).toBe(false);
        expect(r.effectiveSalePrice!.toFixed(2)).toBe('95.00');
    });

    it('basePrice = 0: žádná syntéza (pricing-bridge.ts:68 `basePriceNum > 0`)', () => {
        const r = runRule('0', 'DELPHIN');
        expect(r.applied).toBe(false);
        expect(r.effectiveSalePrice).toBeUndefined();
    });

    it('záporná basePrice: žádná syntéza', () => {
        expect(runRule('-10', 'DELPHIN').applied).toBe(false);
    });
});

describe('NoOpActionPriceRule -> BrandSaleDiscountRule: závazné pořadí', () => {
    const noop = new NoOpActionPriceRule(NOOP_CTX);

    function pipeline(basePrice: string, actionPrice: string | undefined, manufacturer?: string) {
        const guarded = noop.evaluate({
            basePrice: new Decimal(basePrice),
            actionPrice: actionPrice !== undefined ? new Decimal(actionPrice) : undefined,
        });
        const rule = new BrandSaleDiscountRule(CTX);
        return {
            guarded,
            brand: rule.evaluate({
                basePrice: new Decimal(basePrice),
                effectiveSalePrice: guarded.effectiveSalePrice,
                manufacturer,
                brandSaleDiscounts: BRAND_SALE_DISCOUNTS,
            }),
        };
    }

    it('DELPHIN s no-op akční cenou (actionPrice == price) DOSTANE brandovou -15 %', () => {
        // Tohle je jádro věci: guard nejdřív zahodí mrtvé pole, TEPRVE PAK
        // se značka smí projevit. Bez guardu by 100.00 zablokovalo syntézu.
        const { guarded, brand } = pipeline('100', '100', 'DELPHIN');
        expect(guarded.applied).toBe(true);
        expect(brand.applied).toBe(true);
        expect(brand.effectiveSalePrice!.toFixed(2)).toBe('85.00');
    });

    it('DELPHIN s reálnou akční cenou (70 < 100) si ji ponechá', () => {
        const { guarded, brand } = pipeline('100', '70', 'DELPHIN');
        expect(guarded.applied).toBe(false);
        expect(brand.applied).toBe(false);
        expect(brand.effectiveSalePrice!.toFixed(2)).toBe('70.00');
    });

    it('bez značky a s no-op akční cenou nezůstane žádná salePrice', () => {
        const { brand } = pipeline('100', '100', 'NEZNAMA');
        expect(brand.effectiveSalePrice).toBeUndefined();
    });
});

describe('Rounding parity: Nexus Decimal vs okfish worker applyPercent (vyčerpávající)', () => {
    // Důkaz tvrzení z hlavičky BrandSaleDiscountRule.ts: Decimal
    // ROUND_HALF_UP dává identický výsledek jako okfishova integer-cents
    // matematika. 700 000 základních cen x 3 reálné sazby = 2,1 mil. dvojic.
    //
    // Rozsah 0,01-7 000,00 EUR pokrývá CELÝ reálný okfish katalog: nejdražší
    // položka v products.csv (16 633 řádků) stojí 6 830,01 EUR.
    const MAX_CENTS = 700_000;

    it.each([
        ['DELPHIN / DELPHIN BOMB', 0.15],
        ['MIVARDI', 0.1],
        ['MIKADO', 0.09],
    ])('%s: shoda na všech cenách 0,01-7 000,00 EUR', (_label, ratio) => {
        const one = new Decimal('1');
        const factor = one.minus(ratio);
        let mismatches = 0;
        let firstMismatch: unknown;
        for (let cents = 1; cents <= MAX_CENTS; cents++) {
            const base = cents / 100;
            const okfish = okfishWorkerApplyPercent(base, ratio * 100);
            const nexus = new Decimal(cents)
                .div(100)
                .mul(factor)
                .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
                .toNumber();
            if (okfish !== nexus) {
                mismatches++;
                firstMismatch ??= { base, okfish, nexus };
            }
        }
        expect({ mismatches, firstMismatch }).toEqual({
            mismatches: 0,
            firstMismatch: undefined,
        });
    }, 60_000);

    it('ZDOKUMENTOVANÝ ROZDÍL: okfish bridge se od okfish workeru sám liší', () => {
        // Nález, ne regrese -- viz hlavička BrandSaleDiscountRule.ts.
        // pricing-bridge.ts:69 nikdy nedostal opravu z pricing.ts:57-60.
        // Nexus se shoduje s WORKEREM (správná varianta).
        const cases: Array<[number, number, string, string]> = [
            [1.15, 0.1, '1.04', '1.03'],
            [1.5, 0.15, '1.28', '1.27'],
            [2.65, 0.1, '2.39', '2.38'],
            [4.35, 0.1, '3.92', '3.91'],
        ];
        for (const [base, ratio, workerExpected, bridgeExpected] of cases) {
            expect(okfishWorkerApplyPercent(base, ratio * 100).toFixed(2)).toBe(workerExpected);
            expect(okfishBridgeSynthesize(base, ratio).toFixed(2)).toBe(bridgeExpected);
            // Nexus sedí na worker větev.
            const brand = ratio === 0.15 ? 'DELPHIN' : 'MIVARDI';
            expect(runRule(String(base), brand).effectiveSalePrice!.toFixed(2)).toBe(
                workerExpected
            );
        }
    });
});
