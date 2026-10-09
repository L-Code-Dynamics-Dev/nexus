# ANASTASIA system boundaries

**Date:** 2026-10-09
**Repository baseline:** `200dbf4d718931d0d227ecf25a5b1468bbef175f`
**Status:** target architecture for implementation, not a claim that all components exist.

## Intended sources of truth

| Capability | Authority | NEXUS responsibility | Current target state |
|---|---|---|---|
| Products, variants, inventory, carts, orders | Medusa v2 + PostgreSQL | Adapter and lifecycle integration; no second catalog/order store | Not present |
| Price policy and explanation | NEXUS Pricing Engine | Deterministic price decision, tenant-aware; server-side revalidation | Domain rules exist; commerce integration absent |
| Customer identity and sessions | Dedicated identity boundary / OIDC-capable provider | Map verified subject to tenant-scoped customer identity | Not present |
| Payment status | Medusa payment workflow + provider's signed webhook | Verify event, deduplicate, trigger state transition | Not present |
| Entitlements | ANASTASIA entitlement domain backed by transaction DB | Grant/revoke idempotently from confirmed payment/order lifecycle | Not present |
| Private audio/media | Private object storage and authorized delivery API | Check customer entitlement before issuing short-lived access | Not present |
| Availability and bookings | Booking domain with transactional uniqueness | Expose real slots; record lifecycle and audit | Not present |
| Voucher balance and redemption | Current D1 voucher tables and Worker boundary | Voucher-specific money balance, replay protection and reconciliation | Partial, separate scope |
| Cache / edge acceleration | KV/cache only for derived, invalidatable data | Never authoritative for money, orders, sessions or entitlement | No commerce cache configured |

## Trust boundary

1. Resolve tenant and customer from verified server-side credentials and host/domain configuration. Ignore client-submitted tenant IDs, prices, discount amounts, payment status and entitlement claims.
2. Read catalog identity and variant from Medusa. Pass normalized product, quantity, currency and verified customer policy context to NEXUS pricing.
3. Recalculate after cart changes and immediately before order creation. Persist the pricing decision/version and currency/rounding snapshot with the order using a supported Medusa lifecycle extension.
4. Use Medusa payment workflow and signed provider webhooks. Redirect URLs are display-only. Make payment transitions and entitlement grants idempotent.
5. Authorize every customer API request and every private media fetch independently. A valid session does not imply an entitlement.
6. Keep booking availability in a transactional store with a uniqueness/locking strategy. Do not expose sensitive health details in general customer notes.
7. Keep voucher D1 independent until an explicit reconciliation contract connects it to commerce orders. Do not make D1/KV a competing order or payment authority.

## Failure and retry boundaries

- Pricing, identity, database, or payment-provider errors fail closed before order confirmation/entitlement.
- Provider webhooks use signature verification, event idempotency keys, bounded retries, durable failed-event visibility and reconciliation.
- A timeout after an external call is an unknown outcome, not a guaranteed failure; reconcile before retrying non-idempotent actions.
- Do not place private customer responses or signed media URLs in shared CDN cache.
- Deployments and migrations run only against isolated staging until restore, migration and rollback procedures are proven.

## Medusa integration constraint

Choose extensions only after inspecting the exact installed Medusa v2 version and its supported workflows/hooks. Do not replace Medusa cart/order lifecycle or mutate undocumented internals. At this baseline, no Medusa package exists, so no hook/version claim has yet been verified.
