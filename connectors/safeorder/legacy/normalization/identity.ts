import { RawCustomerIdentity } from '../core/types.js';

/**
 * Identity Normalization Module (Version: identity-v1)
 *
 * Provides deterministic, locale-aware normalization for customer identifiers
 * prior to HMAC blind tokenization.
 */

/**
 * Normalizes phone numbers to standard international E.164-like format.
 * Strips whitespace, dashes, slashes, and leading zeros for CZ/SK defaults.
 */
export function canonicalizePhone(phone?: string, defaultCountry = 'CZ'): string {
  if (!phone) return '';
  let cleaned = phone.replace(/[\s\-\(\)\/\.]/g, '');

  if (cleaned.startsWith('00')) {
    cleaned = '+' + cleaned.slice(2);
  }

  // If local format e.g. '777123456' without country code
  if (!cleaned.startsWith('+')) {
    if (defaultCountry === 'CZ') {
      cleaned = '+420' + cleaned;
    } else if (defaultCountry === 'SK') {
      cleaned = '+421' + cleaned;
    }
  }

  return cleaned;
}

/**
 * Normalizes email address (lowercased, trimmed, trimmed dots for standard domains).
 */
export function canonicalizeEmail(email?: string): string {
  if (!email) return '';
  return email.trim().toLowerCase();
}

/**
 * Normalizes street address (strips punctuation, lowercases, standardizes street numbers).
 */
export function canonicalizeStreet(street?: string): string {
  if (!street) return '';
  return street
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove diacritics for robust matching
    .replace(/[,\.\-\/]/g, ' ')
    .replace(/\s+/g, ' ');
}

/**
 * Normalizes postal codes (strips spaces and non-alphanumeric chars).
 */
export function canonicalizeZip(zip?: string): string {
  if (!zip) return '';
  return zip.replace(/\s+/g, '').trim().toUpperCase();
}

/**
 * Generates the full canonical string representation under a specified normalization version.
 * Format: 'phone:<canonical>|email:<canonical>|street:<canonical>|zip:<canonical>'
 */
export function canonicalizeIdentity(
  identity: RawCustomerIdentity,
  version = 'identity-v1'
): string {
  if (version !== 'identity-v1') {
    throw new Error(`Unsupported normalization version: ${version}`);
  }

  const parts: string[] = [];

  const phone = canonicalizePhone(identity.phone, identity.country);
  if (phone) parts.push(`phone:${phone}`);

  const email = canonicalizeEmail(identity.email);
  if (email) parts.push(`email:${email}`);

  const street = canonicalizeStreet(identity.street);
  const zip = canonicalizeZip(identity.zip);
  if (street || zip) {
    parts.push(`addr:${street}|${zip}`);
  }

  if (parts.length === 0) {
    throw new Error('At least one identity attribute (phone, email, or address) must be provided.');
  }

  return parts.sort().join(';');
}
