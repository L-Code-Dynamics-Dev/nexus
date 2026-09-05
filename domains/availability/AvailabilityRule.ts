// AvailabilityRule -- migrace legacy AvailabilityEngine (connectors/
// availability-intelligence/legacy/availability/AvailabilityEngine.ts)
// pod Nexus Rule contract. Fáze 3 (docs/MIGRATION_PLAN.md).
//
// 1:1 s legacy: LOW_STOCK_THRESHOLD (3), AvailabilityScore mapa beze
// změny, stejné pořadí rozhodovacích větví (all-available -> partially
// -> in-transit -> on-order -> out-of-stock fallback). Žádná re-
// implementace, jen přenesení do Rule<> tvaru -- ověřeno proti legacy
// referenci v tests/regression/availability/
// availability-sales-units-parity.test.ts.

import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import { AvailabilityStatus, AvailabilityScore } from '../../connectors/availability-intelligence/legacy/availability/types.js';
import type { ProductAvailabilityInput, AvailabilityResult } from '../../connectors/availability-intelligence/legacy/availability/types.js';

const LOW_STOCK_THRESHOLD = 3;

export class AvailabilityRule implements Rule<ProductAvailabilityInput, AvailabilityResult> {
    constructor(public readonly context: RuleContext) {}

    evaluate(product: ProductAvailabilityInput): AvailabilityResult {
        const timestamp = new Date().toISOString();

        if (!product || !product.variants || !Array.isArray(product.variants)) {
            return this.createResult(product, AvailabilityStatus.UNKNOWN, 'Missing or corrupted variant data', timestamp);
        }

        if (product.variants.length === 0) {
            return this.createResult(product, AvailabilityStatus.UNKNOWN, 'No variants found', timestamp);
        }

        let inStockCount = 0;
        let lowStockCount = 0;
        let inTransitCount = 0;
        let onOrderCount = 0;
        const totalCount = product.variants.length;

        for (const variant of product.variants) {
            if (!variant.isPurchasable) {
                continue;
            }

            if (variant.inStock) {
                if (variant.stockAmount !== undefined && variant.stockAmount > 0 && variant.stockAmount <= LOW_STOCK_THRESHOLD) {
                    lowStockCount++;
                } else {
                    inStockCount++;
                }
            } else if (variant.inTransit) {
                inTransitCount++;
            } else if (variant.onOrder) {
                onOrderCount++;
            }
        }

        const totalAvailableNow = inStockCount + lowStockCount;

        // 1. All variations available (either IN_STOCK or LOW_STOCK)
        if (totalAvailableNow === totalCount) {
            if (lowStockCount > 0 && inStockCount === 0) {
                return this.createResult(product, AvailabilityStatus.LOW_STOCK, 'All variants are low stock', timestamp);
            }
            if (lowStockCount > 0) {
                return this.createResult(product, AvailabilityStatus.LOW_STOCK, 'Some variants are low stock', timestamp);
            }
            return this.createResult(product, AvailabilityStatus.IN_STOCK, 'All variants are in stock', timestamp);
        }

        // 2. Some variations available, some not
        if (totalAvailableNow > 0) {
            return this.createResult(product, AvailabilityStatus.PARTIALLY_AVAILABLE, 'Only some variants are physically in stock', timestamp);
        }

        // 3. None physically in stock. Check IN_TRANSIT
        if (inTransitCount > 0) {
            return this.createResult(product, AvailabilityStatus.IN_TRANSIT, 'Not in stock, but items are in transit', timestamp);
        }

        // 4. None in stock or in transit. Check ON_ORDER
        if (onOrderCount > 0) {
            return this.createResult(product, AvailabilityStatus.ON_ORDER, 'Not in stock, but can be ordered', timestamp);
        }

        // 5. Fallback
        return this.createResult(product, AvailabilityStatus.OUT_OF_STOCK, 'No variants are available', timestamp);
    }

    private createResult(product: ProductAvailabilityInput, status: AvailabilityStatus, reason: string, timestamp: string): AvailabilityResult {
        return {
            productId: product?.id || 'unknown',
            sku: product?.sku,
            status,
            score: AvailabilityScore[status],
            source: product?.source || 'SYSTEM',
            timestamp,
            reason,
            baseSortPriority: product?.baseSortPriority ?? 0,
            relevanceScore: product?.relevanceScore ?? 0,
        };
    }
}
