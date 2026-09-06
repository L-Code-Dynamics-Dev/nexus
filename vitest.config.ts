// vitest.config.ts -- root config pro NODE testy (`npm test`).
//
// VZNIKL POUZE Z JEDNOHO DŮVODU a záměrně nedělá nic víc:
//   Vitest bez configu sbírá `**/*.test.ts` z celého repa. Od zavedení
//   tests/workers/ (Workers/D1 testy, Fáze A voucheru) to znamená, že
//   `npm test` chytí i tests/workers/schema.test.ts a spadne na
//   `Cannot find package 'cloudflare:test'` -- ten modul existuje jen uvnitř
//   workerd, ne v Node.js.
//
// Config proto NEPŘEPISUJE nic z defaultů kromě jediné výjimky: vyřazuje
// tests/workers/ z node běhu. Ty se pouštějí odděleně:
//   npm test            -> node testy, tenhle config
//   npm run test:workers -> tests/workers/**, vitest.workers.config.ts
//
// `exclude` musí zopakovat i defaultní vzory -- vitest je při zadání
// vlastního `exclude` NEDĚDÍ, a bez nich by se testy hledaly i v node_modules.
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "tests/workers/**"],
  },
});
