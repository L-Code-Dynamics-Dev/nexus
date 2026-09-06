// vitest.workers.config.ts -- PRVNÍ Workers testovací config v NEXUSu
// (Fáze A "Voucher Core", 2026-09-06).
//
// PROČ SAMOSTATNÝ CONFIG A NE JEDEN SPOLEČNÝ:
//   Repo do dneška jelo na vitest defaultech (žádný vitest.config.*) a `npm test`
//   sbírá 644 node testů z tests/{unit,integration,regression,...}. Ty běží
//   v Node.js. Workers testy naopak MUSÍ běžet uvnitř workerd (jinak `D1Database`
//   ani `cloudflare:test` neexistují). Míchat obojí do jednoho configu by
//   znamenalo buď projects/workspace přepis defaultů (a riziko, že se ztratí
//   část ze 644 testů), nebo hnát node testy do workerd, kde nemají `fs`.
//   Oddělený soubor je levnější a plně reverzibilní:
//     npm test          -> 644 node testů, defaulty, TENHLE SOUBOR SE NEČTE
//     npm run test:workers -> jen tests/workers/**, uvnitř workerd
//
// API POZNÁMKA (@cloudflare/vitest-plugin 1.1.4):
//   Nový model. `cloudflareTest()` je běžný VITE PLUGIN, ne pool.
//   Starý `defineWorkersConfig` / `pool: "@cloudflare/vitest-pool-workers"`
//   z balíčku `vitest-pool-workers` se ZDE NEPOUŽÍVÁ -- v 1.1.4 neexistuje.
//   `readD1Migrations` je Node-side helper exportovaný z KOŘENE balíčku
//   (exports mapa má jen "." a "./types"; docstring v cloudflare-test.d.ts
//   zmiňuje "@cloudflare/vitest-plugin/config", ale ten subpath v 1.1.4
//   reálně neexistuje -- ověřeno v node_modules/.../package.json).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(rootDir, "migrations");

// Node-side: migrace se načtou JEDNOU při startu poolu a předají se do workerd
// přes `bindings` (structured-serializable). Uvnitř testu je pak aplikuje
// `applyD1Migrations()` z "cloudflare:test" -- viz tests/workers/setup.ts.
// Číst .sql přímo v testu nejde: uvnitř workerd není `node:fs`.
const migrations = await readD1Migrations(migrationsDir);

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Wrangler config se ZÁMĚRNĚ nenačítá přes `wrangler.configPath`.
      // wrangler.jsonc má `main: "workers/api/index.ts"`, což je soubor,
      // který ve Fázi A ještě neexistuje, a `database_id` je placeholder
      // "<vyplnit-po-wrangler-d1-create>". Testy schématu žádný Worker
      // entrypoint nepotřebují -- sahají na `env.DB` přímo.
      // Až Fáze B přidá workers/api/index.ts, dá se sem doplnit
      // `wrangler: { configPath: "./wrangler.jsonc" }` a tenhle blok zmizí.
      miniflare: {
        d1Databases: ["DB"],
        bindings: {
          // Serializovatelný payload -- pole { name, queries[] }.
          TEST_MIGRATIONS: migrations,
        },
      },
    }),
  ],
  test: {
    include: ["tests/workers/**/*.test.ts"],
    setupFiles: ["./tests/workers/setup.ts"],
  },
});
