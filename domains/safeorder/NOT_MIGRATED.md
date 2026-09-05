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

## Shrnutí

Nic z výše uvedeného nesplňuje "čistá synchronní funkce bez I/O" Rule<>
kontrakt. Dvě datové konfigurace (`SAAS_PLAN_DEFINITIONS`,
`PLATFORM_CAPABILITIES`) jsou kandidáti na budoucí přesun do
`core/tenant/` jako konstanty -- ne teď, mimo scope tohoto kroku.
