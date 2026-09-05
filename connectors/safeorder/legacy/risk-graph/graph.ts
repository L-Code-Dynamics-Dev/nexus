import {
  createRawRiskScore,
  createRiskConfidence,
  PaymentMethodType,
  RawRiskScore,
  RiskConfidence
} from '../core/types.js';

/**
 * SafeOrder 9.8 — Contextual Risk Graph & Graph Traversal Service
 */

export type GraphNodeType = 'IDENTITY' | 'ADDRESS_CLUSTER' | 'PAYMENT_FINGERPRINT' | 'ORDER' | 'OUTCOME';
export type GraphEdgeType = 'PLACED_ORDER' | 'SHIPPED_TO' | 'PAID_WITH' | 'RESULTED_IN_OUTCOME' | 'ALIAS_OF';

export interface GraphNode {
  id: string;
  tenantId: string;
  type: GraphNodeType;
  blindToken: string;
  totalOrders: number;
  successfulDeliveries: number;
  rtoCount: number;
  returnCount: number;
  totalSpend: number;
}

export interface GraphEdge {
  id: string;
  tenantId: string;
  sourceNodeId: string;
  targetNodeId: string;
  edgeType: GraphEdgeType;
  weight: number;
}

export interface ContextualOrderParams {
  orderTotal: number;
  paymentMethod: PaymentMethodType;
  currency: string;
}

export interface ContextualRiskResult {
  contextualScore: RawRiskScore;
  confidence: RiskConfidence;
  contextFactors: string[];
}

export function evaluateContextualRisk(
  entityNode: GraphNode | null,
  order: ContextualOrderParams,
  averageOrderValue = 50.0
): ContextualRiskResult {
  const factors: string[] = [];
  let baseScore = 0.0;

  // 1. Graph Entity History Analysis
  if (entityNode && entityNode.totalOrders > 0) {
    const rtoRatio = entityNode.rtoCount / entityNode.totalOrders;
    const deliveryRatio = entityNode.successfulDeliveries / entityNode.totalOrders;

    if (entityNode.rtoCount >= 2 && rtoRatio > 0.4) {
      baseScore += 1.8;
      factors.push(`HIGH_HISTORICAL_RTO_RATIO_${Math.round(rtoRatio * 100)}%`);
    } else if (entityNode.rtoCount === 1) {
      baseScore += 0.6;
      factors.push('SINGLE_PREVIOUS_RTO');
    }

    if (entityNode.successfulDeliveries >= 3 && deliveryRatio > 0.85) {
      baseScore -= 1.0;
      factors.push('TRUSTED_REPEAT_BUYER');
    }
  } else {
    factors.push('FIRST_TIME_BUYER');
  }

  // 2. Explicit Payment Method Evaluation (NO implicit COD assumptions!)
  if (order.paymentMethod === 'COD') {
    factors.push('CASH_ON_DELIVERY_REQUESTED');

    if (order.orderTotal > averageOrderValue * 2.5) {
      baseScore += 1.2;
      factors.push('HIGH_VALUE_COD_EXPOSURE');
    } else if (order.orderTotal > averageOrderValue * 1.5) {
      baseScore += 0.5;
      factors.push('ELEVATED_VALUE_COD');
    }
  } else if (order.paymentMethod === 'PREPAID' || order.paymentMethod === 'CARD' || order.paymentMethod === 'BANK_TRANSFER') {
    // Prepaid orders have virtually zero uncollected delivery loss
    baseScore = Math.max(0.0, baseScore * 0.2);
    factors.push('PREPAID_PROTECTED');
  } else {
    // Unknown or Other payment method
    factors.push('UNVERIFIED_PAYMENT_METHOD');
  }

  const contextualScore = createRawRiskScore(Math.max(0.0, baseScore));
  const totalObserved = entityNode ? entityNode.totalOrders : 0;
  const confidence = createRiskConfidence(
    totalObserved >= 5 ? 0.90 : totalObserved >= 1 ? 0.65 : 0.30
  );

  return {
    contextualScore,
    confidence,
    contextFactors: factors
  };
}
