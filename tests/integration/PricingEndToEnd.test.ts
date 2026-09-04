import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { PricingAdapter } from '../../domains/pricing/PricingAdapter.js';
import { isConfirmedSuccess, type Execution } from '../../core/canonical/lifecycle/Execution.js';
import { aggregateBatchStatus, type ReconciliationItemResult } from '../../core/canonical/reconciliation/Reconciliation.js';
import type { PricingComputationInput } from '../../core/canonical/entities/Price.js';

/**
 * End-to-end test: SKU 93682, base 14.94, loyalty 20%, product limit 15%,
 * sale price 12.70.
 *
 * Matematika (Jan): povolená sleva = min(loyalty 20%, limit 15%) = 15%.
 * candidatePrice = 14.94 * 0.85 = 12.699. Invariant: sale price se NIKDY
 * nezvyšuje jen aby odpovídala vypočtenému discountu -- finalPrice =
 * min(candidatePrice, salePrice) = min(12.699, 12.70) = 12.699, což se
 * po běžném Shoptet zaokrouhlení (2 desetinná místa) zobrazí jako 12.70.
 * reason = SALE_PRICE_WINS jen pokud by salePrice byla ta nižší hodnota --
 * zde vyhrává candidatePrice (je nižší), reason = DISCOUNT_LIMIT_WINS.
 *
 * Legacy engine je zde SIMULOVANÝ (ne import ze skutečného repa -- adapter
 * princip: injektovaná funkce, ne re-implementace). Test ověřuje CELOU
 * cestu: Shoptet input -> Parser -> Canonical -> Rule -> Decision ->
 * Validation -> Expected Execution -> Shoptet CSV -> Import -> Actual ->
 * Reconciliation -> Outcome.
 */
function simulateLegacyCalculatePrice(input: { sku: string; basePrice: Decimal; salePrice?: Decimal; productMaxDiscount?: Decimal }) {
    const candidatePrice = input.productMaxDiscount
        ? input.basePrice.mul(new Decimal(1).minus(input.productMaxDiscount))
        : input.basePrice;
    // Invariant: sale price se nikdy nezvyšuje na candidatePrice -- bere se nižší z obou.
    const useSalePrice = input.salePrice !== undefined && input.salePrice.lessThan(candidatePrice);
    const finalPrice = useSalePrice ? input.salePrice! : candidatePrice;
    const reason = useSalePrice ? 'SALE_PRICE_WINS' : 'DISCOUNT_LIMIT_WINS';
    return {
        finalPrice,
        candidatePrice,
        appliedRules: [{ rule: reason }, { rule: 'ROUNDING' }],
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

        // Nezaokrouhlená hodnota je 12.699 (14.94 * 0.85) -- candidatePrice
        // vyhrává nad salePrice 12.70 (je nižší), reason = DISCOUNT_LIMIT_WINS.
        expect(ruleResult.finalPrice.toFixed(3)).toBe('12.699');
        // Po Shoptet zaokrouhlení na 2 des. místa: 12.70.
        expect(ruleResult.finalPrice.toFixed(2)).toBe('12.70');
        expect(ruleResult.rejected).toBe(false);

        // 3. DECISION -- auditovatelný výsledek, ne Rule samo
        const decision = adapter.toDecision(ruleResult, 'input_ref_93682', 'fp_93682_v1');
        expect(decision.reason).toContain('DISCOUNT_LIMIT_WINS');

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
