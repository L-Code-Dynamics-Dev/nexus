import { Customer } from '../../domain/CanonicalModel.js';
import { ValidationResult, createResult, addError, mergeResults } from '../../../../shoptet/legacy/validation/types.js';
import { validateAddress } from './AddressValidator.js';

export const validateCustomer = (customer: any): ValidationResult => {
  const result = createResult();

  if (!customer) {
    addError(result, 'CUSTOMER_MISSING', '', 'Customer is missing');
    return result;
  }

  if (!customer.id) {
    addError(result, 'CUSTOMER_ID_MISSING', 'id', 'Customer ID is required');
  }

  if (typeof customer.isCompany !== 'boolean') {
    addError(result, 'CUSTOMER_TYPE_INVALID', 'isCompany', 'isCompany must be a boolean');
  }

  if (!customer.name || typeof customer.name !== 'string') {
    addError(result, 'CUSTOMER_NAME_MISSING', 'name', 'Customer name is required');
  }

  if (customer.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) {
    addError(result, 'CUSTOMER_EMAIL_INVALID', 'email', 'Invalid email format');
  }

  if (customer.isCompany) {
    if (!customer.companyName) {
      addError(result, 'CUSTOMER_COMPANY_NAME_MISSING', 'companyName', 'Company name is required for company customers');
    }
    if (!customer.ico) {
      addError(result, 'CUSTOMER_ICO_MISSING', 'ico', 'ICO is required for company customers');
    }
  }

  const billingResult = validateAddress(customer.billingAddress);
  mergeResults(result, billingResult, 'billingAddress');

  if (customer.shippingAddress) {
    const shippingResult = validateAddress(customer.shippingAddress);
    mergeResults(result, shippingResult, 'shippingAddress');
  }

  return result;
};
