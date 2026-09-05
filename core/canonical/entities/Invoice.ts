// Invoice -- PLACEHOLDER, čistě NEW BUILD (docs/CANONICAL_MODEL_SYNTHESIS.md
// §13: "Invoice (celá entita) | NEEXISTUJE | N/A"). Fáze 6
// (docs/MIGRATION_PLAN.md). Žádný zdrojový systém (Pricing/SafeOrder/AIE/
// Omega) má fakturační entitu -- Omega OmegaMapper generuje R01/R02
// dokumenty (viz connectors/omega/legacy/), ale to je EXPORT FORMÁT pro
// existující CanonicalAccountingDocument (Omega-side typ), ne Nexus
// canonical Invoice entita. Nezaměňovat.
//
// Tento soubor je jen typová kostra, žádné obchodní rozhodnutí.

import type { CanonicalEntity, ExternalIdentity, Money } from './base.js';

export interface Invoice extends CanonicalEntity {
    readonly externalIdentity?: ExternalIdentity;
    /** TBD: invoice vs credit note rozlišení -- OmegaMapper má 'INVOICE'|'CREDIT_NOTE' analogii, ale Nexus canonical rozhodnutí chybí. */
    documentType: string;
    issueDate: string;
    total: Money;
    /** TBD: lifecycle states (DRAFT/ISSUED/PAID/CANCELLED?) nerozhodnuto, viz Campaign.ts stejný vzor komentáře. */
    status: string;
}

/**
 * OPEN QUESTIONS:
 * 1. Je Invoice 1:1 vazba na Order, nebo N:1 (souhrnná faktura za víc objednávek)?
 * 2. Vztah k Omega CanonicalAccountingDocument (connectors/omega/legacy/
 *    core/CanonicalAccountingDocument.ts) -- je to zdroj pro Invoice, nebo
 *    nezávislý export-only formát?
 * 3. Kdo Invoice vytváří (automaticky při Order completion, nebo manuální workflow)?
 */
