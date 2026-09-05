// OrderInvoiceOmegaFlow -- Fáze 6.4 business flow, ne nová abstrakce.
// Josovo zadání 2026-09-05 (Fáze 6.4): "Order -> Invoice -> Omega reference"
// je jeden ze jmenovaných use-caseů s přímou oporou v dosavadních
// rozhodnutích (Fáze 6.1-6.3). "Teď už bych nepřidával další abstrakce.
// Začal bych propojovat to, co jsme právě definovali, do reálných NEXUS
// use-caseů."
//
// Tento soubor NEPŘIDÁVÁ žádné nové business rozhodnutí, žádnou novou
// validaci ani žádné nové pole na entitách -- je to ČISTÁ KOMPOZICE nad
// již existující `InvoiceLifecycleRule` (domains/invoice/InvoiceLifecycleRule.ts),
// stejný princip jako `domains/pricing/createNexusPricingCalculator.ts`
// (žádná nová logika, jen produkční zapojení už existující Rule do
// konkrétního use-case kontextu).
//
// Use-case: "chci vystavit fakturu k téhle objednávce" -- vstupem je
// `orderId` (ze Shoptet Order, viz core/canonical/entities/Order.ts;
// Order.canonicalStatus zde ZÁMĚRNĚ nepoužíváme -- je stále nedefinovaný,
// viz Order.ts Open Questions, tenhle flow ho nepotřebuje a nedomýšlí)
// + požadovaný cílový Invoice status + volitelný omegaDocumentId.
// Výstup: jestli přechod je povolený, a pokud ne, PROČ NE -- delegováno
// 1:1 na InvoiceLifecycleRule, tenhle flow jen dává kontext "tohle je
// konkrétně Order->Invoice->Omega tok", nepřidává vlastní podmínky.
//
// Co tento flow ZÁMĚRNĚ NEDĚLÁ (stejné mimo-scope jako InvoiceLifecycleRule
// a Josovo explicitní "zatím vůbec neřešit" pro Fázi 6.4):
//   - Negeneruje ani nevytváří `omegaDocumentId` -- žádná automatická
//     fakturace, žádné volání Omega API, žádné I/O vůbec.
//   - Nevytváří Invoice záznam -- volající (mimo scope tohoto souboru)
//     je zodpovědný za perzistenci, tenhle flow jen řekne "je povolené?".
//   - Nerozhoduje KDY se má faktura vystavit -- to zůstává odpovědnost
//     volajícího kódu.

import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import type { InvoiceLifecycleState } from '../../core/canonical/entities/Invoice.js';
import { InvoiceLifecycleRule, type InvoiceLifecycleRuleResult } from './InvoiceLifecycleRule.js';

export interface OrderInvoiceOmegaFlowInput {
    /** Order.id (core/canonical/entities/Order.ts) -- zdroj Invoice.orderId vazby. */
    readonly orderId: string;
    readonly currentInvoiceStatus: InvoiceLifecycleState;
    readonly targetInvoiceStatus: InvoiceLifecycleState;
    /** Odkaz na Omega CanonicalAccountingDocument, pokud už existuje -- viz InvoiceLifecycleRule. */
    readonly omegaDocumentId?: string;
}

export type OrderInvoiceOmegaFlowResult = InvoiceLifecycleRuleResult;

/**
 * Skládá Order -> Invoice -> Omega reference use-case nad existující
 * `InvoiceLifecycleRule` -- žádná nová validace, jen use-case kontext.
 * `orderId` z Order je předáno 1:1 jako `InvoiceLifecycleRuleInput.orderId`
 * (Invoice -> Order je striktně 1:1, viz Invoice.ts).
 */
export function evaluateOrderInvoiceOmegaFlow(
    context: RuleContext,
    input: OrderInvoiceOmegaFlowInput
): OrderInvoiceOmegaFlowResult {
    const rule: Rule<Parameters<InvoiceLifecycleRule['evaluate']>[0], InvoiceLifecycleRuleResult> =
        new InvoiceLifecycleRule(context);

    return rule.evaluate({
        currentStatus: input.currentInvoiceStatus,
        targetStatus: input.targetInvoiceStatus,
        orderId: input.orderId,
        omegaDocumentId: input.omegaDocumentId,
    });
}
