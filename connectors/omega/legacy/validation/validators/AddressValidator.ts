import { Address } from '../../domain/CanonicalModel.js';
import { ValidationResult, createResult, addError } from '../../../../shoptet/legacy/validation/types.js';

export const validateAddress = (address: any): ValidationResult => {
  const result = createResult();

  if (!address) {
    addError(result, 'ADDRESS_MISSING', '', 'Address is missing');
    return result;
  }

  if (!address.street || typeof address.street !== 'string') {
    addError(result, 'ADDRESS_STREET_MISSING', 'street', 'Street is required');
  }

  if (!address.city || typeof address.city !== 'string') {
    addError(result, 'ADDRESS_CITY_MISSING', 'city', 'City is required');
  }

  if (!address.country || typeof address.country !== 'string') {
    addError(result, 'ADDRESS_COUNTRY_MISSING', 'country', 'Country is required');
  }

  // Postal code is often required, but it can be delegated to specific rules if some countries don't have it.
  // However, the spec says "postal code where required by known configuration" - we'll just check if it's a string if present, or mandate it generally.
  if (!address.zipCode || typeof address.zipCode !== 'string') {
    addError(result, 'ADDRESS_ZIP_MISSING', 'zipCode', 'Zip code is required');
  }

  return result;
};
