// ReadOnlyGuard -- zámek proti zápisu do živého Shoptetu.
//
// Token, se kterým NEXUS pracuje, je PRODUKČNÍ okfish.sk. Tyhle testy
// existují proto, aby "nezapisovat na živý web" nebyl slib, ale vlastnost
// kódu, kterou nejde omylem porušit.

import { describe, it, expect } from 'vitest';
import {
    assertRequestAllowed,
    describeRequest,
    ShoptetWriteBlockedError,
    READ_ONLY,
    type ShoptetAccessMode,
} from '../../connectors/shoptet/ReadOnlyGuard.js';

const LIVE = 'https://api.myshoptet.com/api/products/code/93683';

describe('read-only režim -- výchozí a neprůstřelný', () => {
    it('GET / HEAD / OPTIONS projdou', () => {
        for (const method of ['GET', 'HEAD', 'OPTIONS', 'get', 'head']) {
            expect(() => assertRequestAllowed({ method, url: LIVE }, READ_ONLY)).not.toThrow();
        }
    });

    it('PATCH / POST / PUT / DELETE jsou zablokované', () => {
        for (const method of ['PATCH', 'POST', 'PUT', 'DELETE']) {
            expect(() => assertRequestAllowed({ method, url: LIVE }, READ_ONLY)).toThrow(
                ShoptetWriteBlockedError,
            );
        }
    });

    it('malá písmena zámek neobejdou', () => {
        expect(() => assertRequestAllowed({ method: 'patch', url: LIVE }, READ_ONLY)).toThrow(
            ShoptetWriteBlockedError,
        );
    });

    it('FAIL-CLOSED: neznámá metoda se bere jako zápis', () => {
        // Kdyby Shoptet zavedl něco nového, propustit to "protože to není
        // v seznamu" by bylo přesně to selhání, kterému se guard vyhýbá.
        expect(() => assertRequestAllowed({ method: 'MERGE', url: LIVE }, READ_ONLY)).toThrow(
            ShoptetWriteBlockedError,
        );
    });

    it('chybová hláška říká, CO se blokovalo a proč', () => {
        try {
            assertRequestAllowed({ method: 'PATCH', url: LIVE }, READ_ONLY);
            expect.unreachable('mělo hodit');
        } catch (e) {
            const msg = (e as Error).message;
            expect(msg).toContain('PATCH');
            expect(msg).toContain(LIVE);
            expect(msg).toContain('ŽIVÉHO SHOPTETU');
        }
    });
});

describe('write-enabled -- vědomé povolení, ne přepínač', () => {
    const enabled: ShoptetAccessMode = {
        mode: 'write-enabled',
        justification: 'Fáze B: zápis kredit produktu do sandboxu',
        allowedHost: 'sandbox.myshoptet.com',
    };

    it('povolený host projde', () => {
        expect(() =>
            assertRequestAllowed(
                { method: 'PATCH', url: 'https://sandbox.myshoptet.com/api/x' },
                enabled,
            ),
        ).not.toThrow();
    });

    it('JINÝ host je zablokovaný -- povolení pro sandbox neplatí na produkci', () => {
        // Tohle je ta nejdůležitější asserce v souboru: kdyby se host
        // nekontroloval, povolení zápisu do sandboxu by tiše platilo
        // i pro api.myshoptet.com.
        expect(() => assertRequestAllowed({ method: 'PATCH', url: LIVE }, enabled)).toThrow(
            /zápis povolen jen pro "sandbox\.myshoptet\.com"/,
        );
    });

    it('prázdné zdůvodnění zápis nepovolí', () => {
        expect(() =>
            assertRequestAllowed(
                { method: 'PATCH', url: 'https://sandbox.myshoptet.com/api/x' },
                { mode: 'write-enabled', justification: '   ', allowedHost: 'sandbox.myshoptet.com' },
            ),
        ).toThrow(/bez zdůvodnění/);
    });

    it('neplatná URL se bere jako zápis, ne jako výjimka k propuštění', () => {
        expect(() =>
            assertRequestAllowed({ method: 'POST', url: 'ne-url' }, enabled),
        ).toThrow(/neplatná URL/);
    });

    it('čtení projde i ve write-enabled režimu, na jakémkoli hostu', () => {
        expect(() => assertRequestAllowed({ method: 'GET', url: LIVE }, enabled)).not.toThrow();
    });
});

describe('describeRequest -- dry-run výpis místo odeslání', () => {
    it('vypíše metodu, URL a tělo', () => {
        const out = describeRequest({
            method: 'patch',
            url: LIVE,
            body: { pricelists: [{ id: 29, price: '11.21' }] },
        });

        expect(out).toContain('PATCH');
        expect(out).toContain('11.21');
    });

    it('dlouhé tělo zkrátí -- hromadný PATCH nesmí zaplavit log', () => {
        const big = { items: Array.from({ length: 5000 }, (_, i) => ({ code: `p${i}` })) };
        const out = describeRequest({ method: 'PATCH', url: LIVE, body: big }, 500);

        expect(out).toContain('zkráceno');
        expect(out.length).toBeLessThan(900);
    });

    it('neserializovatelné tělo shodí výpis, ne běh', () => {
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;

        expect(describeRequest({ method: 'POST', url: LIVE, body: cyclic })).toContain(
            'nejde serializovat',
        );
    });
});
