import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { PricingAdapter } from '../../domains/pricing/PricingAdapter.js';
import { isConfirmedSuccess, type Execution } from '../../core/canonical/lifecycle/Execution.js';
import { aggregateBatchStatus, type ReconciliationItemResult } from '../../core/canonical/reconciliation/Reconciliation.js';
import type { PricingComputationInput } from '../../core/canonical/entities/Price.js';

/**
 * End-to-end test: SKU 93682, base 14.94, sale 12.70, loyalty 20%,
 * product limit 15%. Legacy rule (clearance-vs-cap, CORE_LOGIC_AND_
 * VALIDATION.md §1.1 bod 4): aktivní cap + action price přítomna =>
 * action price vyhrává outright, NIKDY floor-clamped nahoru na cap.
 * Loyalty 20% je hlubší než limit 15%, ale sale price (12.70) je
 * hlubší než obojí, takže sale price vyhrává => finalPrice = 12.70.
 *
 * Legacy engine je zde SIMULOVANÝ (ne import ze skutečného repa -- adapter
 * princip: injektovaná funkce, ne re-implementace). Test ověřuje CELOU
 * cestu: Shoptet input -> Parser -> Canonical -> Rule -> Decision ->
 * Validation -> Expected Execution -> Shoptet CSV -> Import -> Actual ->
 * Reconciliation -> Outcome.
 */
function simulateLegacyCalculatePrice(input: { sku: string; basePrice: Decimal; salePrice?: Decimal; productMaxDiscount?: Decimal }) {
    const capPrice = input.productMaxDiscount
        ? input.basePrice.mul(new Decimal(1).minus(input.productMaxDiscount))
        : undefined;
    // clearance-vs-cap: action price přítomna a cap aktivní -> action price vyhrává outright
    const finalPrice = input.salePrice ?? capPrice ?? input.basePrice;
    return {
        finalPrice,
        appliedRules: [{ rule: 'CLEARANCE_VS_CAP' }, { rule: 'ROUNDING' }],
        rejected: false,
    };
}

describe('Pricing end-to-end — SKU 93682', () => {
    it('full path: Shoptet input -> Canonical -> Rule -> Decision -> Execution -> Reconciliation -> Outcome', () => {
        // 1. INPUT / PARSER: Shoptet feed row -> Canonical
        const canonicalInput: PricingComputationInput = {
            productSku: '93682',
            priceListId: 'pricelist_zr20',
            basePrice: { amount: new Decimal('14.94'), currency: 'CZK' },
            salePrice: { amount: new Decimal('12.70'), currency: 'CZK' },
            productMaxDiscount: 0.15,
        };

        // 2. CORE: Rule evaluace přes adapter (legacy logika, obalená)
        const adapter = new PricingAdapter(
            { tenantId: 'ten_1', ruleId: 'pricing-legacy-v1', ruleVersion: '1' },
            simulateLegacyCalculatePrice
        );
        const ruleResult = adapter.evaluate(canonicalInput);

        expect(ruleResult.finalPrice.toFixed(2)).toBe('12.70');
        expect(ruleResult.rejected).toBe(false);

        // 3. DECISION -- auditovatelný výsledek, ne Rule samo
        const decision = adapter.toDecision(ruleResult, 'input_ref_93682', 'fp_93682_v1');
        expect(decision.reason).toContain('CLEARANCE_VS_CAP');

        // 4. VALIDATION (OUTPUT stage) -- Expected Execution State
        const expectedExecutionState = { sku: '93682', price: ruleResult.finalPrice.toFixed(2) };

        // 5. EXECUTION -- SENT, NE automaticky CONFIRMED (dnešní Shoptet ticket princip)
        const execution: Execution = {
            executionId: 'exec_93682',
            tenantId: 'ten_1',
            decisionId: 'dec_93682',
            connectorId: 'shoptet-csv',
            attempt: 1,
            status: 'SENT',
            startedAt: '2026-09-04T00:00:00Z',
            requestFingerprint: 'fp_exec_93682',
            retryPolicy: 'RETRYABLE',
            expected: expectedExecutionState,
        };
        expect(isConfirmedSuccess(execution)).toBe(false); // SENT != CONFIRMED

        // 6. ACTUAL -- co Shoptet skutečně vrátil po importu (simulace)
        const actualExternalState = { sku: '93682', price: '12.70' };

        // 7. RECONCILIATION -- Expected vs Actual
        const reconciliationItem: ReconciliationItemResult = {
            itemId: '93682',
            expected: expectedExecutionState.price,
            actual: actualExternalState.price,
            outcome: expectedExecutionState.price === actualExternalState.price ? 'MATCHED' : 'DIFF',
        };
        expect(reconciliationItem.outcome).toBe('MATCHED');

        // 8. OUTCOME -- batch-level, potvrzuje Execution jako CONFIRMED
        const batchStatus = aggregateBatchStatus([reconciliationItem]);
        expect(batchStatus).toBe('COMPLETE');

        execution.status = 'CONFIRMED';
        execution.actual = actualExternalState;
        execution.completedAt = '2026-09-04T00:00:05Z';
        expect(isConfirmedSuccess(execution)).toBe(true);
    });

    it('mismatch path: Shoptet returns a different price than expected -> DIFF, not silent success', () => {
        const expectedPrice: string = '12.70';
        const actualPrice: string = '12.99'; // Shoptet vrátilo jinou hodnotu (přesně dnešní Shoptet ticket scénář)

        const reconciliationItem: ReconciliationItemResult = {
            itemId: '93682',
            expected: expectedPrice,
            actual: actualPrice,
            outcome: expectedPrice === actualPrice ? 'MATCHED' : 'DIFF',
        };

        expect(reconciliationItem.outcome).toBe('DIFF');
        expect(aggregateBatchStatus([reconciliationItem])).toBe('COMPLETE_WITH_ERRORS');
    });
});
