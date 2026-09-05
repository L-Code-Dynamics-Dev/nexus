// LocalizationRule -- migrace legacy i18n/localization.ts (connectors/
// safeorder/legacy/i18n/localization.ts) pod Nexus Rule contract.
// Fáze 2 pokračování (docs/MIGRATION_PLAN.md).
//
// Zachováno 1:1: localizeReasonCodes (lookup do REASON_DICTIONARY per
// jazyk cs/en/de/pl, fallback na en, neznámý kód se vrátí beze změny),
// formatCurrencyAmount (Intl.NumberFormat per locale). Obě čisté funkce,
// žádné I/O.

import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import { localizeReasonCodes, formatCurrencyAmount } from '../../connectors/safeorder/legacy/i18n/localization.js';
import type { SupportedCurrency, SupportedLanguage } from '../../connectors/safeorder/legacy/core/types.js';

export interface LocalizeReasonCodesInput {
    readonly reasonCodes: string[];
    readonly lang?: SupportedLanguage;
}

export class LocalizeReasonCodesRule implements Rule<LocalizeReasonCodesInput, string[]> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: LocalizeReasonCodesInput): string[] {
        return localizeReasonCodes(input.reasonCodes, input.lang);
    }
}

export interface FormatCurrencyAmountInput {
    readonly amount: number;
    readonly currency?: SupportedCurrency;
    readonly lang?: SupportedLanguage;
}

export class FormatCurrencyAmountRule implements Rule<FormatCurrencyAmountInput, string> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: FormatCurrencyAmountInput): string {
        return formatCurrencyAmount(input.amount, input.currency, input.lang);
    }
}
