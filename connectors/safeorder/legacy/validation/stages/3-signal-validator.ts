import { FraudSignalRecord, NetworkSignalRecord } from '../../core/types.js';
import { StageValidationResult, ValidationStage } from './types.js';

export interface ValidatedSignalSet {
  validPrivateSignals: FraudSignalRecord[];
  validNetworkSignals: NetworkSignalRecord[];
  totalActiveCount: number;
  filteredExpiredCount: number;
}

/**
 * Stage 3: Signal Validation (Intelligence Guard)
 *
 * Verifies freshness, tenant isolation, expiration timestamps,
 * confidence bounds, and valid signal types before scoring.
 */
export function validateSignalsStage(
  tenantId: string,
  rawPrivateSignals: FraudSignalRecord[],
  rawNetworkSignals: NetworkSignalRecord[] = [],
  now = Date.now()
): StageValidationResult<ValidatedSignalSet> {
  const start = performance.now();

  const validPrivate: FraudSignalRecord[] = [];
  const validNetwork: NetworkSignalRecord[] = [];
  let expiredCount = 0;

  for (const signal of rawPrivateSignals) {
    // 1. Verify tenant boundary
    if (signal.tenant_id !== tenantId) {
      return {
        stage: ValidationStage.SIGNAL,
        passed: false,
        code: 'SIGNAL_TENANT_BOUNDARY_VIOLATION',
        error: `Signal ${signal.id} belongs to tenant '${signal.tenant_id}', not '${tenantId}'.`,
        durationMs: Math.round((performance.now() - start) * 100) / 100
      };
    }

    // 2. Check Expiration
    if (signal.expires_at <= now) {
      expiredCount++;
      continue;
    }

    // 3. Check Confidence Bounds
    if (typeof signal.confidence !== 'number' || signal.confidence < 0.0 || signal.confidence > 1.0) {
      continue; // Skip invalidly formatted signals
    }

    validPrivate.push(signal);
  }

  for (const netSignal of rawNetworkSignals) {
    if (netSignal.expires_at > now && netSignal.contributing_tenant_id !== tenantId) {
      validNetwork.push(netSignal);
    }
  }

  return {
    stage: ValidationStage.SIGNAL,
    passed: true,
    code: 'SIGNAL_VERIFIED_ACTIVE',
    data: {
      validPrivateSignals: validPrivate,
      validNetworkSignals: validNetwork,
      totalActiveCount: validPrivate.length + validNetwork.length,
      filteredExpiredCount: expiredCount
    },
    durationMs: Math.round((performance.now() - start) * 100) / 100
  };
}
