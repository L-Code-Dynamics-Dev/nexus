// Invoice -- Fáze 6 doménová kostra (docs/MIGRATION_PLAN.md, Josovo zadání
// 2026-09-05: "Další kroky Fáze 6"). Žádný zdrojový systém (Pricing/
// SafeOrder/AIE/Omega) má fakturační entitu -- Omega OmegaMapper generuje
// R01/R02 dokumenty (connectors/omega/legacy/), ale to je EXPORT FORMÁT
// pro existující CanonicalAccountingDocument (Omega-side typ), ne Nexus
// canonical Invoice entita. Nezaměňovat -- viz Jose: "Omega zůstává
// účetním zdrojem pravdy" a "Invoice není SaaS Billing" (oddělení domén).
//
// ROZHODNUTO (Jose 2026-09-05):
//   - Invoice -> Order je 1:1 (ne souhrnná N:1 faktura -- to by byla
//     neodsouhlasená funkcionalita, viz "žádné souhrnné faktury" bod 5).
//   - Invoice NENÍ SaaS/subscription Billing (viz Billing.ts) -- oddělené
//     domény, i když obě mají slovo "faktura"/"platba" v názvu.
//   - Automatické vytváření Invoice PŘI Order completion je NEODSOUHLASENÁ
//     funkcionalita (Jose bod 5: "žádné automatické workflow faktur") --
//     tento soubor definuje jen KONTRAKT entity, žádný trigger/workflow.
//
// Tento soubor implementuje POUZE základní kontrakt (typy, ID, vazba,
// stavové hodnoty) -- žádná business logika.

import type { CanonicalEntity, EntityId, ExternalIdentity, Money } from './base.js';

export interface Invoice extends CanonicalEntity {
    readonly externalIdentity?: ExternalIdentity;
    /** ROZHODNUTO: 1:1 vazba na Order, NENÍ souhrnná faktura za víc objednávek. */
    readonly orderId: EntityId;
    /** TBD: invoice vs credit note rozlišení -- OmegaMapper má 'INVOICE'|'CREDIT_NOTE' analogii, ale Nexus canonical rozhodnutí chybí. */
    documentType: string;
    issueDate: string;
    total: Money;
    /** TBD: lifecycle states (DRAFT/ISSUED/PAID/CANCELLED?) nerozhodnuto, viz Campaign.ts stejný vzor komentáře. */
    status: string;
}

/**
 * ROZHODNUTO (Jose 2026-09-05): Invoice -> Order 1:1, Invoice != SaaS
 * Billing (viz Billing.ts). Zbývající OPEN QUESTIONS (business rule detail,
 * mimo scope Fáze 6 kostry):
 *
 * 1. Vztah k Omega CanonicalAccountingDocument (connectors/omega/legacy/
 *    core/CanonicalAccountingDocument.ts) -- je to zdroj pro Invoice, nebo
 *    nezávislý export-only formát? Omega zůstává účetním zdrojem pravdy
 *    (Jose), ale přesný mapping pole-na-pole není rozhodnut.
 * 2. Invoice vs credit note rozlišení (documentType hodnoty) -- nerozhodnuto.
 * 3. Lifecycle states (DRAFT/ISSUED/PAID/CANCELLED?) -- nerozhodnuto.
 * 4. Vytváření Invoice (kdy/kým) je EXPLICITNĚ MIMO SCOPE (Jose bod 5:
 *    "žádné automatické workflow faktur") -- neimplementovat bez dalšího zadání.
 */
