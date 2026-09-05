import { RawCustomerIdentity } from '../../core/types.js';
import { canonicalizeIdentity } from '../../normalization/identity.js';
import { generateBlindToken } from '../../crypto/blind-token.js';
import { StageValidationResult, ValidationStage } from './types.js';

export interface ValidatedIdentityData {
  canonicalString: string;
  blindToken: string;
  networkBlindToken: string;
  normalizationVersion: string;
  keyVersion: number;
}

/**
 * Stage 2: Identity & Cryptographic Normalization Guard
 *
 * Derives both Tenant-Isolated Private Blind Token and Domain-Separated Network Blind Token.
 */
export async function validateIdentityStage(
  identity: RawCustomerIdentity,
  tenantId: string,
  hmacSecret: string,
  normalizationVersion = 'identity-v1',
  keyVersion = 1
): Promise<StageValidationResult<ValidatedIdentityData>> {
  const start = performance.now();

  try {
    if (!hmacSecret || hmacSecret.length < 16) {
      return {
        stage: ValidationStage.IDENTITY,
        passed: false,
        code: 'IDENTITY_SECRET_KEY_INVALID',
        error: 'Master HMAC key secret is missing or too short.',
        durationMs: Math.round((performance.now() - start) * 100) / 100
      };
    }

    if (normalizationVersion !== 'identity-v1') {
      return {
        stage: ValidationStage.IDENTITY,
        passed: false,
        code: 'IDENTITY_UNSUPPORTED_NORMALIZATION_VERSION',
        error: `Normalization version '${normalizationVersion}' is not registered.`,
        durationMs: Math.round((performance.now() - start) * 100) / 100
      };
    }

    const canonicalString = canonicalizeIdentity(identity, normalizationVersion);

    // 1. Private Domain-Separated Blind Token (Isolated strictly to this tenant)
    const blindToken = await generateBlindToken(canonicalString, hmacSecret, tenantId, 'PRIVATE', keyVersion);

    // 2. Anonymized Network Pool Blind Token (Domain-separated)
    const networkBlindToken = await generateBlindToken(canonicalString, hmacSecret, undefined, 'NETWORK', keyVersion);

    return {
      stage: ValidationStage.IDENTITY,
      passed: true,
      code: 'IDENTITY_VALID_TOKENIZED',
      data: {
        canonicalString,
        blindToken,
        networkBlindToken,
        normalizationVersion,
        keyVersion
      },
      durationMs: Math.round((performance.now() - start) * 100) / 100
    };

  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      stage: ValidationStage.IDENTITY,
      passed: false,
      code: 'IDENTITY_CANONICALIZATION_FAILED',
      error: errorMsg,
      durationMs: Math.round((performance.now() - start) * 100) / 100
    };
  }
}
