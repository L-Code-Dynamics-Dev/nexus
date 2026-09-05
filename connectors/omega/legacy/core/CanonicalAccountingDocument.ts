import { Decimal } from 'decimal.js';

export interface AccountingParty {
  id: string;
  name: string;
  ico?: string;
  dic?: string;
  street: string;
  city: string;
  zipCode: string;
  country: string;
}

export interface AccountingLineItem {
  text: string;
  quantity: Decimal;
  unitPriceWithoutTax: Decimal;
  taxRate: number;
  taxAmount: Decimal;
  totalWithTax: Decimal;
}

/**
 * An abstraction of a finalized accounting document ready to be exported.
 * It is completely detached from Shoptet structure.
 */
export interface CanonicalAccountingDocument {
  sourceDocumentId: string; // The correlation ID
  documentType: 'INVOICE' | 'CREDIT_NOTE';
  issueDate: Date;
  currency: string;
  
  supplier: AccountingParty;
  customer: AccountingParty;
  
  lines: AccountingLineItem[];
  
  summary: {
    totalWithoutTax: Decimal;
    totalTax: Decimal;
    totalWithTax: Decimal;
  };
}
