// InvoiceLifecycleRule -- Fáze 6.2 business rule nad Invoice lifecycle
// kostrou (core/canonical/entities/Invoice.ts), rozhodnutí Fáze 6.3
// doplněno. Validuje POUZE explicitně zadaná pravidla, žádná domněnka navíc.
//
// Pravidla implementovaná zde:
//   1. Lifecycle přechod (PENDING -> ISSUED | CANCELLED) musí být povolený
//      podle INVOICE_LIFECYCLE_DEFINITION (core/state-machine/StateMachine.ts).
//   2. ISSUED nesmí vzniknout bez vazby na Order -- `orderId` musí být
//      neprázdný string. `Invoice.orderId` je už typově povinné pole, ale
//      runtime kontrola zůstává smysluplná jako defenzivní invariant
//      (prázdný string by typově prošel, sémanticky ne).
//   3. ROZHODNUTO (Jose 2026-09-05, Fáze 6.3): "ISSUED vyžaduje
//      omegaDocumentId. Bez účetního dokladu není faktura vystavená."
//      Přechod do ISSUED nyní selže i tehdy, když `omegaDocumentId`
//      chybí nebo je prázdný string -- stejná úroveň kontroly jako u
//      `orderId`. DŮLEŽITÉ: tohle NENÍ generování -- Rule stále nikdy
//      nevytváří `omegaDocumentId` sama, jen teď navíc VYŽADUJE jeho
//      přítomnost jako podmínku přechodu (účetní doklad musí už
//      existovat na Omega straně, než Nexus označí Invoice za ISSUED).
//
// Co tato Rule ZÁMĚRNĚ NEDĚLÁ (Jose: "žádná automatická fakturace"):
//   - Negeneruje ani nevytváří `omegaDocumentId` -- to je vždy reference
//     na účetní systém (Omega), NIKDY vlastní účetní dokument NEXUSu.
//     Rule ho jen čte/vyžaduje přítomnost, nikdy nezapisuje.
//   - Nespouští žádný trigger/workflow -- evaluate() je čistá validace na
//     explicitní vyžádání volajícího, žádné side effects, žádné I/O.
//   - Nerozhoduje, KDY se má Invoice vystavit -- to je odpovědnost
//     volajícího kódu (mimo scope Fáze 6.2/6.3), Rule jen řekne, jestli
//     POŽADOVANÝ přechod je s daným stavem/daty dovolený.

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

        // ROZHODNUTO (Jose 2026-09-05, Fáze 6.3): "Bez účetního dokladu
        // není faktura vystavená." -- omegaDocumentId musí být neprázdný
        // string, jinak přechod do ISSUED selže. Rule ho stále NEGENERUJE,
        // jen vyžaduje, že už existuje (musel vzniknout na Omega straně dřív).
        if (input.targetStatus === 'ISSUED' && (input.omegaDocumentId === undefined || input.omegaDocumentId.trim().length === 0)) {
            return {
                allowed: false,
                reason: 'ISSUED nesmí být vytvořena bez omegaDocumentId -- bez účetního dokladu není faktura vystavená.',
            };
        }

        return {
            allowed: true,
            omegaDocumentNote: input.omegaDocumentId !== undefined ? OMEGA_REFERENCE_NOTE : undefined,
        };
    }
}
