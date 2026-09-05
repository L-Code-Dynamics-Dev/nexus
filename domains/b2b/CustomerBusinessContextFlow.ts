// CustomerBusinessContextFlow -- Fáze 6.4 business flow (Josovo zadání
// 2026-09-05: "Customer -> BusinessProfile -> ostatní domény" flow, "teď už
// bych nepřidával další abstrakce. Začal bych propojovat to, co jsme právě
// definovali, do reálných NEXUS use-caseů.").
//
// Tento soubor NEPŘIDÁVÁ žádné nové business rozhodnutí -- je to ČISTÁ
// KOMPOZICE tří existujících stavebních kamenů (Fáze 6.2/6.3):
//   1. isBusinessCustomer() (domains/b2b/BusinessProfileAccessor.ts) -- je
//      tenhle zákazník B2B?
//   2. BusinessProfileValidationRule (domains/b2b/BusinessProfileValidationRule.ts)
//      -- je BusinessProfile strukturálně validní (jen když existuje)?
//   3. getB2BPricingContext() (domains/b2b/BusinessProfileAccessor.ts) --
//      jaký ceník/tier má Pricing doména použít (jen REFERENCE, ne výpočet)?
//
// Tohle je přesně use-case popsaný Josem: "jiná doména (Pricing/Order/
// Payment/Invoice) potřebuje vědět o B2B profilu zákazníka" -- volá SE
// TENTO flow místo přímého sahání do `customer.businessProfile` na
// každém volacím místě zvlášť.
//
// EXPLICITNĚ MIMO SCOPE (Jose "zatím vůbec neřešit"): B2B schvalování/
// limity, konkrétní promo výpočet, cokoliv, co by šlo nad rámec "je B2B?
// je profil validní? jaký je pricingContext?".

import type { RuleContext } from '../../core/canonical/rules/Rule.js';
import { isBusinessCustomer, getBusinessProfile, getB2BPricingContext } from './BusinessProfileAccessor.js';
import { BusinessProfileValidationRule } from './BusinessProfileValidationRule.js';
import type { Customer } from '../../core/canonical/entities/Customer.js';

export interface CustomerBusinessContextResult {
    readonly isB2B: boolean;
    /** Jen přítomné, pokud isB2B === true -- B2C zákazník nemá co validovat. */
    readonly profileValid?: boolean;
    /** Strukturální chyby z BusinessProfileValidationRule, pokud profileValid === false. */
    readonly validationErrors?: readonly string[];
    /** REFERENCE na ceník/tier pro Pricing doménu -- nikdy vlastní výpočet, viz getB2BPricingContext(). */
    readonly pricingContext?: string;
}

/**
 * Skládá isBusinessCustomer() + BusinessProfileValidationRule +
 * getB2BPricingContext() do jednoho use-case výsledku, který jiné domény
 * (Pricing/Order/Payment/Invoice) mohou použít MÍSTO přímého sahání do
 * `customer.businessProfile`. Čistá funkce, žádné I/O.
 */
export function resolveCustomerBusinessContext(
    context: RuleContext,
    customer: Customer
): CustomerBusinessContextResult {
    if (!isBusinessCustomer(customer)) {
        return { isB2B: false };
    }

    const businessProfile = getBusinessProfile(customer);
    // isBusinessCustomer() už potvrdilo, že businessProfile existuje --
    // tahle větev je nedosažitelná jinak, ale TypeScript nonstrikt undefined
    // check vyžaduje explicitní guard (žádná nová business logika, jen typová bezpečnost).
    if (businessProfile === undefined) {
        return { isB2B: true, profileValid: false, validationErrors: ['businessProfile chybí navzdory isBusinessCustomer() === true (neočekávaný stav).'] };
    }

    const validationRule = new BusinessProfileValidationRule(context);
    const validationResult = validationRule.evaluate(businessProfile);

    return {
        isB2B: true,
        profileValid: validationResult.valid,
        validationErrors: validationResult.valid ? undefined : validationResult.errors,
        pricingContext: getB2BPricingContext(customer),
    };
}
