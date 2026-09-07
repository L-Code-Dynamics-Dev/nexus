// Shadow harness -- dynamické načtení OBOU okfish enginů z živého klonu.
//
// PROČ DYNAMICKÝ IMPORT A NE STATICKÝ: cesta ke klonu je konfigurovatelná
// (env OKFISH_CLONE) a klon leží mimo NEXUS repo. Statický relativní import
// (`../../../.claude/jobs/.../pricing.js`) by NEXUS napevno svázal s jedním
// dočasným adresářem a rozbil by se, jakmile klon zmizí nebo se přesune --
// a rozbil by i `tsc`/vitest pro každého, kdo klon nemá.
//
// ZERO PRODUCTION WRITES: načítají se výhradně dva čistě výpočetní moduly.
// Writer vrstva (`pricelist-writer`, `customer-writer`, `coupon-sales-writer`,
// `client`) se sem NESMÍ dostat -- viz `assertNoWriterModulesLoaded()` níže,
// runtime tripwire, který po načtení projde skutečně natažené moduly.
//
// PROVOZNÍ POZNÁMKA: `pricing-bridge.calculateProductsPricing()` staví engine
// přes `EngineBuilder.fromConfig(path.join(process.cwd(), 'src/config/...'))`,
// tedy relativně k CWD. Skript se proto MUSÍ pouštět s CWD = okfish klon
// (`tools/shadow/run.ts` to zařídí). Kontrolujeme to explicitně, jinak by
// první volání spadlo na ENOENT hluboko v cizím kódu.

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { OKFISH_ROOT } from './okfishConfig.js';

export interface OkfishEngines {
    /** worker mini-engine -- cloudflare-worker/src/engine/pricing.ts */
    calculateAllTierPrices: (
        row: Record<string, string>,
        productLimits?: Record<string, number>
    ) => Record<string, { price: number; usedActionPrice: boolean }>;
    /** root engine přes batch bridge -- shoptet-api/pricing-bridge.ts */
    calculateProductsPricing: (
        products: Array<{ code: string; basePrice: number; actionPrice?: number; manufacturer?: string }>,
        pricelists: Array<{ name: string; id: number }>
    ) => {
        results: Array<{ code: string; prices: Record<string, string>; brandSaleActionPrice?: string }>;
        failures: Array<{ code: string; tier: string; reason: string }>;
    };
}

const WRITER_MODULE_MARKERS = [
    'pricelist-writer',
    'customer-writer',
    'coupon-sales-writer',
    'shoptet-api/client',
];

export function assertOkfishCwd(): void {
    const expected = path.resolve(OKFISH_ROOT);
    const actual = path.resolve(process.cwd());
    if (expected !== actual) {
        throw new Error(
            `[NEXUS_SHADOW] Očekávané CWD je okfish klon (${expected}), ale je ${actual}. ` +
            `pricing-bridge staví cestu ke policy-v1.json přes process.cwd() -- bez správného CWD ` +
            `spadne root engine na ENOENT. Pusť to přes tools/shadow/run.ts.`
        );
    }
}

export async function loadOkfishEngines(): Promise<OkfishEngines> {
    const workerEnginePath = path.join(OKFISH_ROOT, 'cloudflare-worker/src/engine/pricing.ts');
    const bridgePath = path.join(OKFISH_ROOT, 'cloudflare-worker/src/shoptet-api/pricing-bridge.ts');

    for (const p of [workerEnginePath, bridgePath]) {
        if (!fs.existsSync(p)) {
            throw new Error(
                `[NEXUS_SHADOW] okfish engine nenalezen: ${p}. ` +
                `Nastav OKFISH_CLONE na cestu ke klonu okfish-pricing-engine.`
            );
        }
    }

    const workerMod = await import(pathToFileURL(workerEnginePath).href);
    const bridgeMod = await import(pathToFileURL(bridgePath).href);

    if (typeof workerMod.calculateAllTierPrices !== 'function') {
        throw new Error('[NEXUS_SHADOW] worker engine neexportuje calculateAllTierPrices.');
    }
    if (typeof bridgeMod.calculateProductsPricing !== 'function') {
        throw new Error('[NEXUS_SHADOW] pricing-bridge neexportuje calculateProductsPricing.');
    }

    assertNoWriterModulesLoaded();

    return {
        calculateAllTierPrices: workerMod.calculateAllTierPrices,
        calculateProductsPricing: bridgeMod.calculateProductsPricing,
    };
}

/**
 * Runtime tripwire (§4.5 bod 2b návrhu): projde moduly, které Node skutečně
 * natáhl, a selže, jakmile mezi nimi je cokoli z okfish writer vrstvy.
 * Diagnostika, ne jediná ochrana -- hlavní bariéra je, že shadow nikdy
 * nedostane SHOPTET_PRIVATE_API_TOKEN, bez kterého `ShoptetApiClient` hází
 * výjimku už v konstruktoru.
 */
export function assertNoWriterModulesLoaded(): void {
    // tsx běží přes CJS loader hooks, takže require.cache je naplněný.
    let loaded: string[] = [];
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const req = (globalThis as { require?: { cache?: Record<string, unknown> } }).require;
        if (req?.cache) loaded = Object.keys(req.cache);
    } catch { /* v čistém ESM není require -- pak tripwire jen nic nenajde */ }

    const violations = loaded.filter((m) => WRITER_MODULE_MARKERS.some((w) => m.includes(w)));
    if (violations.length > 0) {
        console.error('[NEXUS_SHADOW] [SHADOW_WRITE_BLOCKED] writer vrstva natažena:', violations);
        throw new Error(`[NEXUS_SHADOW] Shadow nesmí načíst okfish writer vrstvu: ${violations.join(', ')}`);
    }
}

/**
 * Nejsilnější vrstva bariéry (§4.5 bod 0): shadow běh nikdy nesmí mít
 * Shoptet token v prostředí. Když ho tam někdo nechá, radši spadneme, než
 * abychom se spoléhali na to, že ho nikdo nepoužije.
 */
export function assertNoShoptetToken(): void {
    if (process.env.SHOPTET_PRIVATE_API_TOKEN) {
        throw new Error(
            '[NEXUS_SHADOW] [SHADOW_WRITE_BLOCKED] SHOPTET_PRIVATE_API_TOKEN je nastavený v prostředí. ' +
            'Shadow běh nesmí mít přístup k produkčnímu tokenu -- odeber ho z env a spusť znovu.'
        );
    }
}
