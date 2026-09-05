import { ValidationResult, createResult, addError, mergeResults } from '../../../../shoptet/legacy/validation/types.js';
import { validateMoney } from './MoneyValidator.js';
import { validateTax } from './TaxValidator.js';

export const validateShipping = (shipping: any, expectedCurrency: string): ValidationResult => {
  const result = createResult();
  if (!shipping) {
    addError(result, 'SHIPPING_MISSING', '', 'Shipping is missing');
    return result;
  }
  if (!shipping.id) addError(result, 'SHIPPING_ID_MISSING', 'id', 'Shipping ID is missing');
  if (!shipping.name) addError(result, 'SHIPPING_NAME_MISSING', 'name', 'Shipping name is missing');

  mergeResults(result, validateMoney(shipping.priceWithoutTax, expectedCurrency), 'priceWithoutTax');
  mergeResults(result, validateTax(shipping.tax, expectedCurrency), 'tax');
  mergeResults(result, validateMoney(shipping.priceWithTax, expectedCurrency), 'priceWithTax');

  return result;
};

export const validatePayment = (payment: any, expectedCurrency: string): ValidationResult => {
  const result = createResult();
  if (!payment) {
    addError(result, 'PAYMENT_MISSING', '', 'Payment is missing');
    return result;
  }
  if (!payment.id) addError(result, 'PAYMENT_ID_MISSING', 'id', 'Payment ID is missing');
  if (!payment.name) addError(result, 'PAYMENT_NAME_MISSING', 'name', 'Payment name is missing');

  mergeResults(result, validateMoney(payment.priceWithoutTax, expectedCurrency), 'priceWithoutTax');
  mergeResults(result, validateTax(payment.tax, expectedCurrency), 'tax');
  mergeResults(result, validateMoney(payment.priceWithTax, expectedCurrency), 'priceWithTax');

  return result;
};

export const validateDiscount = (discount: any, expectedCurrency: string): ValidationResult => {
  const result = createResult();
  if (!discount) {
    addError(result, 'DISCOUNT_MISSING', '', 'Discount is missing');
    return result;
  }
  if (!discount.id) addError(result, 'DISCOUNT_ID_MISSING', 'id', 'Discount ID is missing');
  if (!discount.name) addError(result, 'DISCOUNT_NAME_MISSING', 'name', 'Discount name is missing');

  mergeResults(result, validateMoney(discount.amountWithTax, expectedCurrency), 'amountWithTax');

  return result;
};
