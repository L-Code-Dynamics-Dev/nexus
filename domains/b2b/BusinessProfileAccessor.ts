// BusinessProfileAccessor -- Fáze 6.2 business rule nad Fáze 6.1 kostrou
// (core/canonical/entities/Customer.ts). Josovo zadání 2026-09-05:
// "B2B informace musí být dostupné ostatním doménám přes kontrakt" --
// jiné domény (Pricing/Order/Payment/Invoice) čtou B2B data POUZE přes
// tento accessor, ne přímým sahnutím do `customer.businessProfile`
// všude v kódu. To je JEDINÁ nová logika, kterou tento soubor přidává --
// je to čistá projekce/getter, ne validace ani business rozhodnutí.
//
// Proč čistá funkce, ne Rule<>: BusinessProfile nemá vlastní lifecycle
// (Josovo zadání pro B2B nezmiňuje žádný stavový přechod, na rozdíl od
// Subscription/Campaign/Invoice/Warehouse) -- Rule<TInput,TResult>
// kontrakt je navržen pro rozhodovací logiku s RuleContext/verzováním,
// což tenhle přímočarý getter nepotřebuje. Používá se stejný "čistá
// funkce bez I/O" princip jako u Rule, jen bez zbytečného obalu.
//
// UNRESOLVED (Jose zadání neurčuje jednoznačně, NEIMPLEMENTOVÁNO):
//   - Jose: "nesmí vzniknout vlastní pricing engine" a "žádné validační
//     pravidlo pro BusinessProfile pole samotná" nebylo zadáno explicitně
//     -- tento soubor proto NEVALIDUJE obsah BusinessProfile polí
//     (company/taxIdentifiers/paymentTerms formát, prázdný string, atd.).
//     Poskytuje jen přístup k datům, ne jejich validaci. Pokud
//     validace bude potřeba, je to samostatné zadání, ne domněnka zde.
//   - UNRESOLVED: přesný způsob, jakým Pricing/Order/Payment/Invoice
//     domény tento accessor VOLAJÍ (přímý import vs. injected dependency)
//     není specifikován -- tenhle soubor jen exportuje čistou funkci,
//     napojení do konkrétních domén je mimo scope Fáze 6.2 (žádná z
//     těch domén dnes o BusinessProfile vůbec neví, přidání by bylo
//     rozšíření jejich vlastního kódu, ne tohoto souboru).

import type { Customer, BusinessProfile } from '../../core/canonical/entities/Customer.js';

/**
 * Vrací BusinessProfile daného zákazníka, pokud existuje. `undefined`
 * znamená běžný B2C zákazník -- volající (jiná doména) MUSÍ tenhle
 * případ zpracovat explicitně (typ `BusinessProfile | undefined`
 * to vynucuje na compile-time), ne předpokládat, že B2B profil vždy existuje.
 */
export function getBusinessProfile(customer: Customer): BusinessProfile | undefined {
    return customer.businessProfile;
}

/**
 * Explicitní, typovaný test "je tenhle zákazník B2B?" -- ekvivalentní
 * `getBusinessProfile(customer) !== undefined`, ale pojmenovaný podle
 * účelu volajícího kódu (čitelnost na volacím místě), ne duplicitní logika.
 */
export function isBusinessCustomer(customer: Customer): boolean {
    return customer.businessProfile !== undefined;
}

/**
 * Vrací pricingContext (referenci na ceník/tier, viz Customer.ts komentář:
 * "REFERENCE, NIKDY vlastní cenová pravidla") daného zákazníka, pokud
 * existuje B2B profil A má vyplněný pricingContext. Pricing doména zůstává
 * jediným vlastníkem VÝPOČTU -- tahle funkce jen ZPŘÍSTUPŇUJE, KTERÝ
 * ceník/tier se má použít, nepočítá nic sama.
 */
export function getB2BPricingContext(customer: Customer): string | undefined {
    return customer.businessProfile?.pricingContext;
}
