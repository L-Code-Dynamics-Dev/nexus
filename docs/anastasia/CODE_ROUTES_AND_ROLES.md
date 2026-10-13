# Kódový inventář pro návrh administrace

Statická analýza deklarací, přístupů ke vstupům, schémat, rolí, route větví a Electron IPC. Route entries zahrnují také prefixové routy a soukromé integrační callbacky; nejsou automaticky admin API. Každý zápis má zdroj a řádek. Žádné handlery nebyly vykonány a přístupové soubory nejsou zahrnuté.

## Rozsah

{
  "files": 536,
  "lines": 73683,
  "interfaces": 695,
  "methods": 580,
  "routeEntries": 82,
  "ipcEntries": 38
}

## nexus/apps/kar/src/index.ts

- Route: `see handler /api/` (řádek 65).
- Route: `GET /api/session` (řádek 82).
- Route: `see handler /api/settings/pepa-roast` (řádek 83).
- Route: `GET /api/health` (řádek 84).
- Route: `see handler /api/speech` (řádek 88).
- Route: `see handler /api/chat` (řádek 89).

## nexus/workers/api/SecurityCoordinator.ts

- Route: `see handler /health` (řádek 271).

## nexus/workers/api/index.ts

- Route: `see handler /api/vouchers/validate` (řádek 111).
- Route: `see handler /api/vouchers/redeem` (řádek 115).
- Route: `see handler /api/webhooks/shoptet` (řádek 122).

## okfish-pricing-engine/cloudflare-worker/src/index.ts

- Route: `GET /static/` (řádek 159).
- Route: `GET /v1/feed/status` (řádek 180).
- Route: `GET /v1/feed/report` (řádek 189).
- Route: `POST /v1/feed/generate` (řádek 212).
- Route: `POST /v1/import/chunk` (řádek 248).
- Route: `POST /v1/admin/worker-sync` (řádek 263).
- Route: `GET /v1/admin/worker-sync` (řádek 280).
- Route: `POST /v1/admin/reconcile` (řádek 291).
- Route: `GET /v1/admin/reconcile` (řádek 318).
- Route: `GET /v1/force-sync` (řádek 325).
- Route: `POST /v1/force-sync` (řádek 332).
- Route: `GET /v1/discount/` (řádek 343).
- Route: `POST /v1/webhook/shoptet` (řádek 372).
- Route: `POST /v1/products/import/begin` (řádek 414).
- Route: `POST /v1/products/import/chunk` (řádek 426).
- Route: `POST /v1/products/import/finish` (řádek 446).
- Route: `GET /v1/products/feed-hash` (řádek 463).
- Route: `POST /v1/products/feed-hash` (řádek 473).
- Route: `GET /v1/price-cache/` (řádek 495).
- Route: `POST /v1/price-cache/` (řádek 507).
- Route: `GET /v1/sync-state` (řádek 525).
- Route: `POST /v1/sync-state` (řádek 530).
- Route: `GET /v1/coupon-state` (řádek 550).
- Route: `POST /v1/coupon-state` (řádek 555).
- Route: `see handler /v1/coupon-config` (řádek 571).
- Route: `POST /v1/clearance/apply` (řádek 577).
- Route: `GET /v1/product-discount/` (řádek 581).
- Route: `GET /feed.xml` (řádek 622).

## okfish-pricing-engine/desktop-app/main.js

- IPC: `app-ready` (řádek 54).
- IPC: `pick-file` (řádek 112).
- IPC: `reveal-file` (řádek 118).
- IPC: `process-products` (řádek 122).
- IPC: `compute-dashboard` (řádek 140).
- IPC: `load-catalog` (řádek 149).
- IPC: `ensure-repo` (řádek 159).
- IPC: `load-policies` (řádek 169).
- IPC: `save-policies` (řádek 178).
- IPC: `export-rule-csv` (řádek 229).
- IPC: `load-customer-index` (řádek 241).
- IPC: `get-customer-detail` (řádek 253).
- IPC: `get-availabilities` (řádek 263).
- IPC: `set-product-availability` (řádek 273).
- IPC: `find-customers` (řádek 285).
- IPC: `set-customer-tier` (řádek 297).
- IPC: `process-customers` (řádek 309).
- IPC: `load-settings` (řádek 327).
- IPC: `save-settings` (řádek 335).

## okfish-pricing-engine/src/server/index.ts

- Route: `GET /` (řádek 21).
- Route: `POST /generate` (řádek 37).

## pricing-engine-platform/cloudflare-worker/src/index.ts

- Route: `GET /static/` (řádek 97).
- Route: `GET /v1/feed/status` (řádek 118).
- Route: `GET /v1/feed/report` (řádek 127).
- Route: `POST /v1/feed/generate` (řádek 141).
- Route: `POST /v1/sync-stats` (řádek 172).
- Route: `GET /v1/sync-stats` (řádek 183).
- Route: `POST /v1/import/begin` (řádek 192).
- Route: `POST /v1/import/chunk` (řádek 201).
- Route: `GET /v1/import/active` (řádek 214).
- Route: `POST /v1/import/finish` (řádek 223).
- Route: `POST /v1/import/cleanup` (řádek 234).
- Route: `GET /v1/discount/` (řádek 253).
- Route: `POST /v1/webhook/shoptet` (řádek 270).
- Route: `POST /v1/products/import/begin` (řádek 306).
- Route: `POST /v1/products/import/chunk` (řádek 318).
- Route: `POST /v1/products/import/finish` (řádek 345).
- Route: `GET /v1/price-cache/` (řádek 366).
- Route: `POST /v1/price-cache/` (řádek 379).
- Route: `GET /v1/product-discount/` (řádek 400).
- Route: `GET /feed.xml` (řádek 441).

## pricing-engine-platform/desktop-app/main.js

- IPC: `app-ready` (řádek 52).
- IPC: `pick-file` (řádek 110).
- IPC: `reveal-file` (řádek 116).
- IPC: `process-products` (řádek 120).
- IPC: `compute-dashboard` (řádek 138).
- IPC: `load-catalog` (řádek 147).
- IPC: `ensure-repo` (řádek 157).
- IPC: `load-policies` (řádek 167).
- IPC: `save-policies` (řádek 176).
- IPC: `export-rule-csv` (řádek 195).
- IPC: `load-customer-index` (řádek 207).
- IPC: `get-customer-detail` (řádek 219).
- IPC: `get-availabilities` (řádek 229).
- IPC: `set-product-availability` (řádek 239).
- IPC: `find-customers` (řádek 251).
- IPC: `set-customer-tier` (řádek 263).
- IPC: `process-customers` (řádek 275).
- IPC: `load-settings` (řádek 293).
- IPC: `save-settings` (řádek 301).

## pricing-engine-platform/src/server/index.ts

- Route: `GET /` (řádek 21).
- Route: `POST /generate` (řádek 37).

## safeorder-3.0/src/api/router.ts

- Route: `GET /health` (řádek 42).
- Route: `POST /v1/onboarding/register` (řádek 47).
- Route: `GET /v1/onboarding/status` (řádek 49).
- Route: `POST /v1/onboarding/offboard` (řádek 51).
- Route: `GET /v1/config/policy` (řádek 56).
- Route: `PUT /v1/config/policy` (řádek 58).
- Route: `POST /v1/checkout/evaluate` (řádek 63).
- Route: `POST /v1/install/shoptet` (řádek 68).
- Route: `POST /webhooks/shoptet` (řádek 73).
- Route: `POST /webhooks/shopify` (řádek 75).
- Route: `POST /v1/import/historical` (řádek 80).
- Route: `GET /v1/admin/dashboard` (řádek 85).
- Route: `POST /v1/admin/overrides` (řádek 87).
- Route: `PUT /v1/admin/policies` (řádek 89).
- Route: `PUT /v1/admin/economics` (řádek 91).
- Route: `POST /v1/privacy/dsar` (řádek 96).

## safeorder-3.0/src/api/routes/admin.ts

- Role: `VIEWER` → `handleAdminDashboard` (řádek 13).
- Role: `OPERATOR` → `handleAdminOverride` (řádek 47).
- Role: `ADMIN` → `handleAdminPolicyUpdate` (řádek 106).
- Role: `ADMIN` → `handleAdminEconomicsUpdate` (řádek 136).

## safeorder-3.0/src/api/routes/import.ts

- Role: `ADMIN` → `handleHistoricalImport` (řádek 14).

## safeorder-3.0/src/api/routes/privacy.ts

- Role: `OWNER` → `handleDsarRequest` (řádek 13).

## tutani-barf-worker/src/index.ts

- Route: `see handler /v1/davka` (řádek 205).
- Route: `see handler /v1/jidelnicek.pdf` (řádek 209).
- Route: `see handler /v1/knowledge` (řádek 213).
- Route: `see handler /v1/health` (řádek 217).

