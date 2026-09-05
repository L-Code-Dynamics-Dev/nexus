// InvoiceLifecycleRule -- Fáze 6.2 business rule nad Invoice lifecycle
// kostrou (core/canonical/entities/Invoice.ts). Validuje POUZE explicitně
// zadaná pravidla z Josova zadání, žádná domněnka navíc.
//
// Pravidla implementovaná zde:
//   1. Lifecycle přechod (PENDING -> ISSUED | CANCELLED) musí být povolený
//      podle INVOICE_LIFECYCLE_DEFINITION (core/state-machine/StateMachine.ts).
//   2. ISSUED nesmí vzniknout bez vazby na Order -- `orderId` musí být
//      neprázdný string. `Invoice.orderId` je už typově povinné pole, ale
//      runtime kontrola zůstává smysluplná jako defenzivní invariant
//      (prázdný string by typově prošel, sémanticky ne).
//
// Co tato Rule ZÁMĚRNĚ NEDĚLÁ (Jose: "žádná automatická fakturace"):
//   - Negeneruje ani nevytváří `omegaDocumentId` -- to je vždy reference
//     na účetní systém (Omega), NIKDY vlastní účetní dokument NEXUSu.
//     Rule ho jen čte/předává dál, pokud je na vstupu přítomný.
//   - Nespouští žádný trigger/workflow -- evaluate() je čistá validace na
//     explicitní vyžádání volajícího, žádné side effects, žádné I/O.
//   - Nerozhoduje, KDY se má Invoice vystavit -- to je odpovědnost
//     volajícího kódu (mimo scope Fáze 6.2), Rule jen řekne, jestli
//     POŽADOVANÝ přechod je s daným stavem/daty dovolený.
//
// UNRESOLVED (nelze jednoznačně odvodit ze zadání, NEIMPLEMENTOVÁNO):
//   - Zda ISSUED vyžaduje i vyplněný `omegaDocumentId` (ne jen `orderId`).
//     Josovo zadání říká jen "ISSUED nesmí být vytvořena bez vazby na
//     Order" -- o omegaDocumentId mluví jako o referenci, ne jako o
//     podmínce přechodu. Entity komentář (Invoice.ts řádek 27-28) sám
//     říká "omegaDocumentId by MĚL být vyplněný -- Rule na vynucení
//     tohoto invariantu je mimo scope kostry", ale to je z Fáze 6.1, ne
//     explicitní potvrzení pro 6.2. Vynucovat by znamenalo domýšlet
//     pravidlo, které Jose v tomto zadání nezopakoval explicitně.

import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import type { InvoiceLifecycleState } from '../../core/canonical/entities/Invoice.js';
import { INVOICE_LIFECYCLE_DEFINITION } from '../../core/canonical/entities/Invoice.js';
import { evaluateTransition } from '../../core/state-machine/StateMachine.js';

export interface InvoiceLifecycleRuleInput {
    readonly currentStatus: InvoiceLifecycleState;
    readonly targetStatus: InvoiceLifecycleState;
    /** `Invoice.orderId` -- povinné typově, ale kontrolováno i runtime (viz hlavička souboru). */
    readonly orderId: string;
    /**
     * Odkaz na Omega CanonicalAccountingDocument, pokud existuje. Rule ho
     * NIKDY negeneruje ani nevynucuje jeho přítomnost (viz UNRESOLVED výše)
     * -- pole je zde jen proto, aby Rule mohla vrátit informační poznámku,
     * NE jako podmínku pro `allowed`.
     */
    readonly omegaDocumentId?: string;
}

export interface InvoiceLifecycleRuleResult {
    readonly allowed: boolean;
    readonly reason?: string;
    /**
     * Čistě informační poznámka -- NIKDY neovlivňuje `allowed`. Existuje,
     * aby volající měl explicitní připomínku, že omegaDocumentId je
     * reference na účetní systém, ne vlastní účetní dokument NEXUSu.
     */
    readonly omegaDocumentNote?: string;
}

const OMEGA_REFERENCE_NOTE =
    'omegaDocumentId je reference na Omega CanonicalAccountingDocument -- NEXUS ho nikdy negeneruje ani nevlastní jako svůj účetní dokument.';

export class InvoiceLifecycleRule implements Rule<InvoiceLifecycleRuleInput, InvoiceLifecycleRuleResult> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: InvoiceLifecycleRuleInput): InvoiceLifecycleRuleResult {
        const transition = evaluateTransition(
            INVOICE_LIFECYCLE_DEFINITION,
            input.currentStatus,
            input.targetStatus
        );

        if (!transition.allowed) {
            return { allowed: false, reason: transition.reason };
        }

        if (input.targetStatus === 'ISSUED' && input.orderId.trim().length === 0) {
            return {
                allowed: false,
                reason: 'ISSUED nesmí být vytvořena bez vazby na Order -- orderId je prázdný.',
            };
        }

        return {
            allowed: true,
            omegaDocumentNote: input.omegaDocumentId !== undefined ? OMEGA_REFERENCE_NOTE : undefined,
        };
    }
}
