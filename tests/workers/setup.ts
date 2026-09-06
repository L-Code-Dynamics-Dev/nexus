// tests/workers/setup.ts -- setupFile pro Workers testy (běží UVNITŘ workerd).
//
// Aplikuje D1 migrace z migrations/ do izolované testovací databáze dřív, než
// se pustí jakýkoli test. Migrace samotné se čtou z disku v Node.js
// (readD1Migrations ve vitest.workers.config.ts) a sem dorazí jako binding
// TEST_MIGRATIONS -- uvnitř workerd `node:fs` neexistuje, jinak by to nešlo.
//
// applyD1Migrations() je idempotentní: eviduje aplikované migrace v tabulce
// `d1_migrations`, takže opakované spuštění nic neduplikuje.
import type { D1Migration } from "cloudflare:test";
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";

// V 1.1.4 je `env` typované jako globální `Cloudflare.Env` (styl
// `wrangler types`), NE přes staré `ProvidedEnv` z vitest-pool-workers.
// Deklarace je tady, protože repo zatím žádný vygenerovaný worker-configuration.d.ts
// nemá -- až ho `wrangler types` vygeneruje, tenhle blok se smaže.
declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      /** Migrace načtené v Node.js a předané do workerd jako binding. */
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
