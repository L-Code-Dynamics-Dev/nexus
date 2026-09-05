/**
 * Privacy & Retention Policy Engine
 *
 * Implements automated expiration enforcement and GDPR Data Subject Access Requests (DSAR).
 */

export interface RetentionPolicy {
  dataType: 'fraud_signals' | 'webhook_events' | 'decision_audit' | 'auth_sessions';
  defaultRetentionDays: number;
  deletionStrategy: 'HARD_DELETE' | 'ANONYMIZE';
}

export const RETENTION_POLICIES: Record<string, RetentionPolicy> = {
  fraud_signals: {
    dataType: 'fraud_signals',
    defaultRetentionDays: 90, // 90 days default expiration
    deletionStrategy: 'HARD_DELETE'
  },
  webhook_events: {
    dataType: 'webhook_events',
    defaultRetentionDays: 30, // 30 days for webhook payload logs
    deletionStrategy: 'HARD_DELETE'
  },
  decision_audit: {
    dataType: 'decision_audit',
    defaultRetentionDays: 365, // 1 year for compliance audit ledger
    deletionStrategy: 'HARD_DELETE'
  },
  auth_sessions: {
    dataType: 'auth_sessions',
    defaultRetentionDays: 1, // 24 hours for short-lived session nonces
    deletionStrategy: 'HARD_DELETE'
  }
};

/**
 * Computes expiration timestamp in milliseconds from creation time.
 */
export function computeExpiryTimestamp(createdAtMs: number, retentionDays: number): number {
  return createdAtMs + retentionDays * 24 * 60 * 60 * 1000;
}
