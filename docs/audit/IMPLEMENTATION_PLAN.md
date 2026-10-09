# Implementation plan

**Date:** 2026-10-09
**Basis:** audit of `200dbf4d718931d0d227ecf25a5b1468bbef175f`.
**Definition of done:** every stage has passing automated acceptance tests and a reproducible staging API flow; no production changes are in this plan.

## Ordered work

| Order | Priority | Work | Dependencies | Acceptance evidence |
|---|---|---|---|---|
| 0 | P0 | Keep public issuance closed; explicit CORS allowlist; resolve dependency advisories. | This audit branch; reviewed package updates | Boundary tests; npm audit clean or remaining advisory formally scoped; regression suite green |
| 1 | P1 | Agree first-version product scope, providers, tenant/domain mapping, data controller, and source-of-truth boundaries. | Client and provider decisions | Signed decision record and environment map |
| 2 | P1 | Build isolated Medusa v2 + PostgreSQL staging foundation with secrets, migrations, backup/restore drill, and health checks. | Staging credentials and approved region/currencies | Fresh database migration and restore integration test |
| 3 | P1 | Catalog/variant import for EP.001 and any first-version services; validate counts, prices, content references, checksums. | Existing-site exports and six audio assets | Reconciled staging catalog; public preview and paid content classifications |
| 4 | P1 | Resolve tenant context server-side and integrate NEXUS Pricing Engine at cart mutation and checkout through a supported Medusa extension point. | Medusa version, pricing policy, contract | Cart and order line totals match NEXUS decision for price/quantity/currency matrix |
| 5 | P1 | Add customer identity, one-time email login, session revocation, admin roles, customer profile and entitlement model. | Identity/email provider | Expired/reused token, tenant escape, and unauthorized content tests fail closed |
| 6 | P1 | Add payment provider through Medusa payment workflow; verify signed, idempotent webhooks and failed-payment recovery. | Test payment credentials | No paid order or entitlement from redirect alone; duplicate webhook has one outcome |
| 7 | P1 | Gate private audio delivery on entitlement; keep Audio 0 public; add customer library and media administration. | Storage provider and identity | Direct object URLs do not bypass authorization; mobile/desktop playback in staging |
| 8 | P1 if contracted | Implement booking, concurrency locks, cancellation/reschedule audit, reminders, and minimal sensitive-data handling. | Confirmed service scope and provider availability policy | Two clients cannot reserve same slot; state changes are audited |
| 9 | P1 | Complete API contracts and end-to-end API tests for catalog → cart → pricing → checkout → order → payment → entitlement. | Stages 2–8 | Clean staging run without customer frontend or live charge |
| 10 | P1 | Inventory current site and migration sources: pages, URLs, products, orders, users, media, payments, QR/coupons, languages. | Admin/export access | Signed mapping, backup, rollback, counts/checksums, redirect test plan |
| 11 | P2 | QR campaign tooling, localization workflows, operations/admin improvements and monitoring hardening. | Core API/data model | Mobile campaign-to-order test, reviewed language variants, recovery drill |
| 12 | P3 | Generalize NEXUS platform beyond ANASTASIA; 3D/member-club roadmap. | Separate approved scope | Separate ADR and acceptance contract |

## Exact current blockers

- Target repository contains no Medusa or PostgreSQL implementation.
- No staging DB, payment, identity, storage, email-provider credentials, or existing-site exports are available in the audited repository.
- Do not create production resources or import real customers/orders during these stages.
- The endpoint integration cannot be certified end-to-end until test environment and business ownership choices are supplied.
