// Shadow harness -- převod jednoho řádku feedu na vstupy obou okfish enginů
// a na vstup NEXUS chainu.
//
// PROČ TENHLE SOUBOR EXISTUJE: každý ze tří enginů dostává v produkci data
// odjinud (worker mini-engine z KV feed řádku, root engine ze Shoptet API,
// NEXUS zatím odnikud). Kdyby harness krmil každý jiným vstupem, měřil by
// rozdíl v DATECH, ne v LOGICE. Tenhle adapter dělá pravý opak: z JEDNOHO
// feed řádku odvodí vstupy pro všechny tři tak, aby se porovnávala výhradně
// matematika.
//
// KDE TO NENÍ VĚRNÉ PRODUKCI (poctivě, ne skrytě):
//   - Root engine v produkci bere basePrice/actionPrice z Shoptet API
//     (pricelist item), ne z feedu. Feed a API se mohou lišit (feed má cenu
//     s DPH podle exportní šablony, API cenu ceníku). Harness proto NEMĚŘÍ
//     "co by root engine dnes zapsal do Shoptetu" -- měří "jak by se oba
//     enginy zachovaly nad stejným vstupem". Přesně to je otázka P3.
//   - `productMaxDiscount` root engine bere z PRODUCT_LIMITS (pricing-bridge
//     řádek 85), NE z feedu -- to harness replikuje věrně.
//   - `allowLoyaltyDiscount` pricing-bridge natvrdo posílá `true` (řádek 87),
//     zatímco worker engine čte `applyLoyaltyDiscount` z řádku. To NENÍ chyba
//     harnessu -- je to reálný rozdíl mezi enginy a P3 ho musí ukázat.

import Decimal from 'decimal.js';
import type { CsvRow } from './feed.js';
import type { OkfishConfig } from './okfishConfig.js';

/** 1:1 `parsePrice` z okfish `cloudflare-worker/src/engine/pricing.ts`. */
export function parsePrice(val: string | undefined): number | undefined {
    if (!val || val.trim() === '') return undefined;
    const normalized = val.replace(',', '.').replace(/\s/g, '');
    const n = parseFloat(normalized);
    return isNaN(n) ? undefined : n;
}

/** 1:1 `resolveAllowLoyaltyDiscount` z worker enginu. */
export function resolveAllowLoyaltyDiscount(row: CsvRow): boolean {
    const val = row['applyLoyaltyDiscount'];
    return val === '1' || val === 'true' || val === 'yes' || val === undefined;
}

export interface NormalizedProduct {
    code: string;
    manufacturer: string | undefined;
    category: string | undefined;
    /** basePrice tak, jak ji čte worker engine: price || priceVat || standardPrice */
    basePrice: number | undefined;
    /** syrová actionPrice z feedu, PŘED no-op guardem a brandSale syntézou */
    rawActionPrice: number | undefined;
    allowLoyaltyDiscount: boolean;
    /** limit z PRODUCT_LIMITS (undefined = žádný product-level limit) */
    productLimit: number | undefined;
    productLimitSource: 'zero-discount' | 'clearance' | 'override' | undefined;
    /** true, pokud brandSale actionPrice bude/byla syntetizována */
    brandSaleApplies: boolean;
    row: CsvRow;
}

export function normalizeRow(row: CsvRow, cfg: OkfishConfig): NormalizedProduct {
    const code = row['code'] ?? '';
    const manufacturer = row['manufacturer'] || undefined;
    const category = row['categoryText'] || undefined;
    const basePrice = parsePrice(row['price'] || row['priceVat'] || row['standardPrice']);
    const rawActionPrice = parsePrice(row['actionPrice'] || row['salePrice']);

    // No-op guard + brandSale: jen pro určení, jestli brandSale VŮBEC dopadne.
    const effectiveAction = rawActionPrice !== undefined && basePrice !== undefined && rawActionPrice >= basePrice
        ? undefined
        : rawActionPrice;
    const brandSaleApplies = effectiveAction === undefined
        && manufacturer !== undefined
        && cfg.brandSaleDiscounts[manufacturer] !== undefined
        && basePrice !== undefined && basePrice > 0;

    return {
        code,
        manufacturer,
        category,
        basePrice,
        rawActionPrice,
        allowLoyaltyDiscount: resolveAllowLoyaltyDiscount(row),
        productLimit: cfg.productLimits[code],
        productLimitSource: cfg.productLimitSource[code],
        brandSaleApplies,
        row,
    };
}

/**
 * Vstup pro root engine přes `calculateProductsPricing` -- přesně ten tvar,
 * jaký mu skládá `sync-orchestrator.ts` řádek 192-197.
 * `productMaxDiscount` se ZÁMĚRNĚ nepředává: pricing-bridge si ho bere sám
 * z PRODUCT_LIMITS podle `p.code` (řádek 85), takže předání zvenku by nic
 * nezměnilo, ale zakrylo by, odkud limit reálně přichází.
 */
export function toRootEngineProduct(p: NormalizedProduct): {
    code: string; basePrice: number; actionPrice: number | undefined; manufacturer: string | undefined;
} {
    return {
        code: p.code,
        basePrice: p.basePrice ?? 0,
        actionPrice: p.rawActionPrice,
        manufacturer: p.manufacturer,
    };
}

/**
 * Vstup pro NEXUS chain (`LegacyPricingInput`). NEXUS nemá brandSale syntézu,
 * no-op guard ani skládání PRODUCT_LIMITS -- tenhle převod je proto ZÁMĚRNĚ
 * "naivní": předá to, co NEXUS dnes reálně umí přijmout. Právě tenhle rozdíl
 * P2 kvantifikuje. Vyplnit sem chybějící logiku by falšovalo shodu.
 *
 * `productMaxDiscount` se předává z PRODUCT_LIMITS (mode 'with-limits'), nebo
 * vůbec (mode 'naive') -- oba běhy chci vidět odděleně, abych rozlišil, kolik
 * rozdílů dělá chybějící skládání limitů a kolik zbytek.
 */
export type NexusInputMode = 'naive' | 'with-limits' | 'adapted';

/**
 * 'adapted' režim -- doplní PŘESNĚ ty čtyři kusy logiky, které NEXUSu podle
 * §3.1 návrhu chybí (no-op actionPrice guard, brandSale syntéza, složené
 * PRODUCT_LIMITS včetně clearance okna). Nic víc.
 *
 * PROČ JE TO V HARNESSU A NE V `domains/`: tohle NENÍ implementace chybějící
 * logiky, je to KONTROLA POCTIVOSTI klasifikace. Když 'adapted' vyjde na
 * 100 %, je dokázáno, že všechny rozdíly v 'naive'/'with-limits' vysvětlují
 * právě tyhle čtyři kusy a nic jiného -- a že tedy "0 UNCLASSIFIED" není
 * důsledek příliš benevolentní klasifikace. Kdyby 'adapted' 100 % nedalo,
 * zbytek je skutečně nevysvětlený rozdíl a patří vyšetřit.
 *
 * Skutečná implementace patří podle §4.8 do adapteru v `connectors/`, a ta
 * tady záměrně NEVZNIKÁ -- harness nesmí rozhodnout návrhovou otázku, na
 * kterou čeká Lucky.
 */
function synthesizeSalePrice(
    p: NormalizedProduct,
    brandSaleDiscounts: Record<string, number>
): number | undefined {
    let action = p.rawActionPrice;
    // No-op guard: actionPrice >= basePrice je zbytek po skončené akci.
    if (action !== undefined && p.basePrice !== undefined && action >= p.basePrice) action = undefined;
    // brandSale syntéza -- jen když produkt vlastní akční cenu nemá.
    if (action === undefined && p.manufacturer !== undefined && (p.basePrice ?? 0) > 0) {
        const d = brandSaleDiscounts[p.manufacturer];
        // Stejná aritmetika jako pricing-bridge (root engine), ne worker
        // applyPercent -- P2 porovnává právě proti root enginu.
        if (d !== undefined) action = Math.round((p.basePrice as number) * (1 - d) * 100) / 100;
    }
    return action;
}

export function toNexusInput(
    p: NormalizedProduct,
    tier: string,
    mode: NexusInputMode,
    brandSaleDiscounts: Record<string, number> = {}
): {
    sku: string; basePrice: Decimal; salePrice?: Decimal; productMaxDiscount?: Decimal;
    customerTier: string; allowLoyaltyDiscount: boolean; manufacturer?: string; category?: string;
} {
    // naive / with-limits: syrová actionPrice z feedu, bez no-op guardu,
    // bez brandSale -- přesně to, co NEXUS dnes umí přijmout.
    const sale = mode === 'adapted'
        ? synthesizeSalePrice(p, brandSaleDiscounts)
        : p.rawActionPrice;

    return {
        sku: p.code,
        basePrice: new Decimal(p.basePrice ?? 0),
        salePrice: sale !== undefined ? new Decimal(sale) : undefined,
        productMaxDiscount: mode !== 'naive' && p.productLimit !== undefined
            ? new Decimal(p.productLimit)
            : undefined,
        customerTier: tier,
        // pricing-bridge posílá natvrdo true; držím se root-engine sémantiky,
        // protože P2 porovnává právě proti root enginu.
        allowLoyaltyDiscount: true,
        manufacturer: p.manufacturer,
        category: p.category,
    };
}
