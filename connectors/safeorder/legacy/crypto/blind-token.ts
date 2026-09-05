/**
 * SafeOrder Domain-Namespaced Blind Token Generator (Web Crypto API)
 *
 * Implements strict domain separation to prevent accidental cross-tenant
 * or cross-network correlation attacks.
 *
 * Private Format: 'SO:v1:priv:<tenant_id>:bt_<version>_<hex64>'
 * Network Format: 'SO:v1:net:bt_<version>_<hex64>'
 */

const encoder = new TextEncoder();

export type BlindTokenDomain = 'PRIVATE' | 'NETWORK';

/**
 * Derives a CryptoKey for HMAC-SHA256 from a raw secret string.
 */
async function getHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

/**
 * Computes domain-namespaced HMAC-SHA256 blind token.
 *
 * @param canonicalIdentity  Normalized identity string
 * @param secret             The master HMAC secret
 * @param tenantId           Required for PRIVATE domain separation
 * @param domain             'PRIVATE' or 'NETWORK'
 * @param keyVersion         Active key version (defaults to 1)
 */
export async function generateBlindToken(
  canonicalIdentity: string,
  secret: string,
  tenantId?: string,
  domain: BlindTokenDomain = 'PRIVATE',
  keyVersion = 1
): Promise<string> {
  if (!canonicalIdentity || canonicalIdentity.trim().length === 0) {
    throw new Error('Canonical identity cannot be empty.');
  }
  if (!secret || secret.length < 16) {
    throw new Error('HMAC secret must be at least 16 characters.');
  }

  // Domain separation salt prefix
  const domainPrefix = domain === 'PRIVATE'
    ? `SO:v1:priv:${tenantId || 'global'}:`
    : `SO:v1:net:`;

  const key = await getHmacKey(secret);
  const dataToSign = `${domainPrefix}${canonicalIdentity}`;

  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(dataToSign)
  );

  const hexHash = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return `${domainPrefix}bt_v${keyVersion}_${hexHash}`;
}

/**
 * Verifies that a blind token matches the provided canonical identity and tenant scope.
 */
export async function verifyBlindToken(
  canonicalIdentity: string,
  blindToken: string,
  secret: string,
  tenantId?: string
): Promise<boolean> {
  const isPrivate = blindToken.startsWith('SO:v1:priv:');
  const isNetwork = blindToken.startsWith('SO:v1:net:');

  if (!isPrivate && !isNetwork) return false;

  const domain: BlindTokenDomain = isPrivate ? 'PRIVATE' : 'NETWORK';
  const match = blindToken.match(/_v(\d+)_([a-f0-9]{64})$/);
  if (!match || !match[1]) return false;

  const version = parseInt(match[1], 10);
  const expected = await generateBlindToken(canonicalIdentity, secret, tenantId, domain, version);

  return expected === blindToken;
}
