import { MerchantEconomicProfile, RiskProbability } from '../core/types.js';

/**
 * SafeOrder 9.8 — Decision Economics & Comparative Action Optimization Engine
 *
 * Implements strict currency-safety, action-by-action expected loss comparison,
 * and clear separation of observed, estimated, and counterfactual economics.
 */

export interface ComparativeActionEconomics {
  action: 'ALLOW' | 'REVIEW' | 'RESTRICT_COD' | 'REQUIRE_PREPAYMENT';
  expectedDirectLoss: number;
  expectedFrictionCost: number;
  netEconomicCost: number;
  isActionRecommended: boolean;
}

export interface DecisionEconomicsEvaluation {
  currency: string;
  currencyMatch: boolean;
  actions: Record<string, ComparativeActionEconomics>;
  recommendedAction: 'ALLOW' | 'REVIEW' | 'RESTRICT_COD' | 'REQUIRE_PREPAYMENT' | 'UNCERTAIN_CURRENCY_MISMATCH';
  estimatedNetSavings: number;
  reasoning: string;
}

export function evaluateDecisionEconomics(
  calibratedRtoProbability: RiskProbability,
  orderTotal: number,
  orderCurrency: string,
  profile: MerchantEconomicProfile
): DecisionEconomicsEvaluation {
  // Strict Currency Safety Check: NEVER compare mismatched currencies!
  if (orderCurrency.toUpperCase() !== profile.currency.toUpperCase()) {
    return {
      currency: orderCurrency,
      currencyMatch: false,
      actions: {},
      recommendedAction: 'UNCERTAIN_CURRENCY_MISMATCH',
      estimatedNetSavings: 0,
      reasoning: `Currency mismatch: Order is in ${orderCurrency}, but Merchant Profile is configured in ${profile.currency}. Economics evaluation deferred.`
    };
  }

  // 1. Calculate actual direct loss if RTO occurs:
  // Outbound Shipping + Return Shipping + Restock Packaging + Inventory lock depreciation
  const directRtoLoss =
    profile.shipping_cost_outbound +
    profile.shipping_cost_return +
    profile.restock_packaging_cost +
    orderTotal * profile.product_margin_rate * 0.15;

  const rtoProb = calibratedRtoProbability;
  const legitimateProb = Math.max(0.0, 1.0 - rtoProb);

  // 2. Expected Cost for Action: ALLOW
  // Direct RTO loss occurs with P(RTO); zero customer friction cost
  const lossAllow = Math.round(rtoProb * directRtoLoss * 100) / 100;
  const frictionAllow = 0.0;

  // 3. Expected Cost for Action: RESTRICT_COD
  // Eliminates direct RTO loss; imposes full friction cost on legitimate buyers who preferred COD
  const lossRestrict = 0.0;
  const frictionRestrict = Math.round(legitimateProb * profile.customer_friction_cost * 100) / 100;

  // 4. Expected Cost for Action: REQUIRE_PREPAYMENT
  // Eliminates direct RTO loss; imposes partial friction cost (approx 50% conversion retention)
  const lossPrepayment = 0.0;
  const frictionPrepayment = Math.round(legitimateProb * (profile.customer_friction_cost * 0.5) * 100) / 100;

  // 5. Expected Cost for Action: REVIEW
  // Manual verification catches ~70% of RTOs; imposes operator cost + slight fulfillment delay
  const lossReview = Math.round(rtoProb * (directRtoLoss * 0.30) * 100) / 100;
  const frictionReview = Math.round((1.50 + legitimateProb * (profile.customer_friction_cost * 0.10)) * 100) / 100;

  const actions: Record<string, ComparativeActionEconomics> = {
    ALLOW: {
      action: 'ALLOW',
      expectedDirectLoss: lossAllow,
      expectedFrictionCost: frictionAllow,
      netEconomicCost: Math.round((lossAllow + frictionAllow) * 100) / 100,
      isActionRecommended: false
    },
    REVIEW: {
      action: 'REVIEW',
      expectedDirectLoss: lossReview,
      expectedFrictionCost: frictionReview,
      netEconomicCost: Math.round((lossReview + frictionReview) * 100) / 100,
      isActionRecommended: false
    },
    REQUIRE_PREPAYMENT: {
      action: 'REQUIRE_PREPAYMENT',
      expectedDirectLoss: lossPrepayment,
      expectedFrictionCost: frictionPrepayment,
      netEconomicCost: Math.round((lossPrepayment + frictionPrepayment) * 100) / 100,
      isActionRecommended: false
    },
    RESTRICT_COD: {
      action: 'RESTRICT_COD',
      expectedDirectLoss: lossRestrict,
      expectedFrictionCost: frictionRestrict,
      netEconomicCost: Math.round((lossRestrict + frictionRestrict) * 100) / 100,
      isActionRecommended: false
    }
  };

  // 6. Comparative Economic Cost Minimization
  // Find action with lowest net economic cost
  let bestAction: ComparativeActionEconomics['action'] = 'ALLOW';
  let minCost = actions.ALLOW!.netEconomicCost;

  for (const act of Object.values(actions)) {
    if (act.netEconomicCost < minCost) {
      minCost = act.netEconomicCost;
      bestAction = act.action;
    }
  }

  // Safety buffer: To trigger restrictive actions over standard ALLOW, savings must exceed minimum threshold
  const allowCost = actions.ALLOW!.netEconomicCost;
  if (bestAction !== 'ALLOW' && (allowCost - minCost < 1.0)) {
    bestAction = 'ALLOW';
  }

  actions[bestAction]!.isActionRecommended = true;
  const estimatedNetSavings = Math.max(0, Math.round((allowCost - actions[bestAction]!.netEconomicCost) * 100) / 100);

  const reasoning = bestAction === 'RESTRICT_COD'
    ? `Expected RTO loss (${orderCurrency} ${lossAllow.toFixed(2)}) exceeds customer friction cost (${orderCurrency} ${frictionRestrict.toFixed(2)}). RESTRICT_COD minimizes expected merchant loss.`
    : bestAction === 'REQUIRE_PREPAYMENT'
    ? `Prepayment requirement minimizes combined risk of RTO and checkout abandonment.`
    : bestAction === 'REVIEW'
    ? `Manual review is economically optimal for ambiguous risk exposure.`
    : `Allowing standard checkout minimizes total cost (${orderCurrency} ${allowCost.toFixed(2)}).`;

  return {
    currency: orderCurrency,
    currencyMatch: true,
    actions,
    recommendedAction: bestAction,
    estimatedNetSavings,
    reasoning
  };
}

export function computeMerchantRoi(
  totalEstimatedPreventedLoss: number,
  safeOrderSubscriptionCost: number
): {
  netMerchantSavings: number;
  roiMultiplier: number;
} {
  const netSavings = Math.max(0, totalEstimatedPreventedLoss - safeOrderSubscriptionCost);
  const roiMultiplier = safeOrderSubscriptionCost > 0
    ? Math.round((totalEstimatedPreventedLoss / safeOrderSubscriptionCost) * 10) / 10
    : 0;

  return {
    netMerchantSavings: Math.round(netSavings * 100) / 100,
    roiMultiplier
  };
}
