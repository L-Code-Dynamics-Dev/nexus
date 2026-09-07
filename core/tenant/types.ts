// Tenant Core — základ multi-tenant izolace (master prompt §5: "Tenant izolace
// je kritický bezpečnostní invariant"). Sjednocuje nejzralejší existující vzory:
// SafeOrder migrations/0001 (tenants/tenant_policies/tenant_plans tabulky) +
// AIE src/tenants/configuration.ts (TenantConfig, platform-agnostic core).
//
// Žádný modul v core/ ani domains/ nesmí importovat konkrétní platformu
// (Shoptet/Shopify) přímo — jen přes Tenant.platform jako string klíč do
// Connector Layer (§15: "Core nesmí obsahovat if ERP === ...").

// P0 SJEDNOCENÍ (2026-09-07): typy se REEXPORTUJÍ z kanonického zdroje,
// nedefinují se tady.
//
// Do dneška tu byla vlastní kopie `TenantId` / `EntityId` / `ISODateTime` /
// `CanonicalEntity` s komentářem "dočasně definováno lokálně, než vznikne
// core/canonical/entities/base.ts". Ten soubor mezitím vznikl, ale kopie
// zůstala — takže repo mělo DVĚ definice téhož. Strukturálně byly shodné,
// takže TypeScript nic nehlásil, ale:
//   - autor nového kódu nevěděl, odkud importovat (a agenti sahali střídavě
//     do obou míst),
//   - kdyby se `base.ts` rozšířil (např. o `version` v `AuditableTimestamps`),
//     rozešly by se tiše a chyba by se projevila až za běhu.
//
// Reexport, ne pouhé smazání: `core/tenant/types.ts` je veřejný vstupní bod
// tenant vrstvy a osm souborů z něj importuje. Odstranění by je rozbilo bez
// důvodu — cílem P0 je jeden ZDROJ pravdy, ne přesouvání importů.
export type { TenantId, EntityId, ISODateTime, CanonicalEntity } from '../canonical/entities/base.js';

import type {
    TenantId,
    EntityId,
    ISODateTime,
    CanonicalEntity,
} from '../canonical/entities/base.js';

export type TenantStatus = 'ACTIVE' | 'SUSPENDED' | 'UNINSTALLED';
export type PlanTier = 'STARTER' | 'GROWTH' | 'ENTERPRISE' | 'CUSTOM';

/**
 * Root tenant entity. `platform` + `platformShopId` je unique pair (viz
 * SafeOrder migrations/0001 UNIQUE constraint) — jeden Shoptet/Shopify shop
 * = jeden tenant, nikdy naopak.
 */
export interface Tenant extends CanonicalEntity {
    id: TenantId;
    platform: string;
    platformShopId: string;
    status: TenantStatus;
}

/**
 * Konfigurace integrace pro daného tenanta — přenáší AIE `TenantConfig`
 * koncept (§15: core neví, jestli je to Shoptet CSV export nebo REST API,
 * ví jen "api" nebo "import").
 */
export interface TenantIntegrationConfig {
    tenantId: TenantId;
    integrationMode: 'api' | 'import';
    enabled: boolean;
}

/**
 * Plán/limity SaaS tenanta (§5, §14 billing vazba). Vychází ze SafeOrder
 * migrations/0008_saas_onboarding_plans_and_lifecycle.sql `tenant_plans`
 * tabulky (ověřeno přímo v SQL, ne jen podle MIGRATION_PLAN.md popisu) --
 * jediný zdrojový systém, který měl plán tiers hotové.
 */
export interface TenantPlan {
    tenantId: TenantId;
    planTier: PlanTier;
    monthlyEvaluationLimit: number;
    monthlyEvaluationsUsed: number;
    historyRetentionDays: number;
    networkAccessAllowed: boolean;
    customRulesAllowed: boolean;
    status: 'ACTIVE' | 'GRACE_PERIOD' | 'SUSPENDED' | 'CANCELED';
    billingPeriodStart: ISODateTime;
    billingPeriodEnd: ISODateTime;
}

/**
 * Bezpečnostní/risk politika tenanta -- SafeOrder migrations/0001_initial_schema.sql
 * `tenant_policies` tabulka (ověřeno v SQL, ne domněnka). SafeOrder je jediný
 * zdrojový systém s per-tenant konfigurovatelnou risk politikou -- Nexus
 * ji přebírá jako obecný vzor pro "tenant-owned business threshold
 * konfigurace", ne jen pro SafeOrder doménu samotnou.
 */
export interface TenantPolicy {
    tenantId: TenantId;
    policyVersion: string;
    reviewThreshold: number;
    restrictThreshold: number;
    signalRetentionDays: number;
    codPolicyAction: 'RESTRICT_COD' | 'REQUIRE_PREPAYMENT' | 'FLAG_ONLY';
    networkEnabled: boolean;
    networkOptedInAt?: ISODateTime;
}

/**
 * Verzovaná historie změn `TenantPolicy` -- SafeOrder migrations/0008
 * `tenant_policy_history` tabulka. Append-only audit trail (viz
 * core/audit/AuditRecord.ts pro obecný append-only vzor) -- KAŽDÁ změna
 * policy musí zůstat dohledatelná, ne jen aktuální hodnota.
 */
export interface TenantPolicyHistoryEntry {
    id: EntityId;
    tenantId: TenantId;
    policyVersion: string;
    configurationDiff: Record<string, unknown>;
    updatedBy: string;
    createdAt: ISODateTime;
}

/**
 * Tenant-scoped náhrada za hardcoded `TIER_PRICELIST_MAP` (legacy Pricing
 * Engine, viz core/canonical/entities/Price.ts komentář + Confirmed
 * Conflict #3 v CANONICAL-MODEL-CONTRACT.md §6). `tierKey` odpovídá
 * `PriceList.tenantScopedTierKey` -- tahle mapa říká, na jaké EXTERNÍ
 * (Shoptet) pricelist ID se daný tenant-specific tier klíč má napojit.
 * Dva tenanti mohou mít pro stejný `tierKey` (např. "ZR20") jiné
 * `externalPricelistId`, protože jde o jejich vlastní Shoptet konfiguraci.
 */
export interface TenantScopedTierConfig {
    tenantId: TenantId;
    /** tierKey -> externí (Shoptet) pricelist ID. */
    tierToExternalPricelistId: Record<string, string>;
}

/**
 * Kontext, který se musí protáhnout skrz KAŽDÉ volání core/domains modulu.
 * Nikdy nesmí být odvozen z klientského vstupu (SafeOrder "Zero Trust"
 * princip — klient nikdy nerozhoduje o identitě/tenantu).
 */
export interface TenantContext {
    readonly tenantId: TenantId;
    readonly platform: string;
}

/**
 * Guard proti návratu hardcoded tenanta (P0 rozhodnutí 2026-09-07:
 * "Pricing musí dostávat TenantContext zvenku. Nikdy
 * `const ctx = { tenantId: 'ten_1' }`").
 *
 * PROČ ASSERT A NE BRANDED TYPE: zvažován byl i `TenantId` jako branded
 * type (`string & { readonly __brand: 'TenantId' }`), který by hodnotu
 * z holého stringu nedovolil vyrobit bez explicitní konverze. Zamítnuto:
 * `TenantId` je reexportován z `core/canonical/entities/base.ts` a nese ho
 * `CanonicalEntity`, tedy KAŽDÁ entita v modelu plus všechny fixtures
 * a testovací data. Brandování by znamenalo dotknout se stovek míst včetně
 * 754 zelených testů -- to je přesně ten druh plošné změny, kterou
 * Non-Interference zakazuje na stabilním kódu, a chybu by to odhalilo jen
 * tam, kde by autor konverzi nenapsal (a on ji napíše, protože ho na to
 * compiler upozorní).
 *
 * Runtime assert chytá skutečný failure mode, který nás pálí: kontext
 * vyrobený uvnitř modulu z konstanty nebo z prázdné/placeholder hodnoty.
 * Ve spojení s POVINNÝM `TenantContext` parametrem v signatuře (volající
 * ho MUSÍ dodat, compile-time) pokrývá obojí -- statickou i běhovou stranu.
 *
 * Odmítá i známé placeholder hodnoty: kdyby někdo hardcoded tenanta jen
 * přesunul o patro výš, spadne to tady, ne až v produkci na promíchaných
 * cenách mezi e-shopy.
 */
const PLACEHOLDER_TENANT_IDS: readonly string[] = [
    'ten_1', 'tenant', 'tenant_1', 'test', 'default', 'todo', 'changeme', 'unknown',
];

export function assertTenantContext(
    context: TenantContext | null | undefined,
    callSite: string
): asserts context is TenantContext {
    if (context === null || context === undefined) {
        throw new TypeError(
            `${callSite}: TenantContext is required and must be passed in from the caller. ` +
            `Never construct it inline (e.g. \`{ tenantId: 'ten_1' }\`) -- tenant isolation ` +
            `is a security invariant (CANONICAL-MODEL-CONTRACT.md §5).`
        );
    }

    const { tenantId, platform } = context;

    if (typeof tenantId !== 'string' || tenantId.trim() === '') {
        throw new TypeError(
            `${callSite}: TenantContext.tenantId must be a non-empty string, got ${JSON.stringify(tenantId)}.`
        );
    }

    if (typeof platform !== 'string' || platform.trim() === '') {
        throw new TypeError(
            `${callSite}: TenantContext.platform must be a non-empty string, got ${JSON.stringify(platform)}.`
        );
    }

    if (PLACEHOLDER_TENANT_IDS.includes(tenantId.trim().toLowerCase())) {
        throw new TypeError(
            `${callSite}: TenantContext.tenantId "${tenantId}" is a hardcoded placeholder. ` +
            `Resolve the real tenant from the request/installation context instead -- ` +
            `a placeholder tenant in a multi-tenant deployment mixes data between e-shops.`
        );
    }
}

/** Porušení tenant izolace je bezpečnostní incident, ne běžná chyba. */
export class TenantIsolationViolation extends Error {
    constructor(
        public readonly expectedTenantId: TenantId,
        public readonly actualTenantId: TenantId,
        public readonly entity: string,
        public readonly entityId: EntityId
    ) {
        super(
            `Tenant isolation violation: expected tenant ${expectedTenantId}, ` +
            `got ${actualTenantId} for ${entity}#${entityId}`
        );
        this.name = 'TenantIsolationViolation';
    }
}

/**
 * Vynucuje, že entita skutečně patří danému tenantovi, PŘED jakoukoli
 * mutací. Přímá reakce na nalezenou bezpečnostní mezeru v AIE audit
 * (`PostgresProcurementRepository.updateLineQuantity()` nefiltrovalo
 * WHERE přes tenant_id) — v NEXUS musí tahle kontrola být explicitní
 * a nezapomenutelná, ne implicitní v SQL WHERE klauzuli, kterou lze
 * omylem vynechat.
 */
export function assertTenantOwnership(
    context: TenantContext,
    entity: { tenantId: TenantId },
    entityName: string,
    entityId: EntityId
): void {
    if (entity.tenantId !== context.tenantId) {
        throw new TenantIsolationViolation(context.tenantId, entity.tenantId, entityName, entityId);
    }
}
