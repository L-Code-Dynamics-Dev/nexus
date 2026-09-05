import { Rule, RuleContext, RuleResult } from '../RuleTypes.js';

export class SourceDocumentIdExistsRule implements Rule {
  id = 'IDENTITY_001';
  version = '1.0';
  description = 'Source document ID must exist';

  evaluate(context: RuleContext): RuleResult {
    if (!context.order.orderNumber) {
      return { ruleId: this.id, ruleVersion: this.version, status: 'REJECT', reason: 'Missing orderNumber' };
    }
    return { ruleId: this.id, ruleVersion: this.version, status: 'PASS' };
  }
}

export class CustomerIdentityValidRule implements Rule {
  id = 'CUSTOMER_001';
  version = '1.0';
  description = 'Customer identity is valid and consistent';

  evaluate(context: RuleContext): RuleResult {
    const cust = context.order.customer;
    if (!cust) return { ruleId: this.id, ruleVersion: this.version, status: 'REJECT', reason: 'Missing customer' };
    
    // Core accounting assumption: either email or ICO or DIC is present to identify a party
    if (!cust.email && !cust.ico && !cust.dic) {
      return { ruleId: this.id, ruleVersion: this.version, status: 'UNKNOWN', reason: 'Customer lacks both email and tax identifiers' };
    }

    if (cust.isCompany && !cust.ico && !cust.dic) {
      return { ruleId: this.id, ruleVersion: this.version, status: 'UNKNOWN', reason: 'Company customer missing ICO and DIC' };
    }

    return { ruleId: this.id, ruleVersion: this.version, status: 'PASS' };
  }
}
