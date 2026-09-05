import { AvailabilityStatus, AvailabilityScore, ProductAvailabilityInput, AvailabilityResult } from './types.js';

export class AvailabilityEngine {
    
    // Threshold for LOW_STOCK categorization (business decision default: <= 3)
    private static readonly LOW_STOCK_THRESHOLD = 3;
    
    public static evaluate(product: ProductAvailabilityInput): AvailabilityResult {
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
        let outOfStockCount = 0;
        const totalCount = product.variants.length;
        
        for (const variant of product.variants) {
            if (!variant.isPurchasable) {
                outOfStockCount++;
                continue;
            }

            if (variant.inStock) {
                if (variant.stockAmount !== undefined && variant.stockAmount > 0 && variant.stockAmount <= this.LOW_STOCK_THRESHOLD) {
                    lowStockCount++;
                } else {
                    inStockCount++;
                }
            } else if (variant.inTransit) {
                inTransitCount++;
            } else if (variant.onOrder) {
                onOrderCount++;
            } else {
                outOfStockCount++;
            }
        }
        
        const totalAvailableNow = inStockCount + lowStockCount;

        // 1. All variations available (either IN_STOCK or LOW_STOCK)
        if (totalAvailableNow === totalCount) {
            if (lowStockCount > 0 && inStockCount === 0) {
                return this.createResult(product, AvailabilityStatus.LOW_STOCK, 'All variants are low stock', timestamp);
            }
            if (lowStockCount > 0) {
                // Mix of IN_STOCK and LOW_STOCK -> LOW_STOCK warning dominates product level
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
    
    private static createResult(product: ProductAvailabilityInput, status: AvailabilityStatus, reason: string, timestamp: string): AvailabilityResult {
        return {
            productId: product?.id || 'unknown',
            sku: product?.sku,
            status,
            score: AvailabilityScore[status],
            source: product?.source || 'SYSTEM',
            timestamp,
            reason,
            baseSortPriority: product?.baseSortPriority ?? 0,
            relevanceScore: product?.relevanceScore ?? 0
        };
    }
}
