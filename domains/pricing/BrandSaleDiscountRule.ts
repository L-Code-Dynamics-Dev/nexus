// BrandSaleDiscountRule -- port okfish "brandSaleDiscounts" (celoroční
// brandová akční cena).
//
// ODKUD PORTOVÁNO (živý klon okfish-pricing-engine, HEAD 3a910e2):
//   - cloudflare-worker/src/engine/config.ts:34 (BRAND_SALE_DISCOUNTS,
//     čte `policy.brandSaleDiscounts` z src/config/policies/policy-v1.json)
//   - cloudflare-worker/src/engine/pricing.ts:127-139 (worker mini-engine:
//     syntéza actionPrice přes `applyPercent`)
//   - cloudflare-worker/src/shoptet-api/pricing-bridge.ts:66-72 (produkční
//     zápisová cesta: syntéza + `brandSaleActionPrice` příznak)
//   Referenční chování: okfish tests/brand-sale-discounts.test.ts.
//
// CO DĚLÁ:
//   Vybrané značky mají trvalou, celoroční akční cenu (policy-v1.json:
//   DELPHIN 15 %, DELPHIN BOMB 15 %, MIVARDI 10 %, MIKADO 9 %). Pravidlo
//   pro produkt takové značky SYNTETIZUJE akční cenu `base * (1 - ratio)`.
//
//   Tři tvrdé podmínky, všechny 1:1 z okfishe:
//     1. Syntetizuje se JEN když produkt nemá vlastní akční cenu
//        (`effectiveSalePrice === undefined`, tj. AŽ PO NoOpActionPriceRule).
//        Existující individuální výprodej se nikdy nepřepisuje.
//     2. `manufacturer` musí být truthy string A musí být klíčem v mapě
//        (`!== undefined`, ne jen truthy hodnota) -- neznámá značka = no-op.
//     3. Produkční cesta navíc vyžaduje `basePrice > 0` (pricing-bridge.ts:68).
//        Worker to nekontroluje explicitně, ale nedostane se sem: pricing.ts:109
//        odbočí dřív. Podmínku držíme, protože je striktnější a shodná
//        s cestou, která reálně zapisuje ceny do Shoptetu.
//
//   VÝSLEDEK JE JEN "další actionPrice". Od okamžiku syntézy se chová úplně
//   stejně jako akční cena z feedu -- žádná speciální větev dál v chainu.
//   To znamená mj., že brandSaleDiscount NENÍ strop: DELPHIN na ZR25 dostane
//   plných -25 % (75.00 ze 100.00), ne -15 %. Naopak MIVARDI, které má
//   NEZÁVISLE i `brandLimits` 10 %, dostane -10 % na všech tierech, protože
//   aktivní cap + existující salePrice spustí VAGNER pravidlo
//   v DiscountLimitRule. Ty dvě mapy jsou dva nezávislé zápisy, které se
//   u MIVARDI shodou okolností shodují na 0.10 -- ne jedna odvozená z druhé.
//
// CO EXPLICITNĚ NEDĚLÁ:
//   - Nezavádí žádný strop / maxDiscount. To je `brandLimits`, jiná mapa,
//     jiné pravidlo (DiscountLimitRule).
//   - Nezapisuje `actionPrice` do Shoptetu. Okfish sync-orchestrator na to
//     používá příznak `brandSaleActionPrice`; ten je tu vrácen jako
//     `synthesized: true`, ale zápis je věc connectoru, ne domény.
//   - Neřeší case-insensitivitu ani trim značky. Okfish porovnává přesný
//     řetězec ("DELPHIN BOMB" s mezerou), zachováno 1:1.
//
// ROZDÍL V ZAOKROUHLENÍ -- ZDOKUMENTOVANÝ NÁLEZ, NE CHYBA PORTU:
//   Okfish syntetizuje na DVOU místech DVĚMA různými vzorci:
//     worker  (pricing.ts:57-60, `applyPercent`):
//             Math.round(Math.round(base*100) * (100-pct) / 100) / 100
//     bridge  (pricing-bridge.ts:69):
//             Math.round(base * (1 - ratio) * 100) / 100
//   Ty se NEshodují. Vzorec bridge trpí přesně tou float chybou, kvůli které
//   `applyPercent` ve workeru vzniklo (komentář pricing.ts:50-56 ji popisuje,
//   ale bridge tu opravu nikdy nedostal). Změřeno na reálném okfish
//   products.csv (16633 řádků x 3 sazby = 49899 dvojic): 564 dvojic (1,13 %)
//   se liší o 1 cent. Např. base 1.15 @ 10 % -> worker 1.04, bridge 1.03.
//   Testy v okfishi to nechytí, protože všechny používají base = 100.
//
//   Nexus implementuje WORKEROVU variantu (Decimal, ROUND_HALF_UP na 2 m.d.),
//   protože ta je matematicky správně a shoduje se s badgem, který vidí
//   zákazník. Ověřeno, že Decimal.toDecimalPlaces(2, ROUND_HALF_UP) dává
//   identický výsledek jako integer-cents `applyPercent` na všech
//   base 0.01-20000.00 x {15 %, 10 %, 9 %} (viz
//   tests/regression/golden-pricing/brand-sale-discount-rule-parity.test.ts).
//   => Proti workeru je to parita. Proti bridge je to ZÁMĚRNÝ rozdíl
//      na 1,13 % katalogu. Musí padnout do shadow diffu jako known-divergence,
//      jinak se bude tvářit jako regrese.

import Decimal from 'decimal.js';
import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';

export interface BrandSaleDiscountRuleInput {
    readonly basePrice: Decimal;
    /**
     * Akční cena PO NoOpActionPriceRule. Když je definovaná, pravidlo
     * nedělá nic -- pořadí je závazné, viz hlavička.
     */
    readonly effectiveSalePrice?: Decimal;
    readonly manufacturer?: string;
    /** policy-v1.json `brandSaleDiscounts` -- poměry (0.15 = 15 %). */
    readonly brandSaleDiscounts: Record<string, Decimal>;
}

export interface BrandSaleDiscountRuleResult {
    /** `true` = akční cena byla právě syntetizována z brandSaleDiscounts. */
    readonly applied: boolean;
    /** Akční cena pro zbytek chainu (syntetizovaná, nebo beze změny vstupní). */
    readonly effectiveSalePrice?: Decimal;
    /**
     * Odpovídá okfish `ProductPricingResult.brandSaleActionPrice`: nastaveno
     * JEN u syntetizovaného případu -- signál pro connector, že tenhle kód
     * potřebuje reálný zápis actionPrice na základní/GUEST ceník.
     */
    readonly synthesizedFromBrand?: string;
}

export class BrandSaleDiscountRule
    implements Rule<BrandSaleDiscountRuleInput, BrandSaleDiscountRuleResult>
{
    constructor(public readonly context: RuleContext) {}

    evaluate(input: BrandSaleDiscountRuleInput): BrandSaleDiscountRuleResult {
        // 1. Vlastní akční cena vždy vyhrává.
        if (input.effectiveSalePrice !== undefined) {
            return { applied: false, effectiveSalePrice: input.effectiveSalePrice };
        }

        // 2. Truthy manufacturer + explicitní klíč v mapě.
        const manufacturer = input.manufacturer;
        if (!manufacturer) {
            return { applied: false, effectiveSalePrice: undefined };
        }
        const ratio = input.brandSaleDiscounts[manufacturer];
        if (ratio === undefined) {
            return { applied: false, effectiveSalePrice: undefined };
        }

        // 3. basePrice > 0 (pricing-bridge.ts:68).
        if (!input.basePrice.greaterThan(0)) {
            return { applied: false, effectiveSalePrice: undefined };
        }

        const one = new Decimal('1');
        const synthesized = input.basePrice
            .mul(one.minus(ratio))
            .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

        return {
            applied: true,
            effectiveSalePrice: synthesized,
            synthesizedFromBrand: manufacturer,
        };
    }
}
