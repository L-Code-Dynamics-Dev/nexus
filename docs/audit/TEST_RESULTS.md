# Test and verification results

**Date:** 2026-10-09
**Base commit:** `200dbf4d718931d0d227ecf25a5b1468bbef175f` (`L-Code-Dynamics-Dev/nexus`, `main`)
**Audit changes:** working branch based on that commit; exact commit recorded in final after commit.
**Environment:** macOS 12.6.0, Node/npm from local toolchain. No production credentials or remote writes used.

## Commands run

| Command | Result |
|---|---|
| `npm ci` | PASS — clean lockfile install after updates; 0 vulnerabilities. |
| `npm run build` | PASS — root TypeScript `tsc --noEmit`. |
| `npx tsc --noEmit -p tests/workers/tsconfig.json` | PASS. |
| `npm test` after boundary fixes and dependency updates | PASS — 77 files, 1014 tests. |
| `npx vitest run tests/unit/WorkerBoundary.test.ts` | PASS — 5 focused tests. |
| `npm run test:workers` | BLOCKED — workerd refuses this machine's macOS 12.6.0; requires macOS 13.5+ or supported Linux. No worker tests ran. |
| `npx wrangler deploy --dry-run --env production` | PASS — bundle 127.95 KiB (34.64 KiB gzip); resolves Worker, DO and D1 bindings. Dry-run only, no deployment. |
| `npm audit --omit=dev` after upgrade | PASS — 0 production dependency advisories. |
| `npm audit` after upgrades | PASS — 0 advisories across the full dependency graph; added CI audit gate. |
| Lint | NOT AVAILABLE — no lint script or lint configuration in root package. |
| PostgreSQL/Medusa migration, catalog, order/payment E2E | NOT RUN — Medusa/PostgreSQL backend is absent. |

## Dependency changes

Updated `csv-parse` from 5.5.6 to 7.0.3 (major update required to resolve the production dependency advisory), and updated `@cloudflare/vitest-plugin` to 1.4.0, `@cloudflare/workers-types` to 5.20261009.1, `vitest` to 4.1.11 and `wrangler` to 4.149.0. A first update attempt was correctly rejected by npm because Wrangler 4.149 requires newer Workers types; the compatible set was then installed together. Build, full Node tests, Worker TypeScript check, dry-run and full npm audit all passed afterward.

## Limitations and reproducibility

- Reproduce Node/type/dependency checks with commands above after `npm ci`.
- Run `npm run test:workers` on CI's Ubuntu worker or macOS 13.5+ to verify actual workerd and D1 behavior after these changes.
- `wrangler deploy --dry-run` proves bundling/config parsing only. Placeholder D1 identifiers mean this is not evidence that an actual production environment is configured.
- GitHub Actions for base commit `200dbf4` reports Success: Node and Workers/D1 jobs both passed (run triggered 2026-09-24). That result applies only to the base commit, not this audit branch.
- No PostgreSQL migration/restore, authenticated storefront API, or payment acceptance test exists at this baseline.
