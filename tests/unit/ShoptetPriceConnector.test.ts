// ShoptetPriceConnector -- první skutečná implementace Connector kontraktu.
//
// Těžiště testů:
//   1. Konektor NIKDY nepočítá cenu -- jen překládá tvar. Kdyby počítal,
//      byla by business logika na dvou místech a shadow parita by přestala
//      dávat smysl.
//   2. Zaokrouhlení se NEDĚLÁ. Cena se třemi desetinnými místy je chyba
//      výš v řetězu a musí být VIDĚT -- tichý ořez by ji schoval.
//      (Přesně ten haléřový rozdíl, co shadow harness našel mezi okfish
//      enginy: root Math.round vs. worker integer-cents.)
//   3. `isDefiniteFailure` je fail-closed. Chybné FAILED vede na retry
//      a možný dvojí zápis; chybné UNKNOWN jen na reconciliaci.

import { describe, it, expect } from 'vitest';
import {
    ShoptetPriceConnector,
    SHOPTET_PRICE_SEMANTICS,
    parsePriceToMinor,
    minorToPriceString,
} from '../../connectors/shoptet/ShoptetPriceConnector.js';

const TIER_MAP = { ZR4: 1, ZR20: 20, ZR25: 25 } as const;

function makeConnector(): ShoptetPriceConnector {
    return new ShoptetPriceConnector('shoptet-okfish', TIER_MAP);
}

describe('Connector kontrakt', () => {
    it('deklaruje capabilities a typ', () => {
        const c = makeConnector();

        expect(c.connectorType).toBe('shoptet-api');
        expect(c.capabilities.canRead).toBe(true);
        expect(c.capabilities.canWrite).toBe(true);
        expect(c.capabilities.requiresApi).toBe(true);
    });

    it('odmítne mapu, kde dva tiery míří na tentýž pricelist', () => {
        // Překlad zpět by byl nejednoznačný -- radši selhat při konstrukci
        // než tiše vracet špatný tier.
        expect(() => new ShoptetPriceConnector('x', { ZR20: 5, ZR25: 5 })).toThrow(
            /namapovaný na víc tierů/,
        );
    });
});

describe('toCanonical -- Shoptet → canonical', () => {
    it('přeloží řádek včetně tieru a haléřů', () => {
        const result = makeConnector().toCanonical({
            code: '93683',
            pricelistId: 25,
            price: '12.71',
            currency: 'EUR',
        });

        expect(result).toEqual({
            productCode: '93683',
            tierKey: 'ZR25',
            priceMinor: 1271,
            currency: 'EUR',
        });
    });

    it('neznámý pricelist = chyba, konektor NEHÁDÁ', () => {
        expect(() =>
            makeConnector().toCanonical({
                code: 'x',
                pricelistId: 999,
                price: '1.00',
                currency: 'EUR',
            }),
        ).toThrow(/nemá mapování na tier/);
    });
});

describe('toExternal -- canonical → Shoptet', () => {
    it('přeloží zpět', () => {
        const result = makeConnector().toExternal({
            productCode: '93683',
            tierKey: 'ZR25',
            priceMinor: 1271,
            currency: 'EUR',
        });

        expect(result).toEqual({
            code: '93683',
            pricelistId: 25,
            price: '12.71',
            currency: 'EUR',
        });
    });

    it('round-trip nemění hodnotu', () => {
        const c = makeConnector();
        const original = { code: '111', pricelistId: 20, price: '1707.50', currency: 'EUR' };

        expect(c.toExternal(c.toCanonical(original))).toEqual(original);
    });

    it('neznámý tier = chyba', () => {
        expect(() =>
            makeConnector().toExternal({
                productCode: 'x',
                tierKey: 'ZR99',
                priceMinor: 100,
                currency: 'EUR',
            }),
        ).toThrow(/nemá mapování na Shoptet pricelist/);
    });
});

describe('buildWritePayload', () => {
    it('sestaví PATCH cestu a tělo', () => {
        const result = makeConnector().buildWritePayload({
            productCode: '93683',
            tierKey: 'ZR25',
            priceMinor: 1121,
            currency: 'EUR',
        });

        expect(result.path).toBe('/api/products/code/93683');
        expect(result.body).toEqual({ pricelists: [{ id: 25, price: '11.21' }] });
    });

    it('escapuje kód produktu v cestě', () => {
        const result = makeConnector().buildWritePayload({
            productCode: 'SW304/ATOLL S',
            tierKey: 'ZR4',
            priceMinor: 100,
            currency: 'EUR',
        });

        expect(result.path).toBe('/api/products/code/SW304%2FATOLL%20S');
    });
});

describe('parsePriceToMinor -- žádné tiché zaokrouhlení', () => {
    it('převede běžné tvary', () => {
        expect(parsePriceToMinor('12.71', 'x')).toBe(1271);
        expect(parsePriceToMinor('0.01', 'x')).toBe(1);
        expect(parsePriceToMinor('100', 'x')).toBe(10000);
        expect(parsePriceToMinor('1.5', 'x')).toBe(150);
        expect(parsePriceToMinor('-5.25', 'x')).toBe(-525);
    });

    it('TŘI desetinná místa = CHYBA, ne zaokrouhlení', () => {
        // 1.955 je přesně ta hodnota, na které se okfish enginy rozešly
        // (root dal 1.95, worker 1.96). Tichý ořez by chybu schoval.
        expect(() => parsePriceToMinor('1.955', 'DELPHIN-93683')).toThrow(
            /Zaokrouhlení se tu NEDĚLÁ/,
        );
    });

    it('odmítne nečíselné a exotické tvary', () => {
        expect(() => parsePriceToMinor('12,71', 'x')).toThrow();
        expect(() => parsePriceToMinor('1e3', 'x')).toThrow();
        expect(() => parsePriceToMinor('', 'x')).toThrow();
        expect(() => parsePriceToMinor('abc', 'x')).toThrow();
        expect(() => parsePriceToMinor('NaN', 'x')).toThrow();
    });

    it('chybová hláška nese kód produktu -- jinak se to v 50k řádcích nedohledá', () => {
        expect(() => parsePriceToMinor('1.999', 'HONDA-99694')).toThrow(/HONDA-99694/);
    });
});

describe('minorToPriceString', () => {
    it('formátuje vždy na dvě desetinná místa', () => {
        expect(minorToPriceString(1271)).toBe('12.71');
        expect(minorToPriceString(1)).toBe('0.01');
        expect(minorToPriceString(100)).toBe('1.00');
        expect(minorToPriceString(0)).toBe('0.00');
        expect(minorToPriceString(-525)).toBe('-5.25');
    });

    it('odmítne neceločíselné haléře', () => {
        expect(() => minorToPriceString(12.5)).toThrow(/celé číslo haléřů/);
    });

    it('round-trip přes 1707.50 (nejdražší případ ze shadow reportu)', () => {
        expect(minorToPriceString(parsePriceToMinor('1707.50', 'x'))).toBe('1707.50');
    });
});

describe('SHOPTET_PRICE_SEMANTICS -- fail-closed interpretace chyb', () => {
    const { isDefiniteFailure } = SHOPTET_PRICE_SEMANTICS;

    it('je SYSTEM_CONFIRMED, na rozdíl od Omegy', () => {
        expect(SHOPTET_PRICE_SEMANTICS.confirmationQuality).toBe('SYSTEM_CONFIRMED');
    });

    it('nedeklaruje idempotenci -- Shoptet ji nezaručuje', () => {
        expect(SHOPTET_PRICE_SEMANTICS.supportsIdempotency).toBe(false);
    });

    it('4xx = prokazatelné neprovedení', () => {
        expect(isDefiniteFailure('HTTP 400 Bad Request')).toBe(true);
        expect(isDefiniteFailure('401 Unauthorized')).toBe(true);
        expect(isDefiniteFailure('403 Forbidden')).toBe(true);
        expect(isDefiniteFailure('404 Not Found')).toBe(true);
        expect(isDefiniteFailure('422 Unprocessable Entity')).toBe(true);
        expect(isDefiniteFailure('validation error: price must be positive')).toBe(true);
    });

    it('5xx NENÍ prokazatelné selhání -- server mohl zapsat a spadnout', () => {
        expect(isDefiniteFailure('HTTP 500 Internal Server Error')).toBe(false);
        expect(isDefiniteFailure('502 Bad Gateway')).toBe(false);
        expect(isDefiniteFailure('503 Service Unavailable')).toBe(false);
    });

    it('429 rate limit NENÍ selhání -- požadavek mohl projít', () => {
        expect(isDefiniteFailure('429 Too Many Requests')).toBe(false);
    });

    it('timeout a síť = nejistota', () => {
        expect(isDefiniteFailure('network timeout after 30s')).toBe(false);
        expect(isDefiniteFailure('socket hang up')).toBe(false);
    });

    it('částečný úspěch (INC-016) NENÍ selhání -- 200 OK a odmítnuté položky', () => {
        expect(isDefiniteFailure('partial: 3 of 10 items rejected')).toBe(false);
    });

    it('neznámý text = UNKNOWN, ne FAILED', () => {
        // Fail-closed: chybné FAILED vede na retry a dvojí zápis,
        // chybné UNKNOWN jen na reconciliaci.
        expect(isDefiniteFailure('something completely unexpected')).toBe(false);
    });
});
