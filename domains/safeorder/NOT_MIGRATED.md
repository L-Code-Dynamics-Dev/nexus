# SafeOrder podpůrné moduly — vědomě nemigrovány pod Rule<>

Task pokračování Fáze 2 (docs/MIGRATION_PLAN.md). Přezkoumáno přímým
čtením (ne převzato z fabrikovaného reportu předchozího forku — viz
feedback poslaný v této session), rozhodnutí zdokumentováno.

## billing/plans.ts

`SAAS_PLAN_DEFINITIONS` mapa (plán tiers/limity) je čistě datová
konstanta, ale soubor importuje `DatabaseClient` z `../../storage/db`
pro zbylé funkce (per-tenant plán lookup/update) -- I/O závislost,
ne čistá funkce. Statická `SAAS_PLAN_DEFINITIONS` mapa samotná by šla
přenést jako konfigurace do `core/tenant/types.ts` (`TenantPlan` už
existuje, viz `TenantPlan` interface) -- budoucí práce, ne teď.

## onboarding/onboarding-service.ts

`OnboardingService` třída se stavovými poli a async metodami volajícími
DB port -- I/O orchestrace, ne čistá funkce.

## capabilities/integration-capabilities.ts

Statická feature-flag matice (`PLATFORM_CAPABILITIES: Record<Platform,
Capability[]>`) + jedna lookup funkce. Přenositelné jako konfigurace,
ale je to čistě datová tabulka bez chování k testování jako Rule --
kandidát na budoucí přesun do `core/tenant/` jako konstanta, ne Rule.

## security/rate-limiter.ts

`RateLimiter.checkRateLimit()` má modulovou `Map` (`memoryBuckets`)
jako in-memory stavové úložiště PLUS interně volá `Date.now()` -- není
to čistá funkce (stejné duvody jako u `BlindToken.ts`/`OmegaAdapter.process`
dřív: stav a/nebo čas čtený zevnitř, ne jako parametr). V Cloudflare
Workers navíc in-memory Map nepřežije mezi requesty (per-isolate stav,
ne globální) -- produkční rate limiting vyžaduje KV/D1 backend, což je
nová infrastrukturní práce, ne migrace tohoto souboru.

## ingestion/{session-token,csv-importer}.ts

`session-token.ts` generuje/verifikuje token přes Node `crypto.randomBytes`
(side-effectful randomness). `csv-importer.ts` čte soubor ze disku
(`fs.readFileSync`) -- I/O. `ingestion/types.ts` jsou jen typy, nic
k migraci.

## backtest/point-in-time-backtest.ts

Soubor (737 řádků) obsahuje jak čistou logiku, tak I/O orchestraci --
rozděleno:

- **`calculateMetricSet`, `calculateRocAuc`, `calculateBrierScore`**
  (klasifikační metriky: precision/recall/F1/accuracy/FPR/specificity,
  ROC-AUC, Brier score) -- čisté, synchronní, I/O-free. MIGROVÁNO do
  `connectors/safeorder/legacy/backtest/metrics.ts` +
  `domains/safeorder/BacktestRule.ts` (`MetricSetRule`, `RocAucRule`,
  `BrierScoreRule`), 1:1 delegace, parity testy proti skutečné legacy
  funkci v `tests/regression/safeorder/backtest-rule-parity.test.ts`.

- **`PointInTimeBacktestEngine.runBacktest`** -- async orchestrace:
  staví mock in-memory D1 databázi (`PointInTimeD1Database`), instancuje
  `FiveStagePipeline` (DB-orchestrátor, sám nemigrován -- viz výše),
  volá `generateBlindToken` (async crypto), iteruje objednávky
  chronologicky a simuluje "point-in-time" evaluaci s postupnou
  aktualizací risk-graph uzlů. Je to CELÝ E2E test harness, ne business
  logika -- konzument Rules (`RiskEngineRule`, `CalibrationRule`,
  `PolicyRule`, atd.), stejná kategorie jako
  `LCodePipelineOrchestrator`/`ProcurementWorkflow`/`FiveStagePipeline`.
  NEMIGROVÁNO.

- **`parseOkfishXml`, `parseGuaranaPlusCsv`** -- čisté parsery, ale
  vázané na konkrétní KONKURENČNÍ/EXTERNÍ legacy export formáty
  (OKfish Shoptet XML, GuaranaPlus Shoptet CSV) použité jen pro
  historický backtest na cizích datových sadách -- NENÍ SafeOrder
  doménová logika (na rozdíl od Shoptet CSV parseru v Pricing/Omega
  Fázi, který parsuje VLASTNÍ produkční feed formát). NEMIGROVÁNO --
  mimo scope SafeOrder Rule contract migrace.

- **`PointInTimeD1Database`** -- mock D1 implementace pro testování,
  ne produkční kód. NEMIGROVÁNO.

## Shrnutí

Nic z billing/onboarding/capabilities/security/ingestion nesplňuje
"čistá synchronní funkce bez I/O" Rule<> kontrakt. Dvě datové
konfigurace (`SAAS_PLAN_DEFINITIONS`, `PLATFORM_CAPABILITIES`) jsou
kandidáti na budoucí přesun do `core/tenant/` jako konstanty -- ne teď,
mimo scope tohoto kroku. Z `backtest/point-in-time-backtest.ts` byly
tři čisté metrikové funkce migrovány (viz sekce výše), zbytek souboru
(orchestrace, cizí formát parsery, mock DB) zůstává nemigrovaný.
