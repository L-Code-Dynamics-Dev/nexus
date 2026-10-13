import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import Decimal from "decimal.js";
import {
  ApiError,
  ConfigurationStore,
  simulate,
  type Catalog,
} from "./service.js";

const shops = {
  "shop-cz": { tenant: "admin_local_cz", label: "Lokální obchod · CZ" },
  "shop-sk": { tenant: "admin_local_sk", label: "Lokální obchod · SK" },
};
const envelope = z
  .object({
    shop: z.string(),
    id: z.string(),
    baseRevision: z.number().int().nonnegative(),
    configuration: z.unknown(),
  })
  .strict();
const sessionTtl = 8 * 60 * 60 * 1000;

export function createAdminServer(options: {
  catalog: Catalog;
  template: string;
  database: string;
}) {
  const store = new ConfigurationStore(options.database, options.catalog);
  const secret = randomBytes(32);
  function sign(payload: string) {
    return createHmac("sha256", secret).update(payload).digest("base64url");
  }
  function issueSession() {
    const payload = Buffer.from(
      JSON.stringify({
        actor: "local-operator",
        shops: Object.keys(shops),
        expires: Date.now() + sessionTtl,
      }),
    ).toString("base64url");
    return payload + "." + sign(payload);
  }
  function authorize(req: IncomingMessage) {
    const cookie = req.headers.cookie
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("nexus_admin="))
      ?.slice("nexus_admin=".length);
    if (!cookie)
      throw new ApiError(
        401,
        "Otevřete administraci pro vytvoření lokální relace.",
      );
    const [payload, signature, extra] = cookie.split(".");
    if (!payload || !signature || extra)
      throw new ApiError(401, "Neplatná relace.");
    const expected = Buffer.from(sign(payload));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
      throw new ApiError(401, "Neplatná relace.");
    const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      actor: string;
      shops: string[];
      expires: number;
    };
    if (data.expires < Date.now())
      throw new ApiError(401, "Lokální relace vypršela. Obnovte stránku.");
    return data;
  }
  async function body(req: IncomingMessage) {
    if (!req.headers["content-type"]?.startsWith("application/json"))
      throw new ApiError(415, "Požadováno application/json.");
    return new Promise<unknown>((resolveBody, rejectBody) => {
      const chunks: Buffer[] = [];
      let length = 0;
      let rejected = false;
      req.on("data", (chunk: Buffer) => {
        if (rejected) return;
        length += chunk.length;
        if (length > 2 * 1024 * 1024) {
          rejected = true;
          chunks.length = 0;
          rejectBody(new ApiError(413, "Požadavek překročil 2 MB."));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (rejected) return;
        try {
          resolveBody(JSON.parse(Buffer.concat(chunks).toString()) as unknown);
        } catch {
          rejectBody(new ApiError(400, "Neplatný JSON."));
        }
      });
      req.on("error", () =>
        rejectBody(new ApiError(400, "Čtení požadavku selhalo.")),
      );
      req.on("aborted", () =>
        rejectBody(new ApiError(400, "Požadavek byl přerušen.")),
      );
    });
  }
  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      const address = server.address();
      const port = address && typeof address !== "string" ? address.port : 0;
      const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
      const origin = `http://${req.headers.host}`;
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Frame-Options", "DENY");
      // Existing editor uses inline handlers; no remote scripts or network destinations are permitted.
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
      const json = (status: number, value: unknown) => {
        res.statusCode = status;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify(value));
      };
      try {
        if (!origins.includes(origin))
          throw new ApiError(403, "Neplatný Host.");
        const url = new URL(req.url || "/", origin);
        if (req.method === "GET" && url.pathname === "/") {
          let valid = true;
          try {
            authorize(req);
          } catch {
            valid = false;
          }
          if (!valid)
            res.setHeader(
              "Set-Cookie",
              `nexus_admin=${issueSession()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionTtl / 1000}`,
            );
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(
            options.template.replace("__CATALOG__", () =>
              JSON.stringify(options.catalog).replace(/</g, "\\u003c"),
            ),
          );
          return;
        }
        if (req.method === "GET" && url.pathname === "/health") {
          json(200, {
            status: "ready",
            workflow: "local-admin",
            productionConnected: false,
          });
          return;
        }
        const session = authorize(req);
        if (
          req.method !== "GET" &&
          (req.headers.origin !== origin ||
            req.headers["sec-fetch-site"] === "cross-site")
        )
          throw new ApiError(
            403,
            "Požadavek musí pocházet z této administrace.",
          );
        const allowedShop = (name: string) => {
          if (!Object.hasOwn(shops, name) || !session.shops.includes(name))
            throw new ApiError(403, "K tomuto obchodu nemáte přístup.");
          return shops[name as keyof typeof shops];
        };
        if (req.method === "GET" && url.pathname === "/api/bootstrap") {
          json(200, {
            actor: session.actor,
            shops: session.shops.map((id) => ({
              id,
              label: allowedShop(id).label,
              configurations: store.list(allowedShop(id).tenant, id),
            })),
            mode: "local-only",
          });
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/history") {
          const name = url.searchParams.get("shop") || "",
            shop = allowedShop(name);
          json(200, { versions: store.history(shop.tenant, name) });
          return;
        }
        if (
          req.method === "POST" &&
          ["/api/config", "/api/validate"].includes(url.pathname)
        ) {
          const result = envelope.safeParse(await body(req));
          if (!result.success)
            throw new ApiError(
              422,
              "Chybí obchod, sada, revize nebo konfigurace.",
            );
          const v = result.data,
            shop = allowedShop(v.shop);
          if (url.pathname === "/api/validate") {
            store.validate(v.id, v.configuration);
            json(200, {
              valid: true,
              scope: "schema-and-basic-invariants",
              consumer: store
                .definition(v.id)
                .source.endsWith("/policy-v1.json")
                ? "nexus-pricing-simulation"
                : "draft-only",
            });
          } else
            json(
              201,
              store.save(
                shop.tenant,
                v.shop,
                v.id,
                v.baseRevision,
                v.configuration,
                session.actor,
              ),
            );
          return;
        }
        if (req.method === "POST" && url.pathname === "/api/simulate/pricing") {
          const result = envelope
            .extend({ input: z.unknown() })
            .safeParse(await body(req));
          if (!result.success)
            throw new ApiError(422, "Neplatný vstup simulace.");
          const v = result.data,
            shop = allowedShop(v.shop),
            d = store.definition(v.id);
          if (!d.source.endsWith("/policy-v1.json"))
            throw new ApiError(422, "Tato sada není cenová politika.");
          store.validate(v.id, v.configuration);
          const baseline = store.latest(shop.tenant, v.shop, v.id);
          if (baseline.revision !== v.baseRevision)
            throw new ApiError(
              409,
              "Pro simulaci načtěte poslední uloženou revizi.",
            );
          const before = simulate(shop.tenant, baseline.configuration, v.input),
            after = simulate(shop.tenant, v.configuration, v.input);
          json(200, {
            backend: "createNexusPricingCalculator",
            baselineRevision: baseline.revision,
            before,
            after,
            delta: new Decimal(after.finalPrice)
              .minus(before.finalPrice)
              .toFixed(2),
            productionConnected: false,
          });
          return;
        }
        throw new ApiError(404, "Endpoint neexistuje.");
      } catch (error) {
        json(error instanceof ApiError ? error.status : 500, {
          error:
            error instanceof ApiError
              ? error.message
              : "Interní chyba administrace.",
        });
      }
    },
  );
  server.on("close", () => store.close());
  return server;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const port = Number(process.env.ADMIN_PORT || 8790);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Neplatný ADMIN_PORT.");
  const directory = resolve(process.env.ADMIN_STATE_DIR || "apps/admin/.state");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const server = createAdminServer({
    catalog: JSON.parse(
      readFileSync("apps/admin/public/catalog.json", "utf8"),
    ) as Catalog,
    template: readFileSync(
      "apps/admin/public/index.template.html",
      "utf8",
    ).replace("__BACKEND_SCRIPT__", () =>
      readFileSync("apps/admin/public/backend.js", "utf8"),
    ),
    database: resolve(directory, "configurations.sqlite"),
  });
  server.listen(port, "127.0.0.1", () =>
    console.log(
      `NEXUS local admin listening on port ${port}; no production integrations.`,
    ),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => server.close());
}
