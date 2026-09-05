import { Decimal } from 'decimal.js';
import { Money } from '../../domain/CanonicalModel.js';
import { ValidationResult, createResult, addError } from '../../../../shoptet/legacy/validation/types.js';

export const validateMoney = (money: any, expectedCurrency?: string): ValidationResult => {
  const result = createResult();

  if (!money) {
    addError(result, 'MONEY_MISSING', '', 'Money object is missing');
    return result;
  }

  if (!money.currency || typeof money.currency !== 'string') {
    addError(result, 'CURRENCY_INVALID', 'currency', 'Currency is missing or invalid');
  } else if (expectedCurrency && money.currency !== expectedCurrency) {
    addError(result, 'CURRENCY_MISMATCH', 'currency', `Expected currency ${expectedCurrency}, got ${money.currency}`);
  }

  if (money.amount === undefined || money.amount === null) {
    addError(result, 'AMOUNT_MISSING', 'amount', 'Amount is missing');
  } else {
    try {
      const amount = new Decimal(money.amount);
      if (amount.isNaN()) {
        addError(result, 'AMOUNT_NAN', 'amount', 'Amount is NaN');
      }
      if (!amount.isFinite()) {
        addError(result, 'AMOUNT_INFINITE', 'amount', 'Amount is infinite');
      }
    } catch (e) {
      addError(result, 'AMOUNT_INVALID', 'amount', 'Amount is not a valid Decimal');
    }
  }

  return result;
};
