// Nexus-side factory -- staví plný Nexus Rule chain (BasePrice ->
// HighestDiscount -> DiscountLimit -> Rounding) a vrací funkci stejné
// signatury jako connectors/pricing-engine/createLegacyPricingCalculator.ts.
//
// SCOPE ZÁMĚRNĚ STEJNÝ JAKO LEGACY CALCULATOR: žádná ValidationRule uvnitř.
// createLegacyPricingCalculator nikdy nevolal ValidationEngine -- validace
// input/output byla vždy samostatný krok mimo calculator (viz
// tests/regression/golden-pricing/golden.test.ts, kde se
// validationEngine.validateInput/validateResult volá explicitně kolem
// engine.calculatePrice()). Kdyby tato factory validaci přidala, chovala
// by se jinak než injekce, kterou nahrazuje (např. záporná basePrice by se
// tiše propočítala v legacy, ale zde by byla odmítnuta) -- to není parita,
// to je změna chování PricingAdapter výstupu. Validace zůstává samostatná
// odpovědnost, řešená mimo tuto factory, stejně jako dnes.
//
// TOTO JE PRODUKČNÍ NÁHRADA za legacy calculator -- parita proti legacy je
// ověřena v tests/regression/golden-pricing/full-chain-parity.test.ts
// (70/70 golden kombinací) a tests/regression/golden-pricing/
// nexus-calculator-parity.test.ts (factory-level parita). Chain pořadí
// a logika je identická -- žádná nová business logika, jen produkční
// zapojení už migrovaných Rules.
//
// Konfigurace odpovídá stejnému policy-v1.json formátu jako legacy
// EngineBuilder.fromConfig() -- žádná nová konfigurace, jen jiná cesta,
// kudy dovnitř přichází (PricingConfigurationProvider místo fs.readFileSync,
// viz P0 poznámka u factory níže).
//
// customerTier guard: legacy engine má `CustomerTier` jako TypeScript union,
// takže neplatný tier je compile-time chyba. Nexus PricingComputationInput
// má customerTier jako `string` (viz Price.ts -- Nexus nesmí zadrátovat
// tenant-specific tiery do core typu), takže stejná ochrana musí být
// runtime check zde -- jinak by neznámý tier tiše propadl přes
// HighestDiscountRule (loyaltyTiers[unknown] === undefined -> loyalty se
// prostě nepoužije) místo aby explicitně selhal. Zachovává chování
// createLegacyPricingCalculator.toCustomerTier().

import Decimal from 'decimal.js';
import { assertTenantContext, type TenantContext } from '../../core/tenant/types.js';
import type { LegacyPricingInput, LegacyPricingResult } from './PricingAdapter.js';
import type { PricingConfigurationProvider } from './PricingConfigurationProvider.js';
import { BasePriceRule } from './BasePriceRule.js';
import { BrandSaleDiscountRule } from './BrandSaleDiscountRule.js';
import { HighestDiscountRule } from './HighestDiscountRule.js';
import { DiscountLimitRule } from './DiscountLimitRule.js';
import { RoundingRule } from './RoundingRule.js';

function toDecimalMap(m: Record<string, number> | undefined): Record<string, Decimal> {
    const out: Record<string, Decimal> = {};
    for (const [k, v] of Object.entries(m ?? {})) out[k] = new Decimal(v);
    return out;
}

/**
 * P0 (2026-09-07) -- DVA vstupy, které se dřív vyráběly uvnitř, teď musí
 * přijít zvenku:
 *
 *   1. `tenant: TenantContext` -- nahrazuje `const ctx = { tenantId: 'ten_1' }`.
 *      Hardcoded tenant by v multi-tenant nasazení promíchal ceny mezi
 *      e-shopy. `assertTenantContext` navíc placeholder hodnotu odmítne
 *      i za běhu, kdyby ji někdo jen přesunul o patro výš.
 *   2. `configProvider: PricingConfigurationProvider` -- nahrazuje
 *      `fs.readFileSync(configPath)`. Doména už nezná filesystem, takže
 *      pricing chain je nasaditelný do Cloudflare Workeru.
 *
 * Signatura je záměrně breaking: volající MUSÍ obojí dodat, jinak to
 * neprojde překladem. Chain, pořadí Rules ani business logika se nemění --
 * parita proti legacy zůstává ověřená stejnými golden testy.
 */
export function createNexusPricingCalculator(
    configProvider: PricingConfigurationProvider,
    tenant: TenantContext
): (input: LegacyPricingInput) => LegacyPricingResult {
    assertTenantContext(tenant, 'createNexusPricingCalculator');

    const config = configProvider.getPolicyConfig(tenant);
    const loyaltyTiers = toDecimalMap(config.loyaltyTiers);
    const brandLimits = toDecimalMap(config.brandLimits);
    const categoryLimits = toDecimalMap(config.categoryLimits);
    const validTiers = Object.keys(config.loyaltyTiers);

    // brandSaleDiscounts -- celoroční akce per značka (DELPHIN 15 %,
    // MIVARDI 10 %, MIKADO 9 %). NENÍ totéž co brandLimits, i když u MIVARDI
    // se čísla náhodou shodují: sleva a strop jsou dvě nezávislá pravidla
    // (viz docs/SHOPTET-PRICING-MODEL.md §6c a okfish
    // CORE_LOGIC_AND_VALIDATION.md §1.3 -- "never derive one from the other").
    const brandSaleDiscounts = toDecimalMap(config.brandSaleDiscounts);

    const ctx = { tenantId: tenant.tenantId, ruleVersion: '1' };
    const basePriceRule = new BasePriceRule({ ...ctx, ruleId: 'base-price-v1' });
    const brandSaleDiscountRule = new BrandSaleDiscountRule({ ...ctx, ruleId: 'brand-sale-v1' });
    const highestDiscountRule = new HighestDiscountRule({ ...ctx, ruleId: 'highest-discount-v1' });
    const discountLimitRule = new DiscountLimitRule({ ...ctx, ruleId: 'discount-limit-v1' });
    const roundingRule = new RoundingRule({ ...ctx, ruleId: 'rounding-v1' });

    return (input: LegacyPricingInput): LegacyPricingResult => {
        if (input.customerTier !== undefined && !validTiers.includes(input.customerTier)) {
            throw new Error(`Unknown customerTier "${input.customerTier}" -- not one of legacy loyaltyTiers (${validTiers.join(', ')})`);
        }

        const base = basePriceRule.evaluate({ basePrice: input.basePrice });
        let currentPrice = base.price;
        const appliedRules: { rule: string }[] = [{ rule: base.rule }];

        // brandSale syntéza -- MUSÍ být PŘED HighestDiscountRule.
        //
        // Okfish to dělá v `calculateAllTierPrices()` hned po no-op guardu:
        // nemá-li produkt vlastní akční cenu a jeho značka má celoroční akci,
        // akční cena se DOPOČÍTÁ. Od té chvíle je to obyčejná akční cena
        // a všechna navazující pravidla (max(akce, tier), clearance-vs-cap)
        // se na ni vztahují beze změny.
        //
        // Kdyby to běželo až za HighestDiscountRule, syntetizovaná cena by
        // se s tierem nikdy neporovnala a DELPHIN/MIKADO/MIVARDI by
        // na nízkých tierech dostaly horší cenu, než mají mít.
        const brandSale = brandSaleDiscountRule.evaluate({
            basePrice: input.basePrice,
            effectiveSalePrice: input.salePrice,
            manufacturer: input.manufacturer,
            brandSaleDiscounts,
        });
        const effectiveSalePrice = brandSale.effectiveSalePrice;
        if (brandSale.applied) {
            appliedRules.push({ rule: 'BRAND_SALE' });
        }

        const highest = highestDiscountRule.evaluate({
            basePrice: input.basePrice,
            salePrice: effectiveSalePrice,
            customerTier: input.customerTier,
            allowLoyaltyDiscount: input.allowLoyaltyDiscount,
            loyaltyTiers,
        });
        if (highest.applied && highest.price) {
            currentPrice = highest.price;
            appliedRules.push({ rule: highest.rule! });
        }

        const limit = discountLimitRule.evaluate({
            basePrice: input.basePrice,
            currentPrice,
            // Tatáž syntetizovaná cena, ne `input.salePrice`. Clearance-vs-cap
            // pravidlo (okfish pricing.ts:143-164) říká, že je-li aktivní strop
            // A ZÁROVEŇ akční cena, akční cena vyhrává absolutně. Kdyby sem
            // přišlo `undefined`, strop by u brandSale produktů zaklapl na
            // loyalty-only větev a osekl cenu, která se oseknout nemá.
            salePrice: effectiveSalePrice,
            productMaxDiscount: input.productMaxDiscount,
            manufacturer: input.manufacturer,
            category: input.category,
            brandLimits,
            categoryLimits,
        });
        if (limit.applied && limit.price) {
            currentPrice = limit.price;
            appliedRules.push({ rule: limit.rule! });
        }

        const rounding = roundingRule.evaluate({ currentPrice });
        if (rounding.applied) {
            currentPrice = rounding.finalPrice;
            appliedRules.push({ rule: 'ROUNDING' });
        }

        return { finalPrice: currentPrice, appliedRules, rejected: false };
    };
}
