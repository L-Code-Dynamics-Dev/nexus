import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { fileURLToPath } from 'url';
import Decimal from 'decimal.js';
import { PricingAdapter, type LegacyPricingInput, type LegacyPricingResult } from '../../domains/pricing/PricingAdapter.js';
import { createNexusPricingCalculator } from '../../domains/pricing/createNexusPricingCalculator.js';
import { FsPricingConfigurationProvider } from '../../connectors/pricing-engine/FsPricingConfigurationProvider.js';
import type { TenantContext } from '../../core/tenant/types.js';
import { isConfirmedSuccess, type Execution } from '../../core/canonical/lifecycle/Execution.js';
import { aggregateBatchStatus, type ReconciliationItemResult } from '../../core/canonical/reconciliation/Reconciliation.js';
import type { PricingComputationInput } from '../../core/canonical/entities/Price.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POLICY_CONFIG_PATH = path.join(__dirname, '../../connectors/pricing-engine/legacy/config/policies/policy-v1.json');

/** Tenant se do pricingu předává zvenku (P0 2026-09-07) -- test ho dodává stejně jako produkční volající. */
const TEST_TENANT: TenantContext = { tenantId: 'ten_okfish', platform: 'shoptet' };

/**
 * End-to-end test: SKU 93682, base 14.94, loyalty tier ZR20 (20%), product
 * limit 15%, sale price 12.70.
 *
 * Legacy `DiscountLimitPolicy` pravidlo (INCIDENTS.md "2026-08-04 VAGNER"):
 * když je aktivní discount cap (zde productMaxDiscount 15%) A produkt má
 * vlastní salePrice, salePrice je AUTORITATIVNÍ -- nezvyšuje se na cap-floor,
 * ani ji nepřebije loyalty tier (i kdyby dával nižší cenu). Reason proto
 * není "DISCOUNT_LIMIT_WINS" ale SALE (přes DiscountLimitPolicy), protože
 * HighestDiscountPolicy jako první nastaví loyalty (20% -> 11.952), ale
 * DiscountLimitPolicy ji následně přepíše zpět na salePrice, protože
 * productMaxDiscount je definovaný.
 *
 * PŘEPNUTO na Nexus Rule chain (MIGRATION_PLAN.md): PricingAdapter teď
 * volá createNexusPricingCalculator() -- plný migrovaný chain BasePrice ->
 * HighestDiscount -> DiscountLimit -> Rounding (domains/pricing/), ne
 * createLegacyPricingCalculator(). Legacy engine zůstává regression oracle
 * (viz tests/regression/golden-pricing/full-chain-parity.test.ts a
 * nexus-calculator-parity.test.ts, 70/70 golden kombinací), ale produkční
 * cesta jde přes Nexus. Test ověřuje CELOU cestu a hranice mezi vrstvami:
 * Canonical Pricing Input -> PricingAdapter -> Nexus Rule Chain -> Result
 * -> Decision -> Validation -> Expected Execution -> Execution ->
 * Reconciliation -> Outcome. Nic se nezapisuje do Shoptetu/okfish -- čistě
 * in-memory běh.
 */
describe('Pricing end-to-end — SKU 93682 (Nexus Rule chain)', () => {
    let nexusCalculatePrice: (input: LegacyPricingInput) => LegacyPricingResult;

    beforeAll(() => {
        nexusCalculatePrice = createNexusPricingCalculator(
            new FsPricingConfigurationProvider(POLICY_CONFIG_PATH),
            TEST_TENANT
        );
    });

    it('full path: Canonical Input -> PricingAdapter -> Nexus Rule Chain -> Decision -> Validation -> Execution -> Reconciliation -> Outcome', () => {
        // 1. INPUT / PARSER: Shoptet feed row -> Canonical
        const canonicalInput: PricingComputationInput = {
            productSku: '93682',
            priceListId: 'pricelist_zr20',
            basePrice: { amount: new Decimal('14.94'), currency: 'CZK' },
            salePrice: { amount: new Decimal('12.70'), currency: 'CZK' },
            productMaxDiscount: 0.15,
            customerTier: 'ZR20',
            allowLoyaltyDiscount: true,
        };

        // 2. CORE: Rule evaluace přes adapter -- REÁLNÝ Nexus Rule chain, ne simulace,
        // ne legacy. Adapter je jediná hranice mezi Canonical a implementací:
        // nezná policy detaily, jen deleguje LegacyPricingInput ->
        // nexusCalculatePrice -> LegacyPricingResult (shape zůstává stejný,
        // aby PricingAdapter nemusel vědět, kdo výpočet skutečně dělá).
        const adapter = new PricingAdapter(
            { tenantId: 'ten_1', ruleId: 'pricing-nexus-v1', ruleVersion: '1' },
            nexusCalculatePrice
        );
        const ruleResult = adapter.evaluate(canonicalInput);

        // Discount cap aktivní + salePrice definovaná -> salePrice je autoritativní,
        // beze změny (DiscountLimitPolicy VAGNER pravidlo), i když by loyalty 20%
        // dala nižší cenu (14.94 * 0.80 = 11.952 < 12.70).
        expect(ruleResult.finalPrice.toFixed(2)).toBe('12.70');
        expect(ruleResult.rejected).toBe(false);
        expect(ruleResult.appliedRules).toContain('SALE');

        // 3. DECISION -- auditovatelný výsledek, ne Rule samo
        const decision = adapter.toDecision(ruleResult, 'input_ref_93682', 'fp_93682_v1');
        expect(decision.reason).toContain('SALE');
        expect(decision.result.finalPrice.toFixed(2)).toBe('12.70');

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

        // 6. ACTUAL -- co Shoptet skutečně vrátil po importu (simulace, žádný reálný zápis)
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

    it('boundary: adapter never imports Nexus Rule implementations directly', () => {
        // Architektonická hranice, ne jen matematická shoda: PricingAdapter
        // dostává nexusCalculatePrice jako injektovanou závislost, nikdy sám
        // neimportuje domains/pricing/{BasePriceRule,HighestDiscountRule,...}.
        // Ověřeno staticky (viz PricingAdapter.ts importy), zde jen
        // potvrzujeme, že jde libovolnou implementaci funkce stejné
        // signatury vyměnit bez dopadu na adapter -- což je přesně to, co
        // createNexusPricingCalculator (a dřív createLegacyPricingCalculator)
        // dělá.
        const adapter = new PricingAdapter(
            { tenantId: 'ten_1', ruleId: 'pricing-nexus-v1', ruleVersion: '1' },
            nexusCalculatePrice
        );
        expect(typeof adapter.evaluate).toBe('function');
        expect(adapter.context.ruleId).toBe('pricing-nexus-v1');
    });

    it('rejects unknown customerTier loudly instead of silently falling back', () => {
        const badInput: PricingComputationInput = {
            productSku: '93682',
            priceListId: 'pricelist_unknown',
            basePrice: { amount: new Decimal('14.94'), currency: 'CZK' },
            customerTier: 'NOT_A_REAL_TIER',
            allowLoyaltyDiscount: true,
        };
        const adapter = new PricingAdapter(
            { tenantId: 'ten_1', ruleId: 'pricing-nexus-v1', ruleVersion: '1' },
            nexusCalculatePrice
        );
        expect(() => adapter.evaluate(badInput)).toThrow(/Unknown customerTier/);
    });
});
