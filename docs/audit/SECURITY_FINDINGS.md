# Security findings

**Date:** 2026-10-09
**Commit:** `200dbf4d718931d0d227ecf25a5b1468bbef175f`
**Status legend:** VERIFIED = reproduced by code inspection or test; FIXED = changed in this audit branch; BLOCKED = requires external configuration or environment.

| ID | Priority | Finding | Evidence / disposition |
|---|---|---|---|
| SEC-01 | P0 | Public voucher issuance accepted order state and line items without an authenticated order source. | Verified in `workers/api/routes/issuance.ts`; no internal caller in `shoptetWebhook.ts`. Public `/api/vouchers/issue` route removed from `workers/api/index.ts`; test asserts 404. Future issuance must fetch order server-side and authenticate caller. |
| SEC-02 | P0 | CORS wildcard default and wildcard allowlist could expose voucher responses to arbitrary websites. | Verified in `workers/api/http.ts`; fixed to default-deny and reject `*`. Unit tests cover missing, wildcard, exact allowlist. |
| SEC-03 | P1 | D1 rate limits are volatile in-memory state in the Durable Object. | Verified in `workers/api/SecurityCoordinator.ts`; object eviction resets counters. Use provider edge rate limits and/or durable counters before production. |
| SEC-04 | P1 | Target deployment config is incomplete. | `wrangler.jsonc` has placeholder D1 IDs; no explicit origin allowlist. Dry-run result is in TEST_RESULTS. No production deployment performed. |
| SEC-05 | P1 | Shoptet webhook processing acknowledges event before asynchronous order processing and current order fetch/issuance steps remain incomplete. | `workers/api/routes/shoptetWebhook.ts`. Failure is logged, but no durable queue/retry/reconciliation path was verified. |
| SEC-06 | RESOLVED | Dependency advisories existed in lockfile. | Updated `csv-parse` and compatible Cloudflare/Vitest tooling; full `npm audit` now reports 0. Regression/build checks passed. CI still does not run audit automatically. |
| SEC-07 | P1 | No customer auth, role-based admin, payment webhook, entitlement enforcement, or private media authorization exists in target. | Verified by inventory; blocks ANASTASIA commerce acceptance. |
| SEC-08 | P2 | Workflow actions use version tags rather than immutable commit SHAs; no deployment/provenance/security scan stage. | `.github/workflows/test.yml`; CI only typechecks and runs Node/workerd test suites. |

## Controls verified

- HMAC webhook verification checks the raw request body and requires both forwarding token and Shoptet signature.
- Voucher redemption rejects missing core bindings, validates HMAC/expiry, reserves nonce through DO, and uses D1 balance constraints/optimistic concurrency.
- CORS and issuance boundary fixes have focused tests and Node suite results in TEST_RESULTS.

## Not verified

No access to Cloudflare account configuration, deployed Worker, D1 data, production secrets, monitoring, backups, or incident response. No credentials were read or printed. No live request or production mutation was attempted.
