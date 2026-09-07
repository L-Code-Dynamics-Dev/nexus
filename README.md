# NEXUS — E-commerce Operating System

Jednotná platforma nahrazující roztříštěné projekty (Pricing Engine, SafeOrder, Availability Intelligence Engine / Automatic Procurement Engine, Shoptet integrace/GOLIÁŠ, Omega účetní integrace) jedním canonical modelem, jednou validační/reconciliation vrstvou a modulárními business doménami.

**Než číst cokoli jiného: `docs/ARCHITECTURE_MAP.md`, `docs/MIGRATION_PLAN.md` a `PROGRESS_LOG.md`.**

---

## Stav k 2026-09-07 (měřeno, ne odhadnuto)

| Metrika | Hodnota |
|---|---|
| TypeScript soubory v `core/ domains/ connectors/ workers/` | 176 |
| Řádků TS v těchto adresářích | 18 516 |
| Node testy (`npm test`) | 754 / 754 zelených, 61 test files |
| Workers/D1 testy (`npm run test:workers`) | 19 / 19 zelených — **jen na CI**, lokálně nespustitelné |
| `npx tsc --noEmit` | čistý |

### Zlom: 2026-09-06 — první produkční perzistence

Do 6. 9. 2026 byl NEXUS **knihovna business logiky bez runtime**: entity, Rules, Flows, testy — ale žádná databáze, žádný deployment, žádný proces, který by to spustil. Voucher Fáze A to změnila. Poprvé v repu existuje:

- `migrations/` — D1 SQL migrace (`0001_credit_voucher.sql`, `0002_voucher_audit.sql`)
- `wrangler.jsonc` — první Worker config (dev + `env.production`, D1 binding `DB`, Durable Object `VOUCHER_SECURITY`)
- `workers/api/` — první HTTP entry point (`index.ts`, `hmac.ts`, `http.ts`, `types.ts`, `SecurityCoordinator.ts`, `routes/voucher.ts`, `routes/issuance.ts`)
- `connectors/d1/` — první perzistentní store (`D1CreditVoucherStore.ts`, `moneyMapper.ts`)
- `.github/workflows/test.yml` — první CI

To platí **pro voucher doménu a jen pro ni**. Ostatní domény runtime ani perzistenci nemají.

### Stav po vrstvách

| Vrstva | Stav | Poznámka |
|---|---|---|
| Doménový model (`core/canonical/`, entity, lifecycle, invariants) | z velké části hotový | 17 souborů / 1 520 ř. v `core/canonical/` |
| Business Rules & Flows (`domains/`) | částečně — viz tabulka domén níže | žádná doména není napojená na runtime kromě voucheru |
| Testy | rozsáhlé | 754 node + 19 workers |
| Runtime (Worker, HTTP, DO) | **jen voucher** | `workers/api/` obsluhuje voucher endpointy, nic jiného |
| Perzistence (D1) | **jen voucher** | `migrations/` jsou dvě voucher migrace |
| Nasazení | **0 %** | `database_id` ve `wrangler.jsonc` jsou stále placeholdery `<vyplnit-po-wrangler-d1-create>` — nikdy se nedeploylo |
| UI | **0 %** | `ui/` je prázdný adresář |
| Nativní connectory | **0 %** | `Connector.ts` kontrakt neimplementuje ani jedna třída |

### Domény — co má reálnou logiku a co je kostra

| Doména | TS soubory | Řádky | Charakter |
|---|---|---|---|
| `voucher` | 5 | 1 462 | Reálná logika + jediná napojená na D1/Worker (Fáze A) |
| `pricing` | 12 | 768 | Reálná logika, portovaná z okfish (golden dataset parity) |
| `campaign` | 6 | 691 | Reálná logika (PromoGroup discount, Creative resolve) |
| `safeorder` | 13 | 472 | Rule contract obaly nad `connectors/safeorder/legacy/` |
| `availability` | 6 | 402 | Rule contract obaly nad legacy portem |
| `omega` | 4 | 248 | Rule contract obaly nad legacy portem |
| `billing` | 2 | 206 | Lifecycle + flow, žádný skutečný billing |
| `b2b` | 3 | 193 | Accessor + strukturální validace, žádná obchodní pravidla |
| `invoice` | 2 | 168 | Lifecycle + flow, žádný dokladový workflow |
| `warehouse` | 2 | 154 | Link rule + flow, žádné skladové pohyby |
| `procurement` | 2 | 103 | Rule contract obal |
| `shoptet` | 2 | 50 | Rule contract obal |
| `supplier-csv` | 1 | 46 | Rule contract obal |
| `creative` | 0 | 0 | **prázdný adresář** (Creative logika žije v `campaign/`) |
| `marketing` | 0 | 0 | **prázdný adresář** |

### Connectory — 79 z 83 souborů je legacy port

| Adresář | TS soubory | Řádky | Co to je |
|---|---|---|---|
| `connectors/safeorder/legacy/` | 20 | 2 034 | 1:1 port ze `safeorder-3.0` |
| `connectors/availability-intelligence/legacy/` | 14 | 1 325 | 1:1 port z AIE |
| `connectors/omega/legacy/` | 23 | 1 246 | 1:1 port z `omega-bridge` + nový `OmegaExecutor` |
| `connectors/pricing-engine/legacy/` | 16 | 849 | 1:1 port z okfish-pricing-engine |
| `connectors/shoptet/legacy/` | 6 | 486 | CSV objednávky + `golias.js` (cart adapter) |
| `connectors/supplier-csv/legacy/` | 1 | 72 | `NoApiCsvAdapter` |
| `connectors/d1/` | 2 | 1 210 | **jediný nativní běhový konektor** (voucher store) |
| `connectors/erp-generic/` | 0 | 0 | **prázdný** — jen design proposal |
| `connectors/custom/` | 0 | 0 | **prázdný** |

Celkem 79 souborů / 5 963 řádků v `legacy/`. Mimo legacy existují jen 4 soubory: `Connector.ts` (kontrakt), `pricing-engine/createLegacyPricingCalculator.ts` a dva soubory v `d1/`.

**`grep "implements Connector"` vrací nula výsledků.** Connector Layer je dnes kontrakt bez jediné implementace — legacy porty jsou volané přímo, ne přes rozhraní.

---

## Jak pouštět testy

```bash
npm test           # vitest run -- node testy (core/domains/connectors). 754 testů, ~60 s.
npm run build      # tsc --noEmit
npm run test:workers   # vitest -c vitest.workers.config.ts -- workerd runtime + reálná D1
```

**`npm run test:workers` na vývojovém Macu NEPOBĚŽÍ.** Cloudflare workerd vyžaduje macOS 13.5+, Mac Mini 2014 jede 12.7.6. Není to chyba configu — pipeline projde až k bodu, kde miniflare spouští runtime binárku, a tam skončí:

```
Unsupported macOS version: ... The minimum requirement is macOS 13.5.0+.
```

Jediné místo, kde se Workers/D1 testy reálně ověří, je `.github/workflows/test.yml` — job `workers` na `ubuntu-latest`. Bez zeleného CI běhu jsou tvrzení o atomicitě čerpání jen dokumentací, ne důkazem. K 2026-09-07 CI zelené je (19/19).

CI má dva joby, oba na Ubuntu:
- `node` — `npx tsc --noEmit` (root), `npx tsc --noEmit -p tests/workers/tsconfig.json`, `npm test`
- `workers` — `npm run test:workers`

---

## Struktura repa

```
core/
  canonical/       entity, lifecycle, invariants, relationships, states,
                   projections, source-of-truth, validation, versioning
                   (base.ts = jediný zdroj pravdy pro CanonicalEntity/TenantId/EntityId)
  tenant/          TenantConfig, plány, tenant scope
  validation/      sjednocený validation framework
  state-machine/   evaluateTransition + definice stavových os
  audit/           audit záznamy
  reconciliation/  generic reconciliation
  error-isolation/ PARTIAL_SUCCESS vzor
  snapshot/        snapshot/rollback
  idempotency/     claim/complete store

domains/           business Rules a Flows -- ČISTÉ FUNKCE, žádné I/O
                   (Rule dostává `now` jako vstup, nikdy nečte hodiny ani fs)

connectors/        Connector.ts kontrakt + legacy/ 1:1 porty starých systémů
                   + d1/ (jediný nativní store)

workers/api/       Cloudflare Worker entry -- dnes jen voucher endpointy
migrations/        D1 SQL migrace -- dnes jen voucher
wrangler.jsonc     Worker config (dev + env.production)

tests/
  unit/            Rules a core komponenty
  integration/     end-to-end přes více domén
  regression/      parity testy proti legacy (golden-pricing, connectors,
                   safeorder, availability)
  tenant-isolation/
  workers/         workerd + reálná D1 -- běží JEN na CI
  contract/        prázdné
  reconciliation/  prázdné

ui/                PRÁZDNÉ
docs/              ARCHITECTURE_MAP, MIGRATION_PLAN, CANONICAL_MODEL_SYNTHESIS,
                   design-proposals/, entity-audit/
```

Kam co patří:
- **Business rozhodnutí** → `domains/<doména>/<X>Rule.ts`, čistá funkce, deterministická, `now` jako parametr.
- **Kompozice více Rules do use-case** → `domains/<doména>/<X>Flows.ts`, žádná nová logika.
- **Překlad tvaru dat z/do externího systému** → `connectors/`. Konektor NIKDY nepočítá business hodnotu.
- **Sdílený tvar entity** → `core/canonical/entities/`. Nikdy neduplikovat typ v `core/tenant/` nebo doméně.
- **Perzistence** → `connectors/d1/` + `migrations/`. Doména zná jen Store interface, ne SQL.
- **HTTP** → `workers/api/routes/`. Route neobsahuje business logiku, jen volá Rules/Store.

---

## Známé blokátory

Detail v `PROGRESS_LOG.md`.

1. **Workers/D1 testy lokálně nespustitelné** — macOS 12.7.6 vs. požadavek workerd 13.5+. Ověřitelné jen na CI. Hardwarový strop, ne konfigurace.
2. **Nic není nasazené.** `database_id` / `preview_database_id` ve `wrangler.jsonc` jsou placeholdery. D1 databáze `nexus-voucher-dev` a `nexus-voucher` fyzicky neexistují.
3. **Hardcoded tenant** — `domains/pricing/createNexusPricingCalculator.ts:62` má `tenantId: 'ten_1'`. Porušuje pravidlo "tenant-scoped od prvního řádku". P0.2.
4. **Pricing čte filesystem** — `createNexusPricingCalculator.ts:56` volá `fs.readFileSync` na `policy-v1.json`. Ve Workeru to nikdy nepoběží; potřeba `PricingConfigurationProvider`. P0.3.
5. **Connector Layer bez implementace** — `Connector.ts` neimplementuje nikdo, `connectors/erp-generic/` a `connectors/custom/` jsou prázdné.
6. **`OmegaExecutor` neověřený proti reálnému Windows agentovi** — 9/9 sanity testů proti mock skriptům, žádný běh proti skutečnému `AkciaOmega.bat`.
7. **Voucher Fáze B čeká** — Shoptet injector a validace instalace se nezačínají, dokud není hotové P0/P1 (rozhodnutí Lucky 2026-09-07).
8. **Větev `chore/vitest-4-upgrade` nemergovaná do `main`** — veškerá práce od 6. 9. sedí tam.

---

## Pravidla (z master promptu)

- Žádné `if merchant === X` — tenant-scoped od prvního řádku
- 1 chybný záznam z N nikdy nezastaví celý běh → `PARTIAL_SUCCESS`
- Žádná ztráta existující business logiky, žádné hádání chybějících rules
- Dokud nový modul nedosahuje parity se starým, starý zůstává referenční a produkční
- ERP-agnostic, Shoptet V1 bez API
- Rules jsou čisté funkce — žádné hodiny, žádný fs, žádná síť
- UI v jazyce e-shopaře, ne technickém žargonu
