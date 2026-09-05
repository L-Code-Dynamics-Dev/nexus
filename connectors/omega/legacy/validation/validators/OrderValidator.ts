import { Decimal } from 'decimal.js';
import { ValidationResult, createResult, addError, mergeResults } from '../../../../shoptet/legacy/validation/types.js';
import { validateCustomer } from './CustomerValidator.js';
import { validateOrderItem } from './OrderItemValidator.js';
import { validateShipping, validatePayment, validateDiscount } from './ServicesValidators.js';
import { validateMoney } from './MoneyValidator.js';

export const validateOrder = (order: any): ValidationResult => {
  const result = createResult();

  if (!order) {
    addError(result, 'ORDER_MISSING', '', 'Order is missing');
    return result;
  }

  if (!order.tenantId) addError(result, 'TENANT_ID_MISSING', 'tenantId', 'Tenant ID is missing');
  if (!order.shopId) addError(result, 'SHOP_ID_MISSING', 'shopId', 'Shop ID is missing');
  if (!order.orderNumber) addError(result, 'ORDER_NUMBER_MISSING', 'orderNumber', 'Order number is missing');
  if (!order.createdAt || isNaN(new Date(order.createdAt).getTime())) {
    addError(result, 'ORDER_DATE_INVALID', 'createdAt', 'Order date is missing or invalid');
  }

  mergeResults(result, validateCustomer(order.customer), 'customer');

  // We need to establish expected currency from totalAmount to ensure currency consistency
  let expectedCurrency: string | undefined;
  if (order.totalAmount && typeof order.totalAmount.currency === 'string') {
    expectedCurrency = order.totalAmount.currency;
  } else {
    addError(result, 'ORDER_CURRENCY_MISSING', 'totalAmount.currency', 'Order currency cannot be determined from totalAmount');
  }

  mergeResults(result, validateMoney(order.totalAmount, expectedCurrency), 'totalAmount');

  if (expectedCurrency) {
    if (!Array.isArray(order.items) || order.items.length === 0) {
      addError(result, 'ORDER_ITEMS_MISSING', 'items', 'Order must contain at least one item');
    } else {
      order.items.forEach((item: any, index: number) => {
        mergeResults(result, validateOrderItem(item, expectedCurrency as string), `items[${index}]`);
      });
    }

    mergeResults(result, validateShipping(order.shipping, expectedCurrency), 'shipping');
    mergeResults(result, validatePayment(order.payment, expectedCurrency), 'payment');

    if (Array.isArray(order.discounts)) {
      order.discounts.forEach((discount: any, index: number) => {
        mergeResults(result, validateDiscount(discount, expectedCurrency as string), `discounts[${index}]`);
      });
    }

    // Total Consistency check
    if (result.valid) {
      let sumItems = new Decimal(0);
      order.items.forEach((item: any) => {
        sumItems = sumItems.plus(new Decimal(item.totalPriceWithTax.amount));
      });

      const shippingTotal = new Decimal(order.shipping.priceWithTax.amount);
      const paymentTotal = new Decimal(order.payment.priceWithTax.amount);
      
      let discountsTotal = new Decimal(0);
      if (Array.isArray(order.discounts)) {
        order.discounts.forEach((d: any) => {
          discountsTotal = discountsTotal.plus(new Decimal(d.amountWithTax.amount));
        });
      }

      const expectedTotal = sumItems.plus(shippingTotal).plus(paymentTotal).minus(discountsTotal);
      const actualTotal = new Decimal(order.totalAmount.amount);

      if (!expectedTotal.equals(actualTotal)) {
        addError(result, 'ORDER_TOTAL_MISMATCH', 'totalAmount', `Total inconsistency: items(${sumItems}) + ship(${shippingTotal}) + pay(${paymentTotal}) - disc(${discountsTotal}) = ${expectedTotal} != ${actualTotal}`);
      }
    }
  }

  return result;
};
