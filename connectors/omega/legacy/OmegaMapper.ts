import { Decimal } from 'decimal.js';
import * as crypto from 'crypto';
import { CanonicalAccountingDocument } from './core/CanonicalAccountingDocument.js';
import { OmegaImportPayload } from './OmegaPayload.js';

export class OmegaMapper {
  private formatDecimal(d: Decimal): string {
    // For Omega we use a comma as a decimal separator and 2 decimal places
    return d.toFixed(2).replace('.', ',');
  }

  private formatDate(d: Date): string {
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
  }

  private sanitizeString(s: string | undefined, maxLength?: number): string {
    if (!s) return '';
    const clean = s.replace(/\t/g, ' ').replace(/\r\n|\n|\r/g, ' ');
    if (maxLength && clean.length > maxLength) {
      return clean.substring(0, maxLength);
    }
    return clean;
  }

  public map(documents: CanonicalAccountingDocument[], correlationId: string): OmegaImportPayload {
    let content = 'R00\tL-CODE\tOMEGA_IMPORT\r\n'; // Mock header
    let docCount = 0;
    let itemCount = 0;

    for (const doc of documents) {
      // Gate 4 will catch missing required fields, but the mapper itself shouldn't crash unless it's impossible to map
      const docType = doc.documentType === 'INVOICE' ? 'OFA' : 'ODD';
      
      const r01 = [
        'R01',
        this.sanitizeString(doc.sourceDocumentId), // Císlo dokladu
        this.sanitizeString(doc.sourceDocumentId), // Evidencni cislo
        docType,
        this.formatDate(doc.issueDate),
        this.sanitizeString(doc.customer.ico),
        this.sanitizeString(doc.customer.dic),
        this.sanitizeString(doc.customer.name, 100),
        this.sanitizeString(doc.customer.street),
        this.sanitizeString(doc.customer.city),
        this.sanitizeString(doc.customer.zipCode?.replace(/\s/g, '')),
        this.sanitizeString(doc.currency)
      ];

      content += r01.join('\t') + '\r\n';
      docCount++;

      for (const line of doc.lines) {
        const r02 = [
          'R02',
          this.sanitizeString(doc.sourceDocumentId), // vazba na doklad
          this.sanitizeString(line.text, 200),
          this.formatDecimal(line.quantity),
          this.formatDecimal(line.unitPriceWithoutTax),
          line.taxRate.toString().padStart(2, '0'), // 21, 00
          this.formatDecimal(line.taxAmount),
          this.formatDecimal(line.totalWithTax)
        ];
        
        content += r02.join('\t') + '\r\n';
        itemCount++;
      }
    }

    const hash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');

    return {
      content,
      encoding: 'Windows-1250',
      payloadHash: hash,
      documentCount: docCount,
      itemCount,
      correlationId,
      omegaFormatVersion: 'v1.0'
    };
  }
}
