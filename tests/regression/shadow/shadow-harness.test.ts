// Testy SHADOW HARNESSU samotného -- ne cenové logiky.
//
// Co se tu ověřuje: že harness dělá to, co tvrdí, a hlavně že NEMŮŽE udělat
// to, co má zakázané. Cenová parita se měří během (tools/shadow/run.sh),
// ne unit testem -- ta potřebuje reálný feed a živý okfish klon, které v CI
// nejsou.
//
// ZÁMĚRNĚ BEZ ZÁVISLOSTI NA OKFISH KLONU: klon je dočasný adresář v
// ~/.claude/jobs/. Test, který by ho vyžadoval, by v CI selhal u kohokoli
// jiného. Testuje se proto jen to, co je čistě v NEXUSu: CSV parser,
// klasifikační adaptery a bezpečnostní bariéry.

import { describe, it, expect, afterEach } from 'vitest';
import Decimal from 'decimal.js';
import { parseCsv, parseArgs } from '../../../tools/shadow/feed.js';
import {
    parsePrice,
    resolveAllowLoyaltyDiscount,
    normalizeRow,
    toRootEngineProduct,
    toNexusInput,
} from '../../../tools/shadow/adapters.js';
import { assertNoShoptetToken } from '../../../tools/shadow/okfishEngines.js';
import type { OkfishConfig } from '../../../tools/shadow/okfishConfig.js';

const CFG: OkfishConfig = {
    policyPath: '<test>',
    loyaltyTiersRatio: { ZR4: 0.04, ZR25: 0.25 },
    loyaltyTiersPct: { ZR4: 4, ZR25: 25 },
    tierNames: ['ZR4', 'ZR25'],
    brandLimits: { LOWRANCE: 0.04 },
    categoryLimits: {},
    brandSaleDiscounts: { DELPHIN: 0.15 },
    productLimits: { '999': 0.22 },
    productLimitSource: { '999': 'clearance' },
    clearanceInactiveCodes: [],
};

describe('shadow/feed: CSV parser (parita s okfish CsvParserStream)', () => {
    it('parsuje středníkem oddělený CSV s uvozovkami', () => {
        const rows = parseCsv('code;name;price\n"97062";"nástraha";"6,25"\n');
        expect(rows).toEqual([{ code: '97062', name: 'nástraha', price: '6,25' }]);
    });

    it('odstraní UTF-8 BOM -- jinak by první sloupec nesl jméno "\\ufeffcode" a všechno by se rozešlo', () => {
        const rows = parseCsv('﻿code;price\n"1";"2"\n');
        expect(rows[0]!['code']).toBe('1');
    });

    it('zvládne zdvojenou uvozovku uvnitř hodnoty (reálný případ ve feedu: 1,6"")', () => {
        const rows = parseCsv('code;name\n"46681";"Larva LUX 1,6"""\n');
        expect(rows[0]!['name']).toBe('Larva LUX 1,6"');
    });

    it('zvládne oddělovač uvnitř uvozovek i CRLF', () => {
        const rows = parseCsv('code;name\r\n"1";"a;b"\r\n"2";"c"\r\n');
        expect(rows.map((r) => r['name'])).toEqual(['a;b', 'c']);
    });

    it('chybějící sloupec doplní prázdným řetězcem, ne undefined', () => {
        const rows = parseCsv('code;name;price\n"1";"x"\n');
        expect(rows[0]!['price']).toBe('');
    });

    it('poslední řádek bez koncového newline se nezahodí', () => {
        const rows = parseCsv('code;price\n"1";"5"');
        expect(rows).toHaveLength(1);
    });
});

describe('shadow/feed: parseArgs', () => {
    it('rozliší hodnotové a boolean přepínače', () => {
        expect(parseArgs(['--limit', '500', '--offline', '--out', 'a.json']))
            .toEqual({ limit: '500', offline: true, out: 'a.json' });
    });
});

describe('shadow/adapters: parsePrice (1:1 s okfish worker enginem)', () => {
    it('bere desetinnou čárku, protože feed je v ní', () => {
        expect(parsePrice('6,25')).toBe(6.25);
    });
    it('prázdná hodnota a nesmysl jsou undefined, ne 0 -- 0 by se počítala jako cena', () => {
        expect(parsePrice('')).toBeUndefined();
        expect(parsePrice(undefined)).toBeUndefined();
        expect(parsePrice('abc')).toBeUndefined();
    });
});

describe('shadow/adapters: resolveAllowLoyaltyDiscount', () => {
    it('chybějící hodnota znamená POVOLENO (okfish konvence)', () => {
        expect(resolveAllowLoyaltyDiscount({})).toBe(true);
    });
    it('"1"/"true"/"yes" povolují', () => {
        for (const v of ['1', 'true', 'yes']) {
            expect(resolveAllowLoyaltyDiscount({ applyLoyaltyDiscount: v })).toBe(true);
        }
    });
    it('"0" a prázdný řetězec zakazují', () => {
        expect(resolveAllowLoyaltyDiscount({ applyLoyaltyDiscount: '0' })).toBe(false);
        expect(resolveAllowLoyaltyDiscount({ applyLoyaltyDiscount: '' })).toBe(false);
    });
});

describe('shadow/adapters: normalizeRow', () => {
    it('brandSale se uplatní jen když produkt nemá vlastní actionPrice', () => {
        const withSale = normalizeRow({ code: '1', price: '100', actionPrice: '80', manufacturer: 'DELPHIN' }, CFG);
        const without = normalizeRow({ code: '2', price: '100', manufacturer: 'DELPHIN' }, CFG);
        expect(withSale.brandSaleApplies).toBe(false);
        expect(without.brandSaleApplies).toBe(true);
    });

    it('no-op actionPrice (>= basePrice) brandSale zase odemkne -- stejně jako okfish', () => {
        const p = normalizeRow({ code: '3', price: '100', actionPrice: '100', manufacturer: 'DELPHIN' }, CFG);
        expect(p.brandSaleApplies).toBe(true);
        expect(p.rawActionPrice).toBe(100);
    });

    it('product limit se natáhne ze složené PRODUCT_LIMITS mapy i se zdrojem', () => {
        const p = normalizeRow({ code: '999', price: '10' }, CFG);
        expect(p.productLimit).toBe(0.22);
        expect(p.productLimitSource).toBe('clearance');
    });

    it('basePrice padá na standardPrice, když price chybí', () => {
        expect(normalizeRow({ code: '4', standardPrice: '12,50' }, CFG).basePrice).toBe(12.5);
    });
});

describe('shadow/adapters: toRootEngineProduct', () => {
    it('NEPŘEDÁVÁ productMaxDiscount -- pricing-bridge si ho bere sám z PRODUCT_LIMITS', () => {
        const out = toRootEngineProduct(normalizeRow({ code: '999', price: '10' }, CFG));
        expect(out).not.toHaveProperty('productMaxDiscount');
        expect(out).toEqual({ code: '999', basePrice: 10, actionPrice: undefined, manufacturer: undefined });
    });
});

describe('shadow/adapters: toNexusInput -- tři režimy se musí lišit přesně definovaně', () => {
    const row = { code: '5', price: '100', manufacturer: 'DELPHIN' };

    it('naive: syrová actionPrice, žádný limit', () => {
        const p = normalizeRow({ ...row, actionPrice: '120' }, CFG); // no-op sale
        const inp = toNexusInput(p, 'ZR4', 'naive', CFG.brandSaleDiscounts);
        expect(inp.salePrice?.toNumber()).toBe(120);
        expect(inp.productMaxDiscount).toBeUndefined();
    });

    it('with-limits: přidá jen productMaxDiscount, actionPrice zůstane syrová', () => {
        const p = normalizeRow({ code: '999', price: '100', actionPrice: '120' }, CFG);
        const inp = toNexusInput(p, 'ZR4', 'with-limits', CFG.brandSaleDiscounts);
        expect(inp.salePrice?.toNumber()).toBe(120);
        expect(inp.productMaxDiscount?.toNumber()).toBe(0.22);
    });

    it('adapted: zahodí no-op actionPrice a syntetizuje brandSale', () => {
        const p = normalizeRow({ ...row, actionPrice: '120' }, CFG);
        const inp = toNexusInput(p, 'ZR4', 'adapted', CFG.brandSaleDiscounts);
        // 100 * (1 - 0.15) = 85 -- no-op 120 zahozena, brandSale dosazena
        expect(inp.salePrice?.toNumber()).toBe(85);
    });

    it('adapted: existující reálnou sale NIKDY nepřepíše brandSalem', () => {
        const p = normalizeRow({ ...row, actionPrice: '70' }, CFG);
        const inp = toNexusInput(p, 'ZR4', 'adapted', CFG.brandSaleDiscounts);
        expect(inp.salePrice?.toNumber()).toBe(70);
    });

    it('allowLoyaltyDiscount je vždy true -- pricing-bridge ho posílá natvrdo, P2 se měří proti němu', () => {
        const p = normalizeRow({ ...row, applyLoyaltyDiscount: '0' }, CFG);
        expect(toNexusInput(p, 'ZR4', 'adapted', CFG.brandSaleDiscounts).allowLoyaltyDiscount).toBe(true);
    });

    it('basePrice je Decimal, ne number -- NEXUS chain jiné nebere', () => {
        const inp = toNexusInput(normalizeRow(row, CFG), 'ZR4', 'naive');
        expect(inp.basePrice).toBeInstanceOf(Decimal);
    });
});

describe('shadow: ZERO PRODUCTION WRITES bariéra', () => {
    const original = process.env.SHOPTET_PRIVATE_API_TOKEN;
    afterEach(() => {
        if (original === undefined) delete process.env.SHOPTET_PRIVATE_API_TOKEN;
        else process.env.SHOPTET_PRIVATE_API_TOKEN = original;
    });

    it('bez tokenu projde', () => {
        delete process.env.SHOPTET_PRIVATE_API_TOKEN;
        expect(() => assertNoShoptetToken()).not.toThrow();
    });

    it('s tokenem v prostředí SPADNE -- shadow nesmí mít prostředek k zápisu do produkce', () => {
        process.env.SHOPTET_PRIVATE_API_TOKEN = 'dummy';
        expect(() => assertNoShoptetToken()).toThrow(/SHADOW_WRITE_BLOCKED/);
    });
});

describe('shadow: harness nesmí importovat okfish writer vrstvu', () => {
    it('žádný soubor v tools/shadow/ nezmiňuje writer moduly', async () => {
        const fs = await import('fs');
        const path = await import('path');
        const dir = path.resolve(__dirname, '../../../tools/shadow');
        const forbidden = ['pricelist-writer', 'customer-writer', 'coupon-sales-writer', 'shoptet-api/client'];
        for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
            const src = fs.readFileSync(path.join(dir, f), 'utf-8');
            for (const w of forbidden) {
                // Zmínka ve VÝČTU zakázaných modulů (okfishEngines.ts) je v pořádku;
                // zakázaný je import.
                const importLine = new RegExp(`^\\s*import[^\\n]*${w.replace('/', '\\/')}`, 'm');
                expect(importLine.test(src), `${f} importuje ${w}`).toBe(false);
            }
        }
    });
});
