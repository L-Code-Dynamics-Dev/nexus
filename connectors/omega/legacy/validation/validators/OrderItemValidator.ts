import { Decimal } from 'decimal.js';
import { OrderItem } from '../../domain/CanonicalModel.js';
import { ValidationResult, createResult, addError, mergeResults } from '../../../../shoptet/legacy/validation/types.js';
import { validateMoney } from './MoneyValidator.js';
import { validateTax } from './TaxValidator.js';

export const validateOrderItem = (item: any, expectedCurrency: string): ValidationResult => {
  const result = createResult();

  if (!item) {
    addError(result, 'ITEM_MISSING', '', 'Item is missing');
    return result;
  }

  if (!item.id) addError(result, 'ITEM_ID_MISSING', 'id', 'Item ID is missing');
  if (!item.name) addError(result, 'ITEM_NAME_MISSING', 'name', 'Item name is missing');
  
  if (item.quantity === undefined || item.quantity === null) {
    addError(result, 'ITEM_QUANTITY_MISSING', 'quantity', 'Quantity is missing');
  } else {
    try {
      const qty = new Decimal(item.quantity);
      if (qty.isNaN() || !qty.isFinite() || qty.lte(0)) {
        addError(result, 'ITEM_QUANTITY_INVALID', 'quantity', 'Quantity must be greater than zero');
      }
    } catch (e) {
      addError(result, 'ITEM_QUANTITY_INVALID', 'quantity', 'Quantity is not a valid Decimal');
    }
  }

  mergeResults(result, validateMoney(item.unitPriceWithoutTax, expectedCurrency), 'unitPriceWithoutTax');
  mergeResults(result, validateTax(item.tax, expectedCurrency), 'tax');
  mergeResults(result, validateMoney(item.unitPriceWithTax, expectedCurrency), 'unitPriceWithTax');
  mergeResults(result, validateMoney(item.totalPriceWithTax, expectedCurrency), 'totalPriceWithTax');

  // We could add mathematical validation here (unitPriceWithTax * quantity === totalPriceWithTax), 
  // but let's keep it structurally sound first and add it in OrderValidator or here.
  if (result.valid) {
    try {
      const qty = new Decimal(item.quantity);
      const expectedTotal = new Decimal(item.unitPriceWithTax.amount).times(qty);
      const actualTotal = new Decimal(item.totalPriceWithTax.amount);
      if (!expectedTotal.equals(actualTotal)) {
        addError(result, 'ITEM_TOTAL_MISMATCH', 'totalPriceWithTax', `Expected total ${expectedTotal.toString()} but got ${actualTotal.toString()}`);
      }
    } catch (e) {
      // already caught by validateMoney
    }
  }

  return result;
};
