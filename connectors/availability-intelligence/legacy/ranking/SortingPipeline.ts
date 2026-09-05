import { AvailabilityResult } from '../availability/types.js';

export class SortingPipeline {
    /**
     * Sorts products prioritizing Availability, then Business Sorting, then Relevance.
     * 
     * Primary: Availability Score
     * Secondary: baseSortPriority (e.g. bestseller)
     * Tertiary: relevanceScore
     */
    public static sort(results: AvailabilityResult[]): AvailabilityResult[] {
        return [...results].sort((a, b) => {
            // 1. Primary: Availability
            if (b.score !== a.score) {
                return b.score - a.score;
            }
            
            // 2. Secondary: Business priority (assuming higher is better)
            if (b.baseSortPriority !== a.baseSortPriority) {
                return b.baseSortPriority - a.baseSortPriority;
            }
            
            // 3. Tertiary: Relevance / tie-breaker
            if (b.relevanceScore !== a.relevanceScore) {
                return b.relevanceScore - a.relevanceScore;
            }
            
            // Deterministic fallback (e.g. alphabetical by ID)
            return a.productId.localeCompare(b.productId);
        });
    }
}
