// Rule contract -- referenční vzor: Promotion/ClearanceEntry (jediné plně
// ověřené 5vrstvé chování v celém legacy portfoliu, viz
// docs/CANONICAL_MODEL_SYNTHESIS.md §8).
//
// input -> source -> derived -> decision -> execution -> reconciliation -> outcome
//
// TVRDÝ POŽADAVEK: Rule MUSÍ být deterministická.
//   stejný vstup + stejná konfigurace (ruleVersion) = stejný výsledek
// Žádné skryté side effects uvnitř evaluate().

export interface RuleContext {
    readonly tenantId: string;
    readonly ruleId: string;
    readonly ruleVersion: string;
}

/**
 * Generický kontrakt -- konkrétní domény (PricingRule, RiskRule,
 * PromotionRule, ...) implementují TInput/TResult, evaluate() zůstává
 * čistá funkce bez I/O.
 */
export interface Rule<TInput, TResult> {
    readonly context: RuleContext;
    evaluate(input: TInput): TResult;
}

/**
 * Domény, které Rule kontrakt pokrývá (dle Jan's zadání) -- žádná z nich
 * zde není implementována, jen vyjmenována jako budoucí konzumenti:
 *   Pricing rules, Discount/Loyalty rules, Quantity rules,
 *   Promotion/Campaign rules, Availability/Procurement rules,
 *   SafeOrder risk rules, Economic decision rules.
 */
