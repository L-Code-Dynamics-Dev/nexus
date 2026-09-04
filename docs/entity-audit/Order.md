# ENTITY: Order

## SOURCE SYSTEMS
- Shoptet API: `ShoptetOrder` (`~/okfish-pricing-engine/cloudflare-worker/src/shoptet-api/client.ts`)
- SafeOrder: žádná Order entity — jen checkout-time risk evaluace, bez perzistovaného lifecycle
- AIE: `CustomerOrderLine` (`src/core/procurement/types.ts`) — NENÍ Order, je to procurement-facing řádek odvozený z Order
- ostatní zdroje: TBD (Omega — orders přichází jako CSV export, ne jako živá entita; ověřit)

## IDENTITY
- Canonical Order ID: TBD
- Shoptet external order code/id (`ShoptetOrder.code`, `ShoptetOrder.guid`): external identity

## EXTERNAL STATUS
- Shoptet provides (`GET /api/orders/statuses`, `shoptet_openapi.json`):
  - `status.id: number`
  - `status.name: string`
  - `status.system: bool`, `markAsPaid: bool`, `changeOrderItems: bool`, `stockClaimResolved: bool`, `documents: ...`
- Status catalogue is **tenant-specific** — confirmed via OpenAPI schema (`GET /api/orders/statuses` returns per-shop array, not a fixed enum).
- E-shop admin can define additional custom statuses.
- Status IDs must therefore **NOT** be treated as universal Nexus enums.
- Dnešní kód (`debug-check-order.ts`) zná jen `status.id === -3` a `status.id === -4` jako hardcoded magic numbers pro jeden konkrétní shop (okfish) — toto NENÍ obecně platné, ani napříč jinými Shoptet shopy.

## NEXUS LIFECYCLE
- Not yet defined.
- Must NOT be inferred from current Shoptet status values.
- Must be designed independently as a Nexus business lifecycle.
- Otevřené: je lifecycle jeden univerzální, nebo se štěpí na nezávislé osy (order/payment/fulfillment) — viz AIE `PaymentInfo` jako oddělený typ od `CustomerOrderLine.status` (kterého mimochodem CustomerOrderLine vůbec nemá).

## MAPPING
```
External status
  → tenant/platform-specific mapping
  → Nexus lifecycle state
```
- Mapping je konfigurační data (per tenant + per connector), ne kód v Core.

## UNKNOWN STATUS
- → preserve original external status
- → mark mapping as unresolved
- → do not guess

## SOURCE OF TRUTH
- Order data: external platform (Shoptet) je zdroj pravdy, dokud není importováno do canonical state.
- Nexus canonical state se stává autoritativní pro Nexus-owned rozhodnutí (např. RiskDecision, PurchaseOrder odvozené z Order).
- Exact field-level ownership: TBD — potřeba rozlišit pole, která NEXUS jen zrcadlí (total, items) vs. pole, která NEXUS sám vytváří nad rámec Shoptetu (canonicalStatus, riskDecisionId).

## RECONCILIATION
```
Expected Nexus state
  → external Shoptet state
  → compare
  → diff
  → resolution
```
- Musí zachytit i změnu samotného externího číselníku stavů (admin přidá/přejmenuje status v Shoptet adminu) — to není hodnotový mismatch, je to mapping drift, jiná kategorie chyby.

## INVARIANTS
- TBD after complete Order audit.

## AUDIT
- External status changes
- Nexus lifecycle changes
- mapping changes
- manual overrides
- reconciliation results

## RELATIONSHIP TO CustomerOrderLine (AIE)
- `CustomerOrderLine` by neměla být samostatná canonical entita — je to projekce/query nad `Order` + `OrderItem`, obohacená o `ownStockQuantity` (které patří do Stock domény, ne do Order). K řešení až po definici `OrderItem` auditu zvlášť.

## OPEN QUESTIONS
- Define Nexus Order lifecycle.
- Define whether lifecycle is universal or workflow-specific.
- Define field-level source of truth.
- Define status mapping model.
- Define unknown/unmapped status handling.
- Kdy v Nexus lifecycle vstupuje SafeOrder risk evaluace (pred-order? na kterém přechodu?).
- Kdy v Nexus lifecycle vstupuje AIE Procurement shortage detection.
