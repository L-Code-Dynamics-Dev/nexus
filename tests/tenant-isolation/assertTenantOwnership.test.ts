import { describe, it, expect } from 'vitest';
import { assertTenantOwnership, TenantIsolationViolation, type TenantContext } from '../../core/tenant/types.js';

describe('assertTenantOwnership', () => {
    const context: TenantContext = { tenantId: 'ten_a', platform: 'shoptet' };

    it('passes silently when entity belongs to the context tenant', () => {
        expect(() =>
            assertTenantOwnership(context, { tenantId: 'ten_a' }, 'PurchaseOrderLine', 'pol_1')
        ).not.toThrow();
    });

    it('throws TenantIsolationViolation when entity belongs to a different tenant', () => {
        expect(() =>
            assertTenantOwnership(context, { tenantId: 'ten_b' }, 'PurchaseOrderLine', 'pol_1')
        ).toThrow(TenantIsolationViolation);
    });

    it('violation carries expected/actual tenant ids and entity identity for audit', () => {
        try {
            assertTenantOwnership(context, { tenantId: 'ten_b' }, 'PurchaseOrderLine', 'pol_1');
            expect.unreachable('should have thrown');
        } catch (e) {
            const err = e as TenantIsolationViolation;
            expect(err.expectedTenantId).toBe('ten_a');
            expect(err.actualTenantId).toBe('ten_b');
            expect(err.entity).toBe('PurchaseOrderLine');
            expect(err.entityId).toBe('pol_1');
        }
    });
});
