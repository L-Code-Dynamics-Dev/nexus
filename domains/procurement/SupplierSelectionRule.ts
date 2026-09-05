// SupplierSelectionRule -- migrace legacy SupplierSelectionEngine
// (connectors/availability-intelligence/legacy/procurement/
// SupplierSelectionEngine.ts) pod Nexus Rule contract.
//
// Zachovano 1:1 vcetne netrivialnich detailu:
//   1. Exact product+variant match -- offer musi byt active A mit stejne
//      productId i variantId jako demand, jinak se vubec nekandiduje.
//   2. Preferuje jednoho supplera, ktery pokryje celou poptavku (singleFullCover)
//      pred multi-supplier splitem -- i kdyz by split dal lepsi cenu.
//   3. Compare/ranking: unitPrice + leadTimeDays*speedWeight - supplierPriority*
//      priorityWeight, tie-break supplierId pak supplierSku (deterministicke
//      poradi, ne insertion order).
//   4. unfulfilled reason rozlisuje NO_SUPPLIER_OFFER (zadna nabidka na tenhle
//      product+variant vubec) vs INSUFFICIENT_SUPPLIER_STOCK (nabidka existuje,
//      ale kapacita nestaci).
//
// POZOR -- ZAMERNA VYJIMKA Z "zadne skryte side effects" (Rule.ts komentar):
// legacy select() prijima `reservedByOffer: Map<string, number>` jako
// MUTOVANY parametr. Tohle NENI cross-request side effect, je to sdileny
// stav v ramci JEDNOHO planning batch behu (ProcurementEngine.plan()
// iteruje pres vsechny demands a musi vedet, kolik uz bylo z kazde offer
// zarezervovano predchozimi demands ve stejnem behu -- jinak by dva
// zakaznici mohli dostat stejnych 10 ks od stejneho supplera). Mapa je
// tedy per-plan-run pracovni stav, ne perzistovany/globalni -- volajici
// (ProcurementPlanRule) ji vytvari cerstvou pro kazde volani evaluate().
// Zachovano beze zmeny misto "cistsiho" navrhu (Rule vraci novou mapu
// pri kazdem volani), protoze by to vyzadovalo O(n^2) kopirovani mapy
// pri planovani velkeho poctu demands -- legacy performance vlastnost,
// ne bug.

import type { Rule, RuleContext } from '../../core/canonical/rules/Rule.js';
import { SupplierSelectionEngine, type SelectionResult } from '../../connectors/availability-intelligence/legacy/procurement/SupplierSelectionEngine.js';
import type { CustomerOrderLine, ProcurementPolicy, SupplierOffer } from '../../connectors/availability-intelligence/legacy/procurement/types.js';

export interface SupplierSelectionRuleInput {
    readonly demand: CustomerOrderLine;
    readonly offers: SupplierOffer[];
    readonly policy: ProcurementPolicy;
    /** Sdileny stav rezervace v ramci jednoho plan() behu -- viz komentar vyse. */
    readonly reservedByOffer: Map<string, number>;
}

export class SupplierSelectionRule implements Rule<SupplierSelectionRuleInput, SelectionResult> {
    constructor(public readonly context: RuleContext) {}

    evaluate(input: SupplierSelectionRuleInput): SelectionResult {
        return SupplierSelectionEngine.select(input.demand, input.offers, input.policy, input.reservedByOffer);
    }
}
