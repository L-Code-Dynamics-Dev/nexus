import { describe, it, expect } from 'vitest';
import { LocalizeReasonCodesRule, FormatCurrencyAmountRule } from '../../../domains/safeorder/LocalizationRule.js';
import { ComputeExpiryTimestampRule, RETENTION_POLICIES } from '../../../domains/safeorder/RetentionRule.js';
import { localizeReasonCodes, formatCurrencyAmount } from '../../../connectors/safeorder/legacy/i18n/localization.js';
import { computeExpiryTimestamp } from '../../../connectors/safeorder/legacy/privacy/retention.js';

const ctx = { tenantId: 'ten_1', ruleVersion: '1' };

describe('LocalizeReasonCodesRule parity vs legacy localizeReasonCodes', () => {
    const rule = new LocalizeReasonCodesRule({ ...ctx, ruleId: 'localize-v1' });

    it('matches legacy for known codes in Czech', () => {
        const codes = ['UNCOLLECTED_SHIPMENT_DETECTED', 'NO_ADVERSE_SIGNALS'];
        expect(rule.evaluate({ reasonCodes: codes, lang: 'cs' })).toEqual(localizeReasonCodes(codes, 'cs'));
    });

    it('matches legacy default (en) when lang omitted', () => {
        const codes = ['MERCHANT_MANUAL_FLAG'];
        expect(rule.evaluate({ reasonCodes: codes })).toEqual(localizeReasonCodes(codes));
    });

    it('matches legacy fallback for unknown code (returned unchanged)', () => {
        const codes = ['NOT_A_REAL_CODE'];
        expect(rule.evaluate({ reasonCodes: codes, lang: 'de' })).toEqual(localizeReasonCodes(codes, 'de'));
    });
});

describe('FormatCurrencyAmountRule parity vs legacy formatCurrencyAmount', () => {
    const rule = new FormatCurrencyAmountRule({ ...ctx, ruleId: 'format-currency-v1' });

    it('matches legacy for CZK/cs', () => {
        expect(rule.evaluate({ amount: 1234.5, currency: 'CZK', lang: 'cs' })).toBe(formatCurrencyAmount(1234.5, 'CZK', 'cs'));
    });

    it('matches legacy defaults (EUR/en)', () => {
        expect(rule.evaluate({ amount: 100 })).toBe(formatCurrencyAmount(100));
    });
});

describe('ComputeExpiryTimestampRule parity vs legacy computeExpiryTimestamp', () => {
    const rule = new ComputeExpiryTimestampRule({ ...ctx, ruleId: 'expiry-v1' });

    it('matches legacy for fraud_signals retention (90 days)', () => {
        const createdAtMs = Date.parse('2026-09-05T00:00:00Z');
        const retentionDays = RETENTION_POLICIES.fraud_signals!.defaultRetentionDays;
        expect(rule.evaluate({ createdAtMs, retentionDays })).toBe(computeExpiryTimestamp(createdAtMs, retentionDays));
    });

    it('matches legacy for auth_sessions retention (1 day)', () => {
        const createdAtMs = Date.parse('2026-09-05T00:00:00Z');
        const retentionDays = RETENTION_POLICIES.auth_sessions!.defaultRetentionDays;
        expect(rule.evaluate({ createdAtMs, retentionDays })).toBe(computeExpiryTimestamp(createdAtMs, retentionDays));
    });
});
