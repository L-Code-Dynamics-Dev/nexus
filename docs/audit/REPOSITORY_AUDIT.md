# Repository audit

**Date:** 2026-10-09
**Audited commit:** `200dbf4d718931d0d227ecf25a5b1468bbef175f` (requested upstream `L-Code-Dynamics-Dev/nexus`, branch `main`)
**Auditor workspace:** detached, isolated worktree; local user worktree was not modified.
**Evidence:** commands and results are in [TEST_RESULTS.md](TEST_RESULTS.md).

## Verdict

The target repository is a TypeScript domain library plus a Cloudflare Worker focused on digital vouchers. It is **not** a functioning Medusa commerce backend or ANASTASIA customer platform. No PostgreSQL/Medusa app, storefront, customer identity, customer library, checkout, order/payment workflow, booking API, or protected media delivery was found at this commit.

The target GitHub repository differs from the existing local checkout's configured remote and branch. The requested public target is `L-Code-Dynamics-Dev/nexus`; local `/Users/lucky/nexus` is on `master` with remote `hlancaric-ship-it/nexus` and contains uncommitted changes. Those changes were preserved and are not represented by this audit commit.

## Inventory

- 414 tracked files; one root `package.json`; directories `core/`, `domains/`, `connectors/`, `workers/api/`, `migrations/`, `tests/`, `tools/`, `docs/`.
- Runtime: one Cloudflare Worker, `workers/api/index.ts`; routes cover voucher validate/redeem, issuance (now removed from public router), and forwarded Shoptet webhook.
- Persistence: four D1 migrations, voucher and execution-intent domain persistence. No PostgreSQL config or Medusa migrations.
- CI: one workflow, `.github/workflows/test.yml`, with Node and workerd jobs. No lint, dependency audit, deployment validation, or end-to-end commerce workflow.
- No storefront/app or Medusa package exists. `ui/` is not tracked as an application.
- `STATUS.md` and `STATUS-ANASTASIA-PLAN.md` are absent. `README.md` and `PROGRESS_LOG.md` contain dated historical claims and are not a reliable current status source without commit matching.
- Public site review is limited to publicly reachable pages: [anastasiaoz.eu](https://anastasiaoz.eu/). Its public page shows a cookie consent layer and commerce navigation; that does not establish the state of its database, checkout, accounts, or payment integrations. The other listed domains and sitemap/robots endpoints could not be inspected with the available browser access.

## Architecture and security findings

1. **CORS default was unsafe.** `workers/api/http.ts` previously returned `Access-Control-Allow-Origin: *` when no allowlist was configured and accepted a wildcard entry. Changed to fail closed; only exact configured origins are allowed.
2. **Unauthenticated issuance route was publicly routable.** `/api/vouchers/issue` accepted client-supplied paid order attributes and was not called by the signed webhook path. Removed it from the public router. The route implementation remains private code for a future authenticated integration; the current webhook's steps 2–4 are explicitly incomplete in `workers/api/routes/shoptetWebhook.ts`.
3. **Webhook boundary:** Shoptet webhook checks the forwarding token and HMAC signature over the raw body before parsing. Processing is scheduled with `waitUntil`; no order fetch/issuance is currently completed. No independent replay/idempotency test of the Shoptet event itself was established.
4. **Voucher redemption:** HMAC-signed amount/cart token, short TTL, Durable Object nonce reservation, D1 optimistic balance update and uniqueness constraints are implemented. Worker runtime behavior is not locally verified on this OS; see test results.
5. **Rate limiting:** Durable Object rate windows are held in memory and are lost on object eviction/restart (`SecurityCoordinator.ts`). This weakens brute-force throttling; it is not durable enforcement. Keep Cloudflare edge rate limiting or persistent counters as a P1 before financial production.
6. **Tenant isolation:** voucher reads and writes include tenant keys and test suite includes tenant isolation. However issuance trusts request tenant/order fields and has no current authenticated server-side order lookup because direct issuance is now unreachable. Shared commerce/customer tenant model is absent.
7. **Configuration:** `wrangler.jsonc` contains placeholder D1 IDs in dev and production, no explicit `ALLOWED_ORIGINS`, and comments require secrets to be installed out of band. A production deployment is not configured or verified.
8. **Dependency audit:** the starting lockfile had 9 advisories (6 high, 3 moderate), including a production CSV parser advisory. Updated the parser and compatible development toolchain; `npm audit` now reports zero advisories. CI now runs an audit gate.
9. **Secrets and logging:** `HMAC_SECRET` is not declared as a plaintext var; required bindings are checked fail-closed. Voucher identifiers/tokens are redacted in selected logs. Full production secret hygiene, retention, alerts, backups, and recovery have not been verified.

## Implemented versus scaffold

- Implemented in source: deterministic pricing rules and parity tests; voucher domain, D1 persistence, HMAC and DO code; Shoptet read-only adapter; execution intent abstractions.
- Not equivalent to a service: pricing has no authenticated commerce API integration; Worker router does not expose a pricing or Medusa boundary.
- Not implemented: Medusa v2, PostgreSQL order/catalog/checkout, customer identity and entitlements, payments, booking, admin, private audio delivery, ANASTASIA API contracts.
- Do not treat historical README test totals, deployment claims, or design documents as current production evidence unless tied to this audited commit and a corresponding deployed environment.
