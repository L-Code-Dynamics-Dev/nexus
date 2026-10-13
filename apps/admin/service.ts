import { DatabaseSync } from "node:sqlite";
import Decimal from "decimal.js";
import { z } from "zod";
import { createNexusPricingCalculator } from "../../domains/pricing/createNexusPricingCalculator.js";
import { InMemoryPricingConfigurationProvider } from "../../domains/pricing/PricingConfigurationProvider.js";

export interface Definition {
  id: string;
  label: string;
  source: string;
  status: string;
  value: unknown;
}
export interface Catalog {
  engines: {
    id: string;
    label: string;
    documents: Definition[];
    rules: { name: string; source: string }[];
  }[];
}
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const ratioMap = z.record(z.string().min(1), z.number().finite().min(0).max(1));
const pricePolicy = z
  .object({
    version: z.string().optional(),
    description: z.string().optional(),
    loyaltyTiers: ratioMap.refine(
      (v) => Object.keys(v).length > 0,
      "Alespoň jedna věrnostní úroveň je povinná.",
    ),
    brandLimits: ratioMap.optional(),
    categoryLimits: ratioMap.optional(),
    brandSaleDiscounts: ratioMap.optional(),
  })
  .strict();
const riskPolicy = z
  .object({
    reviewThreshold: z.number().min(0.1).max(5),
    restrictThreshold: z.number().min(0.2).max(10),
    signalRetentionDays: z.number().min(30).max(365),
    codPolicyAction: z.enum([
      "RESTRICT_COD",
      "REQUIRE_PREPAYMENT",
      "FLAG_ONLY",
    ]),
    fallbackBehavior: z.enum(["ALLOW", "REVIEW", "RESTRICT"]),
    networkEnabled: z.boolean(),
  })
  .strict()
  .refine(
    (v) => v.reviewThreshold < v.restrictThreshold,
    "Práh kontroly musí být nižší než práh omezení.",
  );
const clause = z
  .object({
    attribute: z.string().trim().min(1),
    operator: z.enum([
      "EQ",
      "NEQ",
      "GT",
      "GTE",
      "LT",
      "LTE",
      "IN",
      "NOT_IN",
      "CONTAINS",
    ]),
    value: z.unknown(),
  })
  .strict();
const ruleSchema = z
  .object({
    enabled: z.boolean(),
    priority: z.number().int().nullable(),
    clauses: z.array(clause),
    exceptions: z.array(clause),
    parameters: z.record(z.string(), z.unknown()),
  })
  .strict();

export function validateJson(value: unknown, depth = 0): void {
  if (depth > 35) throw new ApiError(422, "Konfigurace je příliš hluboká.");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    const ids = new Set<string>();
    for (const item of value) {
      if (item && typeof item === "object" && typeof item.id === "string") {
        if (ids.has(item.id))
          throw new ApiError(422, `Duplicitní id: ${item.id}`);
        ids.add(item.id);
      }
      validateJson(item, depth + 1);
    }
    return;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (
      typeof object.pctMin === "number" &&
      typeof object.pctMax === "number" &&
      object.pctMin > object.pctMax
    )
      throw new ApiError(422, "Minimum dávky nesmí překročit maximum.");
    if (
      object.portions !== undefined &&
      (typeof object.portions !== "number" ||
        !Number.isInteger(object.portions) ||
        object.portions < 1)
    )
      throw new ApiError(422, "Počet porcí musí být kladné celé číslo.");
    if (
      Array.isArray(object.allowedPeriodDays) &&
      typeof object.defaultPeriodDays === "number" &&
      !object.allowedPeriodDays.includes(object.defaultPeriodDays)
    )
      throw new ApiError(422, "Výchozí období není mezi povolenými.");
    for (const [key, child] of Object.entries(object)) {
      if (["__proto__", "prototype", "constructor"].includes(key))
        throw new ApiError(422, "Zakázaný klíč konfigurace.");
      validateJson(child, depth + 1);
    }
    return;
  }
  throw new ApiError(422, "Konfigurace musí obsahovat platné JSON hodnoty.");
}
export function changes(
  before: unknown,
  after: unknown,
  path = "",
): { path: string; before: unknown; after: unknown }[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (
    before &&
    after &&
    typeof before === "object" &&
    typeof after === "object"
  ) {
    const a = before as Record<string, unknown>,
      b = after as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) =>
      changes(a[k], b[k], path ? `${path}.${k}` : k),
    );
  }
  return [{ path, before: before ?? null, after: after ?? null }];
}

export class ConfigurationStore {
  private db: DatabaseSync;
  private definitions = new Map<string, Definition>();
  constructor(filename: string, catalog: Catalog) {
    this.db = new DatabaseSync(filename);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS versions (tenant TEXT NOT NULL, shop TEXT NOT NULL, document TEXT NOT NULL, revision INTEGER NOT NULL, configuration TEXT NOT NULL, author TEXT NOT NULL, created_at TEXT NOT NULL, diff TEXT NOT NULL, PRIMARY KEY(tenant,shop,document,revision));",
    );
    for (const engine of catalog.engines) {
      for (const d of engine.documents) this.definitions.set(d.id, d);
      for (const r of engine.rules)
        this.definitions.set("rule:" + r.source, {
          id: "rule:" + r.source,
          label: r.name,
          source: r.source,
          status: "contract",
          value: {
            enabled: true,
            priority: null,
            clauses: [],
            exceptions: [],
            parameters: {},
          },
        });
    }
  }
  definition(id: string): Definition {
    const d = this.definitions.get(id);
    if (!d) throw new ApiError(404, "Neznámá sada pravidel.");
    return d;
  }
  validate(id: string, value: unknown): void {
    const d = this.definition(id);
    validateJson(value);
    if (!value || typeof value !== "object")
      throw new ApiError(422, "Kořen konfigurace musí být objekt nebo pole.");
    const schema = id.startsWith("rule:")
      ? ruleSchema
      : d.source.endsWith("/policy-v1.json")
        ? pricePolicy
        : d.status === "api" && id.startsWith("safeorder-")
          ? riskPolicy
          : null;
    if (schema) {
      const result = schema.safeParse(value);
      if (!result.success)
        throw new ApiError(
          422,
          result.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        );
    }
    if (d.source.endsWith("/coupon-policy.json")) {
      const result = z
        .object({
          mode: z.enum(["fixed-amount", "percent-ceiling"]),
          defaultMaxDiscount: z.number().min(0).max(100),
          lockedTiers: z.array(z.string()),
          disabledBrands: z.array(z.string()),
          disabledProducts: z.array(z.string()),
        })
        .strict()
        .safeParse(value);
      if (!result.success)
        throw new ApiError(422, "Neplatná kupónová konfigurace.");
    }
  }
  latest(tenant: string, shop: string, id: string) {
    const d = this.definition(id);
    const row = this.db
      .prepare(
        "SELECT revision,configuration FROM versions WHERE tenant=? AND shop=? AND document=? ORDER BY revision DESC LIMIT 1",
      )
      .get(tenant, shop, id) as
      { revision: number; configuration: string } | undefined;
    return row
      ? {
          revision: row.revision,
          configuration: JSON.parse(row.configuration) as unknown,
        }
      : { revision: 0, configuration: d.value };
  }
  save(
    tenant: string,
    shop: string,
    id: string,
    baseRevision: number,
    value: unknown,
    author: string,
  ) {
    this.validate(id, value);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const latest = this.latest(tenant, shop, id);
      if (latest.revision !== baseRevision)
        throw new ApiError(
          409,
          "Nastavení mezitím změnil jiný editor. Načtěte poslední verzi; vlastní návrh zůstává zachovaný.",
        );
      const diff = changes(latest.configuration, value);
      if (!diff.length) throw new ApiError(422, "Žádné změny k uložení.");
      const revision = latest.revision + 1;
      const createdAt = new Date().toISOString();
      this.db
        .prepare("INSERT INTO versions VALUES(?,?,?,?,?,?,?,?)")
        .run(
          tenant,
          shop,
          id,
          revision,
          JSON.stringify(value),
          author,
          createdAt,
          JSON.stringify(diff),
        );
      this.db.exec("COMMIT");
      return {
        revision,
        configuration: value,
        createdAt,
        diff,
        status: "saved-draft",
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  history(tenant: string, shop: string) {
    return (
      this.db
        .prepare(
          "SELECT document,revision,configuration,author,created_at,diff FROM versions WHERE tenant=? AND shop=? ORDER BY rowid DESC LIMIT 100",
        )
        .all(tenant, shop) as {
        document: string;
        revision: number;
        configuration: string;
        author: string;
        created_at: string;
        diff: string;
      }[]
    ).map((r) => ({
      ...r,
      label: this.definitions.get(r.document)?.label || r.document,
      configuration: JSON.parse(r.configuration) as unknown,
      diff: JSON.parse(r.diff) as unknown,
    }));
  }
  list(tenant: string, shop: string) {
    return [...this.definitions.keys()].map((id) => ({
      id,
      ...this.latest(tenant, shop, id),
    }));
  }
  close() {
    this.db.close();
  }
}

const money = z
  .string()
  .regex(
    /^\d{1,15}(\.\d{1,6})?$/,
    "Použijte nezápornou cenu jako desetinný řetězec.",
  );
const simulationInput = z
  .object({
    sku: z.string().min(1).max(100),
    basePrice: money,
    salePrice: money.optional(),
    customerTier: z.string().min(1).optional(),
    allowLoyaltyDiscount: z.boolean().optional(),
    productMaxDiscount: z.number().min(0).max(1).optional(),
    manufacturer: z.string().max(200).optional(),
    category: z.string().max(200).optional(),
  })
  .strict();
export function simulate(tenant: string, policy: unknown, input: unknown) {
  const parsed = pricePolicy.safeParse(policy),
    data = simulationInput.safeParse(input);
  if (!parsed.success || !data.success)
    throw new ApiError(422, "Neplatná cenová politika nebo testovací produkt.");
  const calculate = createNexusPricingCalculator(
    new InMemoryPricingConfigurationProvider(parsed.data),
    { tenantId: tenant, platform: "local-admin" },
  );
  try {
    const v = data.data;
    const result = calculate({
      ...v,
      basePrice: new Decimal(v.basePrice),
      salePrice:
        v.salePrice === undefined ? undefined : new Decimal(v.salePrice),
      productMaxDiscount:
        v.productMaxDiscount === undefined
          ? undefined
          : new Decimal(v.productMaxDiscount),
    });
    if (!result.finalPrice.isFinite() || result.finalPrice.isNegative())
      throw new Error("Výsledná cena není platná.");
    return {
      finalPrice: result.finalPrice.toFixed(2),
      appliedRules: result.appliedRules,
      rejected: result.rejected,
      rejectReason: result.rejectReason,
    };
  } catch (error) {
    throw new ApiError(422, (error as Error).message);
  }
}
