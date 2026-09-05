import { z } from 'zod';

// ==============================================================================
// 1. Core Domain Enums & Literals
// ==============================================================================

export type Platform = 'shoptet' | 'shopify' | 'woocommerce' | 'magento' | 'custom_api';

export type TenantLifecycleStatus =
  | 'SETUP'
  | 'CONNECTED'
  | 'IMPORTING'
  | 'LEARNING'
  | 'ACTIVE'
  | 'DEGRADED'
  | 'PAUSED'
  | 'DISCONNECTED'
  | 'SUSPENDED'
  | 'UNINSTALLED';

export type TenantStatus = 'ACTIVE' | 'SUSPENDED' | 'UNINSTALLED' | TenantLifecycleStatus;
export type TenantMode = 'PRIVATE' | 'NETWORK';
export type RiskDecisionType = 'ALLOW' | 'REVIEW' | 'RESTRICT';
export type ExecutableActionType = 'ALLOW' | 'RESTRICT_COD' | 'REQUIRE_PREPAYMENT' | 'FLAG_ONLY' | 'UNSUPPORTED_BY_PLATFORM';
export type UserRole = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';

export type PlanTier = 'STARTER' | 'GROWTH' | 'ENTERPRISE' | 'CUSTOM';
export type PlanStatus = 'ACTIVE' | 'GRACE_PERIOD' | 'SUSPENDED' | 'CANCELED';

export type SupportedCurrency = 'EUR' | 'USD' | 'GBP' | 'PLN' | 'CZK';
export type SupportedLanguage = 'en' | 'cs' | 'de' | 'pl';

export type PaymentMethodType =
  | 'COD'
  | 'PREPAID'
  | 'CARD'
  | 'BANK_TRANSFER'
  | 'OTHER'
  | 'UNKNOWN';

export type SignalType =
  | 'UNCOLLECTED_SHIPMENT'
  | 'REPEATED_RETURN'
  | 'MANUAL_FLAG'
  | 'FALSE_POSITIVE'
  | 'MERCHANT_OVERRIDE';

export type OrderOutcomeType =
  | 'DELIVERED_SUCCESS'
  | 'RTO_UNCOLLECTED'
  | 'RETURNED_CUSTOMER'
  | 'CHARGEBACK_FRAUD'
  | 'MERCHANT_OVERRIDE_SUCCESS'
  | 'MERCHANT_OVERRIDE_FAILED'
  | 'UNKNOWN_COUNTERFACTUAL';

export type DsarRequestType =
  | 'ACCESS'
  | 'RECTIFY'
  | 'DELETE'
  | 'RESTRICT'
  | 'OBJECT'
  | 'EXPORT';

export type DataSourceType =
  | 'API'
  | 'WEBHOOK'
  | 'BROWSER'
  | 'PLUGIN'
  | 'CSV'
  | 'XML'
  | 'FEED'
  | 'MANUAL'
  | 'HISTORICAL_IMPORT';

// ==============================================================================
// 2. Branded Domain Primitives (Preventing Primitive Type Confusion)
// ==============================================================================

/** Heuristic/Empirical raw risk score (typically 0.0 to 5.0+) */
export type RawRiskScore = number & { readonly __brand: 'RawRiskScore' };

/** Calibrated mathematical probability of fraud/RTO (strictly 0.0 to 1.0) */
export type RiskProbability = number & { readonly __brand: 'RiskProbability' };

/** Statistical confidence representing evidentiary strength (strictly 0.0 to 1.0) */
export type RiskConfidence = number & { readonly __brand: 'RiskConfidence' };

export function createRawRiskScore(val: number): RawRiskScore {
  return Math.max(0, Math.round(val * 100) / 100) as RawRiskScore;
}

export function createRiskProbability(val: number): RiskProbability {
  return Math.max(0, Math.min(1.0, Math.round(val * 1000) / 1000)) as RiskProbability;
}

export function createRiskConfidence(val: number): RiskConfidence {
  return Math.max(0, Math.min(1.0, Math.round(val * 1000) / 1000)) as RiskConfidence;
}

// ==============================================================================
// 3. Database Records & Domain Entities
// ==============================================================================

export interface TenantRecord {
  id: string;
  platform: Platform;
  platform_shop_id: string;
  status: TenantStatus;
  mode: TenantMode;
  created_at: number;
  updated_at: number;
}

export interface TenantPlanRecord {
  tenant_id: string;
  plan_tier: PlanTier;
  monthly_evaluation_limit: number;
  monthly_evaluations_used: number;
  history_retention_days: number;
  network_access_allowed: number; // 0 or 1
  custom_rules_allowed: number; // 0 or 1
  status: PlanStatus;
  billing_period_start: number;
  billing_period_end: number;
  updated_at: number;
}

export interface TenantPolicyRecord {
  tenant_id: string;
  policy_version: string;
  review_threshold: number;
  restrict_threshold: number;
  signal_retention_days: number;
  cod_policy_action: 'RESTRICT_COD' | 'REQUIRE_PREPAYMENT' | 'FLAG_ONLY';
  network_enabled: number; // 0 or 1
  network_opted_in_at?: number | null;
  fallback_behavior: 'ALLOW' | 'REVIEW' | 'RESTRICT';
  updated_at: number;
}

export interface TenantPolicyHistoryRecord {
  id: string;
  tenant_id: string;
  policy_version: string;
  configuration_diff: string;
  updated_by: string;
  created_at: number;
}

export interface MerchantEconomicProfile {
  tenant_id: string;
  currency: string;                     // e.g. 'EUR', 'CZK', 'USD', 'PLN', 'GBP'
  average_order_value: number;
  product_margin_rate: number;          // 0.0 to 1.0 (e.g. 0.40)
  shipping_cost_outbound: number;
  shipping_cost_return: number;
  restock_packaging_cost: number;
  payment_processing_rate: number;      // e.g. 0.015 (1.5%)
  cod_handling_fee: number;             // e.g. 1.50
  customer_friction_cost: number;       // e.g. 6.00 EUR LTV friction
  updated_at: number;
}

export interface InstallationRecord {
  id: string;
  tenant_id: string;
  platform: Platform;
  external_installation_id: string;
  status: 'INSTALLED' | 'SUSPENDED' | 'UNINSTALLED';
  encrypted_credentials: string;
  credential_version: number;
  scopes: string;
  created_at: number;
  updated_at: number;
  uninstalled_at?: number | null;
}

export interface AuthSession {
  id: string;
  tenant_id: string;
  platform: Platform;
  user_id?: string | null;
  user_role: UserRole;
  nonce: string;
  created_at: number;
  expires_at: number;
}

export interface FraudSignalRecord {
  id: string;
  tenant_id: string;
  blind_token: string;
  key_version: number;
  signal_type: SignalType;
  confidence: number;
  source: string;
  order_ref?: string | null;
  metadata_json?: string | null;
  created_at: number;
  expires_at: number;
  policy_version: string;
}

export interface NetworkSignalRecord {
  id: string;
  blind_token: string;
  contributing_tenant_id: string;
  signal_type: string;
  weight: number;
  created_at: number;
  expires_at: number;
}

export interface DecisionAuditRecord {
  decision_id: string;
  tenant_id: string;
  platform: Platform;
  checkout_session_id?: string | null;
  order_ref?: string | null;
  blind_token: string;
  decision: RiskDecisionType;
  raw_score: number;
  calibrated_probability: number;
  confidence: number;
  reason_codes: string;
  signal_count: number;
  policy_version: string;
  calibration_version: string;
  economic_model_version: string;
  fail_open: number; // 0 or 1
  fail_open_reason?: string | null;
  created_at: number;
}

export interface HumanOverrideRecord {
  id: string;
  decision_id: string;
  tenant_id: string;
  operator_user_id: string;
  previous_decision: string;
  new_decision: 'ALLOW' | 'RESTRICT' | 'FALSE_POSITIVE';
  reason_notes: string;
  created_at: number;
}

// ==============================================================================
// 4. Request Validation Schemas (Zod)
// ==============================================================================

export const PaymentMethodSchema = z.enum([
  'COD',
  'PREPAID',
  'CARD',
  'BANK_TRANSFER',
  'OTHER',
  'UNKNOWN'
]);

export const DataSourceTypeSchema = z.enum([
  'API',
  'WEBHOOK',
  'BROWSER',
  'PLUGIN',
  'CSV',
  'XML',
  'FEED',
  'MANUAL',
  'HISTORICAL_IMPORT'
]);

export const SupportedCurrencySchema = z.enum(['EUR', 'USD', 'GBP', 'PLN', 'CZK']);

export const RawCustomerIdentitySchema = z.object({
  phone: z.string().optional(),
  email: z.string().email().optional(),
  street: z.string().optional(),
  city: z.string().optional(),
  zip: z.string().optional(),
  country: z.string().optional().default('CZ')
});

export type RawCustomerIdentity = z.infer<typeof RawCustomerIdentitySchema>;

export const CheckoutEvaluationRequestSchema = z.object({
  checkoutSessionId: z.string().min(1),
  identity: RawCustomerIdentitySchema,
  paymentMethod: PaymentMethodSchema,
  orderTotal: z.number().positive(),
  currency: z.string().length(3).toUpperCase(),
  sourceType: DataSourceTypeSchema.optional().default('BROWSER')
});

export type CheckoutEvaluationRequest = z.infer<typeof CheckoutEvaluationRequestSchema>;

// SaaS Onboarding Schema
export const OnboardingRegisterSchema = z.object({
  shopId: z.string().min(1),
  platform: z.enum(['shoptet', 'shopify', 'woocommerce', 'magento', 'custom_api']),
  currency: SupportedCurrencySchema.default('EUR'),
  adminEmail: z.string().email(),
  planTier: z.enum(['STARTER', 'GROWTH', 'ENTERPRISE']).default('STARTER'),
  economicDefaults: z.object({
    averageOrderValue: z.number().positive().default(50.0),
    productMarginRate: z.number().min(0.01).max(0.99).default(0.40),
    shippingCostOutbound: z.number().min(0).default(4.50),
    shippingCostReturn: z.number().min(0).default(4.50),
    restockPackagingCost: z.number().min(0).default(2.00),
    customerFrictionCost: z.number().min(0).default(6.00)
  }).optional()
});

export type OnboardingRegisterRequest = z.infer<typeof OnboardingRegisterSchema>;

// Merchant Configuration Update Schema (Zero negative values, safe thresholds)
export const MerchantPolicyUpdateSchema = z.object({
  reviewThreshold: z.number().min(0.1).max(5.0).optional(),
  restrictThreshold: z.number().min(0.2).max(10.0).optional(),
  codPolicyAction: z.enum(['RESTRICT_COD', 'REQUIRE_PREPAYMENT', 'FLAG_ONLY']).optional(),
  fallbackBehavior: z.enum(['ALLOW', 'REVIEW', 'RESTRICT']).optional(),
  networkEnabled: z.boolean().optional(),
  signalRetentionDays: z.number().min(30).max(365).optional()
}).refine(
  data => !data.reviewThreshold || !data.restrictThreshold || data.reviewThreshold < data.restrictThreshold,
  { message: 'reviewThreshold must be strictly less than restrictThreshold' }
);

export type MerchantPolicyUpdateRequest = z.infer<typeof MerchantPolicyUpdateSchema>;

// ==============================================================================
// 5. Explicit Risk Decision Contract & Action Capabilities
// ==============================================================================

export interface RiskDecision {
  decision: RiskDecisionType;
  rawScore: RawRiskScore;
  calibratedProbability: RiskProbability;
  confidence: RiskConfidence;
  reasonCodes: string[];
  policyVersion: string;
  calibrationVersion: string;
  failOpen?: boolean;
}

export interface FailOpenDiagnostic {
  isFailOpen: boolean;
  failureStage?: string;
  failureCode?: string;
  failureReason?: string;
  dependency?: string;
  retryable?: boolean;
  fallbackDecision: RiskDecisionType;
}

// ==============================================================================
// 6. Environment & Worker Bindings -- ZÁMĚRNĚ VYNECHÁNO PŘI MIGRACI
// ==============================================================================
// Originál (~/safeorder-3.0/src/core/types.ts:359-375) definuje `Env`
// interface s Cloudflare Workers bindingy (D1Database, Queue) -- to je
// deployment/infrastruktura kontrakt konkrétního Workeru, ne byznys logika
// risk/economics/calibration domény, kterou tahle migrace řeší. core/ vrstva
// Nexusu navíc nesmí znát konkrétní platformu (stejné pravidlo jako
// core/tenant "Core nesmí obsahovat if ERP === ...") -- `Env` patří do
// connectors/ nebo platform vrstvy, až se bude řešit skutečné nasazení,
// ne do 1:1 kopie legacy typů zde.
