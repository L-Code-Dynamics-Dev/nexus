// BusinessProfileValidationRule -- Fáze 6.3 rozhodnutí bodu 6 z Fáze 6.2
// UNRESOLVED (domains/b2b/BusinessProfileAccessor.ts): "Jose: nesmí vzniknout
// vlastní pricing engine... žádné validační pravidlo pro BusinessProfile
// pole samotná nebylo zadáno explicitně."
//
// ROZHODNUTO (Jose 2026-09-05, Fáze 6.3), bod 6 -- BusinessProfile
// validace: "Minimální strukturální validace; business-specific validace
// až podle konkrétního kontraktu."
//
// Co tahle Rule DĚLÁ (a nic víc):
//   - Ověří, že POVINNÁ pole (`company`, `taxIdentifiers`) nejsou prázdné/
//     whitespace-only stringy.
//   - Ověří, že POKUD jsou VOLITELNÁ pole (`pricingContext`, `paymentTerms`)
//     přítomná, nejsou prázdné/whitespace-only stringy (stejná minimální
//     úroveň -- "přítomné, ale prázdné" je stejná chyba jako typo).
//
// Co tahle Rule EXPLICITNĚ NEDĚLÁ (UNRESOLVED/mimo scope, Jose odložil):
//   - ŽÁDNÁ validace FORMÁTU -- žádný regex na IČO/DIČ, žádná kontrola
//     délky, žádná zemi-specifická logika (české IČO má 8 číslic, ale
//     BusinessProfile.taxIdentifiers je obecné pole bez zemního kontextu
//     v typu -- vynucovat konkrétní formát by bylo domýšlení business-
//     specific kontraktu, který Jose explicitně odložil na později).
//   - ŽÁDNÁ validace `pricingContext` proti skutečně existujícímu ceníku
//     (to by vyžadovalo I/O do Pricing domény, Rule.evaluate() nesmí mít
//     side effects/I/O).
//   - ŽÁDNÁ validace `paymentTerms` proti konkrétnímu enum hodnot (typ je
//     stále obecný string, žádný enum nebyl zadán).

import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import type { BusinessProfile } from '../../core/canonical/entities/Customer.js';

export interface BusinessProfileValidationResult {
    readonly valid: boolean;
    /** Všechny nalezené strukturální problémy, ne jen první -- volající vidí celý obrázek najednou. */
    readonly errors: readonly string[];
}

function isBlank(value: string | undefined): boolean {
    return value !== undefined && value.trim().length === 0;
}

export class BusinessProfileValidationRule implements Rule<BusinessProfile, BusinessProfileValidationResult> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: BusinessProfile): BusinessProfileValidationResult {
        const errors: string[] = [];

        if (input.company.trim().length === 0) {
            errors.push('company nesmí být prázdný/whitespace-only string.');
        }
        if (input.taxIdentifiers.trim().length === 0) {
            errors.push('taxIdentifiers nesmí být prázdný/whitespace-only string.');
        }
        if (isBlank(input.pricingContext)) {
            errors.push('pricingContext, pokud je přítomné, nesmí být prázdný/whitespace-only string.');
        }
        if (isBlank(input.paymentTerms)) {
            errors.push('paymentTerms, pokud je přítomné, nesmí být prázdný/whitespace-only string.');
        }

        return { valid: errors.length === 0, errors };
    }
}
