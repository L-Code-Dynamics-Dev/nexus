# ANASTASIA requirements matrix

**Date:** 2026-10-09
**Commit:** `200dbf4d718931d0d227ecf25a5b1468bbef175f`

States: VERIFIED_DONE, IMPLEMENTED_NOT_VERIFIED, PARTIAL, NOT_IMPLEMENTED, BLOCKED, FUTURE_SCOPE. Priorities: P0 security/data blocker; P1 first-version acceptance; P2 important follow-up; P3 roadmap.

| ID | Requirement | State | Evidence | Priority / scope | Dependencies and remaining work | Test / acceptance | Risk / access |
|---|---|---|---|---|---|---|---|
| A-01 | Shared passwordless identity / OIDC | NOT_IMPLEMENTED | No identity service or auth routes in target | P1 / ANASTASIA | Select identity authority; implement verified one-time login, sessions, linking, rate limits | Replay/expiry/linking tests; OIDC flow | Requires domain/DNS and email provider |
| A-02 | Customer profile and protected library | NOT_IMPLEMENTED | No customer app/API | P1 / ANASTASIA | Data model, authz, order-linked entitlements | Cross-customer access denied | Product/content decisions |
| A-03 | Catalog, variants, EUR pricing | NOT_IMPLEMENTED | No Medusa/backend package | P1 / ANASTASIA | Medusa v2 + PostgreSQL, catalog import and validation | Product/variant/region API tests | Staging DB credentials |
| A-04 | Checkout, order persistence | NOT_IMPLEMENTED | No commerce order API | P1 / ANASTASIA | Server price validation and Medusa workflows | API E2E creates persistent order | Staging environment |
| A-05 | Payment session and verified webhook | NOT_IMPLEMENTED | No payment provider integration | P1 / ANASTASIA | Provider credentials, signature/idempotency, failure states | Duplicate/invalid webhook and failed payment tests | Test credentials |
| A-06 | Nič nemusíš (EP.001), six audios, €38 | NOT_IMPLEMENTED | No catalog/audio management code | P1 / ANASTASIA | Configurable product/content, public Audio 0 and paid content rights | Paid files denied without entitlement; preview public | Client supplies files/content metadata |
| A-07 | Private media access | NOT_IMPLEMENTED | No protected storage route | P1 / ANASTASIA | Authenticated entitlement check and short-lived delivery | Direct URL unauthorized/expired tests | Storage/provider configuration |
| A-08 | Reservation service / calendar | NOT_IMPLEMENTED | No booking domain/API | P1 if included in contract | Availability, locking, cancellation and audit model | Competing booking test | Provider schedules and business rules |
| A-09 | Client-oriented administration | NOT_IMPLEMENTED | No admin UI or admin API | P1 / ANASTASIA | Roles, client timeline, orders, entitlements, booking, audit | Role matrix integration tests | Staff roles/workflows needed |
| A-10 | SafeOrder | PARTIAL | Domain/regression rules exist; no commerce endpoint in target router | P2 / NEXUS platform | Define input contract and integrate in server checkout | API and adversarial order evaluation | Policy sign-off |
| A-11 | Pricing Engine tenant isolation | PARTIAL | Pure rules/provider and tenant assertions; no Medusa integration | P1 / ANASTASIA | Resolve tenant server-side and price revalidation in cart/checkout | Multi-tenant/pricing integration tests | Final tenant/policy config |
| A-12 | Voucher runtime security | PARTIAL | Worker/D1/DO code and tests exist; CORS and issuance route fixed in this branch | P1 / existing voucher scope | Durable rate limiting; deploy config and workerd test run | D1 + replay/race tests in supported CI | Cloudflare configuration |
| A-13 | QR campaigns and coupons | NOT_IMPLEMENTED | No campaign/QR admin workflow | P2 / future operations | URL contract, coupon preservation and redirects | End-to-end mobile scan checkout | Existing printed URLs/coupons |
| A-14 | Slovak / English / Russian | NOT_IMPLEMENTED | No storefront or localization package | P2 / ANASTASIA | Canonical product with reviewed localized content | Locale routing and content checks | Approved translations |
| A-15 | Current-site inventory and migration | PARTIAL | Public root page inspected; repo migration plan is conceptual | P1 / ANASTASIA | Export URLs, catalog/orders/accounts/media; mapping, checksums, backup and rollback | Staging import count/hash reconciliation | Admin/export access to current site |
| A-16 | PostgreSQL migrations/recovery | NOT_IMPLEMENTED | Only D1 migrations present | P1 / Medusa | Establish staging PostgreSQL, repeatable migrations and restore rehearsal | Clean migrate + backup/restore test | Staging DB access |
| A-17 | Monitoring, backups, recovery | BLOCKED | No access to deployed accounts or runbooks | P1 / operations | Define SLO, alerts, backup retention and restore drills | Recovery exercise | Cloudflare/DB/provider access |
| A-18 | Golden Gate / 3D environment | FUTURE_SCOPE | No target implementation | P3 / roadmap | Only after signed scope | Separate acceptance | Explicitly outside first-version assumptions |

Effort estimates are intentionally not numeric: scope, integration authority, and current-system exports have not been confirmed. Use a discovery estimate after credentials and contract boundaries are available.
