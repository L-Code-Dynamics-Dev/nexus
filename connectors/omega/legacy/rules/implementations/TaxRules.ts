import { Rule, RuleContext, RuleResult } from '../RuleTypes.js';

export class VatDeterminationRule implements Rule {
  id = 'VAT_001';
  version = '1.0';
  description = 'VAT information must be internally consistent and determinable';

  evaluate(context: RuleContext): RuleResult {
    let hasMissingVat = false;
    
    for (const item of context.order.items) {
      if (item.tax.rate === undefined || item.tax.rate === null) {
        hasMissingVat = true;
      }
    }

    if (context.order.shipping && (context.order.shipping.tax.rate === undefined || context.order.shipping.tax.rate === null)) {
      hasMissingVat = true;
    }

    if (hasMissingVat) {
      // Missing VAT is dangerous to guess, return UNKNOWN
      return {
        ruleId: this.id,
        ruleVersion: this.version,
        status: 'UNKNOWN',
        reason: 'VAT rate cannot be determined safely for one or more items/services'
      };
    }

    return { ruleId: this.id, ruleVersion: this.version, status: 'PASS' };
  }
}
