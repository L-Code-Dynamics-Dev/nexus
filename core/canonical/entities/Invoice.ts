// Invoice -- Fáze 6.1 lifecycle + invariants (Josovo zadání 2026-09-05).
// Žádný zdrojový systém (Pricing/SafeOrder/AIE/Omega) má fakturační
// entitu -- Omega OmegaMapper generuje R01/R02 dokumenty (connectors/
// omega/legacy/core/CanonicalAccountingDocument.ts), ale to je EXPORT
// FORMÁT pro Omega-side typ, ne Nexus canonical Invoice entita.
//
// ROZHODNUTO (Jose 2026-09-05):
//   - Invoice -> Order je STRIKTNĚ 1:1 (`orderId` povinné, NE souhrnná
//     N:1 faktura).
//   - Invoice lifecycle: PENDING -> ISSUED -> CANCELLED. NEXUS nevytváří
//     účetní pravdu -- Omega zůstává účetním zdrojem pravdy. Invoice je
//     obchodní reprezentace / vazba na účetní doklad přes
//     `omegaDocumentId` (odkaz na Omega CanonicalAccountingDocument,
//     NE kopie jeho dat). Dokud Omega doklad nevytvořila, Invoice může
//     být PENDING (`omegaDocumentId` je proto optional).
//   - Automatické vytváření/vystavování Invoice je EXPLICITNĚ MIMO SCOPE
//     (Jose: "žádné automatické workflow faktur") -- tento soubor
//     definuje jen kontrakt entity + dovolené stavové přechody, žádný
//     trigger/workflow.

import type { CanonicalEntity, EntityId, ExternalIdentity, Money } from './base.js';
import type { StateAxisDefinition } from '../../state-machine/StateMachine.js';

/**
 * Invoice lifecycle -- ROZHODNUTO (Jose): PENDING -> ISSUED -> CANCELLED.
 * PENDING: Invoice existuje na Nexus straně, Omega doklad ještě nemusí
 * existovat (`omegaDocumentId` může být undefined). ISSUED: Omega doklad
 * existuje a je potvrzený (`omegaDocumentId` by měl být vyplněný -- Rule
 * na vynucení tohoto invariantu je mimo scope kostry). CANCELLED je
 * terminální, stejně jako ISSUED (žádný návrat z vystaveného/zrušeného
 * dokladu -- účetní pravda patří Omeze, Nexus ji nepřepisuje zpět).
 */
export type InvoiceLifecycleState = 'PENDING' | 'ISSUED' | 'CANCELLED';

export const INVOICE_LIFECYCLE_DEFINITION: StateAxisDefinition<InvoiceLifecycleState> = {
    axisName: 'invoiceLifecycle',
    initialState: 'PENDING',
    terminalStates: ['ISSUED', 'CANCELLED'],
    transitions: {
        PENDING: ['ISSUED', 'CANCELLED'],
        ISSUED: [],
        CANCELLED: [],
    },
};

export interface Invoice extends CanonicalEntity {
    readonly externalIdentity?: ExternalIdentity;
    /** ROZHODNUTO: 1:1 vazba na Order, NENÍ souhrnná faktura za víc objednávek. */
    readonly orderId: EntityId;
    /**
     * Odkaz na Omega CanonicalAccountingDocument.id (connectors/omega/
     * legacy/core/CanonicalAccountingDocument.ts) -- NENÍ kopie účetních
     * dat, jen reference. Omega zůstává účetním zdrojem pravdy. Optional,
     * protože PENDING Invoice může existovat před vznikem Omega dokladu.
     */
    omegaDocumentId?: string;
    /** TBD: invoice vs credit note rozlišení -- OmegaMapper má 'INVOICE'|'CREDIT_NOTE' analogii, ale Nexus canonical rozhodnutí chybí. */
    documentType: string;
    issueDate: string;
    total: Money;
    status: InvoiceLifecycleState;
}

/**
 * ROZHODNUTO (Jose 2026-09-05, Fáze 6.1): Invoice -> Order 1:1, lifecycle
 * PENDING/ISSUED/CANCELLED, omegaDocumentId jako reference (ne kopie).
 * Zbývající OPEN QUESTIONS (business rule detail, mimo scope Fáze 6.1):
 *
 * 1. Invoice vs credit note rozlišení (documentType hodnoty) -- nerozhodnuto.
 * 2. Přesný sync mechanismus PENDING -> ISSUED (kdo/co čte Omega stav a
 *    aktualizuje Invoice.status) -- EXPLICITNĚ MIMO SCOPE (žádné
 *    automatické fakturační workflow bez dalšího zadání).
 */
