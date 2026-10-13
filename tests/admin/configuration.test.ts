import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createAdminServer } from "../../apps/admin/server.js";
import {
  ConfigurationStore,
  simulate,
  type Catalog,
} from "../../apps/admin/service.js";

const catalog: Catalog = {
  engines: [
    {
      id: "pricing",
      label: "Pricing",
      documents: [
        {
          id: "pricing-policy",
          label: "Policy",
          source: "nexus/policy-v1.json",
          status: "data",
          value: {
            loyaltyTiers: { CLUB: 0.1 },
            brandLimits: {},
            categoryLimits: {},
          },
        },
      ],
      rules: [],
    },
  ],
};
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function database() {
  const d = mkdtempSync(join(tmpdir(), "nexus-admin-"));
  dirs.push(d);
  return join(d, "config.sqlite");
}

describe("server configurations and actual pricing engine", () => {
  it("retains revisions and audit across restart while isolating shops and tenants", () => {
    const filename = database();
    let store = new ConfigurationStore(filename, catalog);
    store.save(
      "tenant-a",
      "shop-cz",
      "pricing-policy",
      0,
      { loyaltyTiers: { CLUB: 0.2 } },
      "operator-a",
    );
    expect(store.latest("tenant-a", "shop-sk", "pricing-policy").revision).toBe(
      0,
    );
    expect(store.latest("tenant-b", "shop-cz", "pricing-policy").revision).toBe(
      0,
    );
    store.close();
    store = new ConfigurationStore(filename, catalog);
    expect(store.latest("tenant-a", "shop-cz", "pricing-policy")).toEqual({
      revision: 1,
      configuration: { loyaltyTiers: { CLUB: 0.2 } },
    });
    expect(store.history("tenant-a", "shop-cz")[0]?.author).toBe("operator-a");
    expect(() =>
      store.save(
        "tenant-a",
        "shop-cz",
        "pricing-policy",
        0,
        { loyaltyTiers: { CLUB: 0.3 } },
        "operator-b",
      ),
    ).toThrow("mezitím");
    expect(store.history("tenant-a", "shop-cz")).toHaveLength(1);
    store.close();
  });
  it("rejects invalid policy, unknown fields and prototype pollution before persistence", () => {
    const store = new ConfigurationStore(database(), catalog);
    for (const value of [
      { loyaltyTiers: { CLUB: 1.1 } },
      { loyaltyTiers: {} },
      { loyaltyTiers: { CLUB: 0.2 }, unconsumedSetting: true },
      JSON.parse('{"loyaltyTiers":{"CLUB":0.2},"__proto__":{"polluted":true}}'),
    ]) {
      expect(() =>
        store.save(
          "tenant-a",
          "shop-cz",
          "pricing-policy",
          0,
          value,
          "operator",
        ),
      ).toThrow();
    }
    expect(store.history("tenant-a", "shop-cz")).toHaveLength(0);
    store.close();
  });
  it("a changed tier changes the price through Nexus and reports its actual trace", () => {
    const input = {
      sku: "A",
      basePrice: "100",
      customerTier: "CLUB",
      allowLoyaltyDiscount: true,
    };
    expect(
      simulate("tenant-a", { loyaltyTiers: { CLUB: 0.1 } }, input).finalPrice,
    ).toBe("90.00");
    const after = simulate("tenant-a", { loyaltyTiers: { CLUB: 0.2 } }, input);
    expect(after.finalPrice).toBe("80.00");
    expect(after.appliedRules.map((r) => r.rule)).toContain("LOYALTY");
    expect(
      simulate(
        "tenant-a",
        { loyaltyTiers: { CLUB: 0.2 }, brandSaleDiscounts: { BRAND: 0.3 } },
        { ...input, manufacturer: "BRAND" },
      ).finalPrice,
    ).toBe("70.00");
  });
  it("rejects negative, unsupported or unknown-tier simulation inputs", () => {
    const policy = { loyaltyTiers: { CLUB: 0.1 } };
    expect(() =>
      simulate("tenant-a", policy, { sku: "A", basePrice: "-1" }),
    ).toThrow();
    expect(() =>
      simulate("tenant-a", policy, {
        sku: "A",
        basePrice: "100",
        customerTier: "UNKNOWN",
      }),
    ).toThrow("Unknown customerTier");
    expect(() =>
      simulate("tenant-a", policy, {
        sku: "A",
        basePrice: "100",
        overridePrice: "0",
      }),
    ).toThrow();
  });
});

describe("local HTTP authorization and API", () => {
  async function fixture() {
    const server = createAdminServer({
      catalog,
      template: "<html>__CATALOG__</html>",
      database: database(),
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const root = await fetch(url);
    const cookie = root.headers.get("set-cookie")!.split(";")[0]!;
    const post = (
      path: string,
      data: unknown,
      extra: Record<string, string> = {},
    ) =>
      fetch(url + path, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: url,
          "Content-Type": "application/json",
          ...extra,
        },
        body: JSON.stringify(data),
      });
    return {
      server,
      url,
      cookie,
      post,
      close: () =>
        new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))),
    };
  }
  it("requires a signed session and rejects unauthorized shops and cross-origin changes", async () => {
    const f = await fixture();
    try {
      expect((await fetch(f.url + "/api/bootstrap")).status).toBe(401);
      expect(
        (
          await fetch(f.url + "/api/bootstrap", {
            headers: { Cookie: "nexus_admin=forged.invalid" },
          })
        ).status,
      ).toBe(401);
      const data = {
        shop: "shop-cz",
        id: "pricing-policy",
        baseRevision: 0,
        configuration: { loyaltyTiers: { CLUB: 0.2 } },
      };
      expect(
        (
          await f.post("/api/config", data, {
            Origin: "https://untrusted.example",
          })
        ).status,
      ).toBe(403);
      expect(
        (await f.post("/api/config", { ...data, shop: "not-authorized" }))
          .status,
      ).toBe(403);
      expect((await f.post("/api/config", data)).status).toBe(201);
    } finally {
      await f.close();
    }
  });
  it("rejects malformed JSON, oversized requests and client-supplied tenancy", async () => {
    const f = await fixture();
    try {
      const headers = {
        Cookie: f.cookie,
        Origin: f.url,
        "Content-Type": "application/json",
      };
      expect(
        (
          await fetch(f.url + "/api/config", {
            method: "POST",
            headers,
            body: "{",
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await fetch(f.url + "/api/config", {
            method: "POST",
            headers,
            body: JSON.stringify({ padding: "x".repeat(2 * 1024 * 1024) }),
          })
        ).status,
      ).toBe(413);
      expect(
        (
          await f.post("/api/config", {
            shop: "shop-cz",
            id: "pricing-policy",
            baseRevision: 0,
            configuration: { loyaltyTiers: { CLUB: 0.2 } },
            tenant: "other-tenant",
          })
        ).status,
      ).toBe(422);
      expect(
        (
          await f.post("/api/config", {
            shop: "shop-cz",
            id: "unknown",
            baseRevision: 0,
            configuration: {},
          })
        ).status,
      ).toBe(404);
    } finally {
      await f.close();
    }
  });
  it("rejects stale revisions, simulates before saving and returns persisted state after saving", async () => {
    const f = await fixture();
    try {
      const data = {
        shop: "shop-cz",
        id: "pricing-policy",
        baseRevision: 0,
        configuration: { loyaltyTiers: { CLUB: 0.2 } },
      };
      const simulated = await f.post("/api/simulate/pricing", {
        ...data,
        input: {
          sku: "A",
          basePrice: "100",
          customerTier: "CLUB",
          allowLoyaltyDiscount: true,
        },
      });
      expect(simulated.status).toBe(200);
      const result = await simulated.json();
      expect(result.before.finalPrice).toBe("90.00");
      expect(result.after.finalPrice).toBe("80.00");
      expect(result.delta).toBe("-10.00");
      expect((await f.post("/api/config", data)).status).toBe(201);
      expect(
        (
          await f.post("/api/config", {
            ...data,
            configuration: { loyaltyTiers: { CLUB: 0.3 } },
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await f.post("/api/simulate/pricing", {
            ...data,
            input: { sku: "A", basePrice: "100" },
          })
        ).status,
      ).toBe(409);
      const boot = await (
        await fetch(f.url + "/api/bootstrap", { headers: { Cookie: f.cookie } })
      ).json();
      expect(boot.shops[0].configurations[0].revision).toBe(1);
      expect(boot.shops[1].configurations[0].revision).toBe(0);
      const audit = await (
        await fetch(f.url + "/api/history?shop=shop-cz", {
          headers: { Cookie: f.cookie },
        })
      ).json();
      expect(audit.versions).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
});
