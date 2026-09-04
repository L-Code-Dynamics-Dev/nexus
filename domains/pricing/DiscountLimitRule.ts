// DiscountLimitRule -- migrace legacy DiscountLimitPolicy (connectors/
// pricing-engine/legacy/policies/DiscountLimitPolicy.ts) pod Nexus Rule
// contract. Treti krok migracni sekvence po RoundingRule a ValidationRule
// (MIGRATION_PLAN.md).
//
// Zachovano 1:1 vcetne netrivialnich detailu:
//   1. Hierarchicky fallback Product -> Brand -> Category -> None je
//      "first match wins": pokud je productMaxDiscount definovany, brand
//      i category limity se VUBEC nekontroluji, i kdyby existovaly.
//   2. manufacturer/category kontrola vyzaduje TRUTHY string (prazdny
//      retezec '' fallback preskoči) A explicitni existenci klice
//      v limit mape (`!== undefined`, ne jen truthy hodnota mapy).
//   3. VAGNER pravidlo (INCIDENTS.md "2026-08-04 VAGNER"): kdyz je aktivni
//      limit A salePrice je definovana, salePrice je AUTORITATIVNI --
//      vraci se OKAMZITE, cap-floor porovnani (currentPrice < minAllowedPrice)
//      se vubec neprovadi. Nezvysuje se, neprebiji se loyalty discountem.
//   4. Bez salePrice: cap-floor = basePrice * (1 - limit). Command se vydava
//      JEN pokud currentPrice < cap-floor (tj. jen kdyz aktualni cena
//      limit porusuje) -- jinak zadny command (rule neni "applied").
//
// Rule je bezstavova vuci limit mapam -- brandLimits/categoryLimits se
// predavaji per evaluate() volani jako soucast inputu (Rule kontrakt
// vyzaduje evaluate(input): cista funkce, zadny konstruktor-injected state
// mimo RuleContext -- viz Rule.ts komentar "zadne skryte side effects").

import Decimal from 'decimal.js';
import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';

export type DiscountLimitSource = 'PRODUCT_LIMIT' | 'BRAND_LIMIT' | 'CATEGORY_LIMIT';

export interface DiscountLimitRuleInput {
    readonly basePrice: Decimal;
    readonly currentPrice: Decimal;
    readonly salePrice?: Decimal;
    readonly productMaxDiscount?: Decimal;
    readonly manufacturer?: string;
    readonly category?: string;
    readonly brandLimits: Record<string, Decimal>;
    readonly categoryLimits: Record<string, Decimal>;
}

export interface DiscountLimitRuleResult {
    readonly applied: boolean;
    readonly price?: Decimal;
    readonly rule?: DiscountLimitSource | 'SALE';
}

export class DiscountLimitRule implements Rule<DiscountLimitRuleInput, DiscountLimitRuleResult> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: DiscountLimitRuleInput): DiscountLimitRuleResult {
        let activeLimit: Decimal | undefined;
        let activeRuleType: DiscountLimitSource | undefined;

        // Hierarchical fallback: Product -> Brand -> Category -> None
        if (input.productMaxDiscount !== undefined) {
            activeLimit = input.productMaxDiscount;
            activeRuleType = 'PRODUCT_LIMIT';
        } else if (input.manufacturer && input.brandLimits[input.manufacturer] !== undefined) {
            activeLimit = input.brandLimits[input.manufacturer];
            activeRuleType = 'BRAND_LIMIT';
        } else if (input.category && input.categoryLimits[input.category] !== undefined) {
            activeLimit = input.categoryLimits[input.category];
            activeRuleType = 'CATEGORY_LIMIT';
        }

        if (activeLimit === undefined || activeRuleType === undefined) {
            return { applied: false };
        }

        // VAGNER pravidlo: salePrice je autoritativni, cap-floor se vubec nepocita.
        if (input.salePrice !== undefined) {
            return { applied: true, price: input.salePrice, rule: 'SALE' };
        }

        const one = new Decimal('1');
        const minAllowedPrice = input.basePrice.mul(one.minus(activeLimit));

        if (input.currentPrice.lessThan(minAllowedPrice)) {
            return { applied: true, price: minAllowedPrice, rule: activeRuleType };
        }

        return { applied: false };
    }
}
