# NEXUS — E-commerce Operating System

Jednotná platforma nahrazující roztříštěné projekty (Pricing Engine, SafeOrder, Availability Intelligence Engine / Automatic Procurement Engine, Shoptet integrace/GOLIÁŠ, Omega účetní integrace) jedním canonical modelem, jednou validační/reconciliation vrstvou a modulárními business doménami.

**Než číst cokoli jiného: `docs/ARCHITECTURE_MAP.md` a `docs/MIGRATION_PLAN.md`.**

## Stav

Fáze 0 (infrastruktura) — rozjeto. Žádná doména ještě neobsahuje přenesenou business logiku; staré produkční systémy (okfish-pricing-engine, atd.) zůstávají referenční a živé, dokud NEXUS moduly nedosáhnou parity (viz Migration Plan).

## Struktura

```
core/            canonical model, tenant core, validation, state machines,
                 audit, reconciliation, error isolation, snapshot, idempotency
connectors/      shoptet (no-API V1), erp-generic, custom
domains/         pricing, safeorder, availability, procurement, billing,
                 marketing, b2b, campaign, creative — prázdné do Fáze 1+
ui/              guided workflows, e-shopářský jazyk
tests/           unit, integration, regression, contract, reconciliation,
                 tenant-isolation
docs/            architecture map, migration plan
```

## Pravidla (z master promptu)

- Žádné `if merchant === X` — tenant-scoped od prvního řádku
- 1 chybný záznam z N nikdy nezastaví celý běh → `PARTIAL_SUCCESS`
- Žádná ztráta existující business logiky, žádné hádání chybějících rules
- ERP-agnostic, Shoptet V1 bez API
- UI v jazyce e-shopaře, ne technickém žargonu
