// ValidationRule -- migrace legacy ValidationEngine (connectors/pricing-engine/
// legacy/core/ValidationEngine.ts) pod Nexus Rule contract. Viz
// MIGRATION_PLAN.md: LEGACY POLICY -> NEXUS RULE CONTRACT -> NEXUS
// IMPLEMENTACE -> REGRESSION FIXTURES -> POROVNANI S LEGACY.
//
// POZOR: toto NENI totez jako Nexus 5-stage Validation Framework
// (core/validation/ -- INPUT/PARSER/CORE/OUTPUT/POST, StageResult<T>).
// Ten je architektonicka vrstva NAD timto -- konkretni legacy pricing
// validacni chovani migrujeme jako jednu Rule, kterou 5-stage framework
// muze pozdeji volat v OUTPUT stage, ne naopak.
//
// Zachovano 1:1 vcetne netrivialnich detailu:
//   - validateInput: basePrice check MA PREDNOST pred productMaxDiscount
//     checkem (poradi vyznamne -- pokud jsou obe neplatne, vyhrava
//     "Base price cannot be negative").
//   - `input.productMaxDiscount && (...)` v legacy NENI "je 0 povoleno
//     projit bez kontroly" -- Decimal instance je vzdy truthy v JS, takze
//     check je ve skutecnosti jen "je productMaxDiscount definovany".
//     Decimal(0) TEDY JE plne zkontrolovan (0 neni <0 ani >1 -> valid).
//   - NaN/Infinity Decimal hodnoty: lessThan(0)/greaterThan(1) vraci false
//     pro NaN i Infinity -- nejsou to legacy chybove stavy, propousteji se.

import Decimal from 'decimal.js';
import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';

export interface ValidationInputCheck {
    readonly basePrice: Decimal;
    readonly productMaxDiscount?: Decimal;
}

export interface ValidationResultCheck {
    readonly finalPrice: Decimal;
}

export interface ValidationOutcome {
    readonly valid: boolean;
    readonly reason?: string;
}

export class ValidationRule implements Rule<ValidationInputCheck, ValidationOutcome> {
    constructor(public readonly context: RuleContext) {}

    /** 1:1 legacy ValidationEngine.validateInput(). */
    evaluate(input: ValidationInputCheck): ValidationOutcome {
        if (input.basePrice.lessThan(0)) {
            return { valid: false, reason: 'Base price cannot be negative' };
        }
        if (input.productMaxDiscount !== undefined
            && (input.productMaxDiscount.lessThan(0) || input.productMaxDiscount.greaterThan(1))) {
            return { valid: false, reason: 'Invalid max discount' };
        }
        return { valid: true };
    }

    /** 1:1 legacy ValidationEngine.validateResult(). */
    evaluateResult(result: ValidationResultCheck): ValidationOutcome {
        if (result.finalPrice.lessThan(0)) {
            return { valid: false, reason: 'Final price cannot be negative' };
        }
        return { valid: true };
    }
}
