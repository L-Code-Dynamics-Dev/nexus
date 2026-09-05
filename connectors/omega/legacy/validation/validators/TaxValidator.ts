import { Tax } from '../../domain/CanonicalModel.js';
import { ValidationResult, createResult, addError, mergeResults } from '../../../../shoptet/legacy/validation/types.js';
import { validateMoney } from './MoneyValidator.js';

export const validateTax = (tax: any, expectedCurrency: string): ValidationResult => {
  const result = createResult();

  if (!tax) {
    addError(result, 'TAX_MISSING', '', 'Tax object is missing');
    return result;
  }

  if (typeof tax.rate !== 'number' || tax.rate < 0 || tax.rate > 100) {
    addError(result, 'TAX_RATE_INVALID', 'rate', 'Tax rate must be a number between 0 and 100');
  }

  const moneyResult = validateMoney(tax.amount, expectedCurrency);
  mergeResults(result, moneyResult, 'amount');

  return result;
};
