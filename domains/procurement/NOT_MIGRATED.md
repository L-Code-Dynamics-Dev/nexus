# SupplierMappingService a Workflow.ts — záměrně nemigrovány pod Rule<>

Task #16 přezkoumal `connectors/availability-intelligence/legacy/procurement/
{SupplierMappingService,Workflow}.ts`. Žádný z nich není `Rule<>` kandidát —
zde je proč, stejná disciplína jako `domains/safeorder/BlindToken.ts`
(async crypto, taky bez Rule wrapperu).

## SupplierMappingService.ts

Toto NENÍ business logika k migraci — je to **stavová in-memory mock
databáze** s hardcoded seed daty (fiktivní dodavatelé "Fox Outdoor",
"Helikon-Tex", "Brandit CZ", konkrétní produkty typu "Čistý triko Basic").
Každá veřejná metoda (`addSupplier`, `updateMapping`, `recordIntervention`,
...) mutuje interní `Map`/pole. Používá `Date.now()` a `Math.random()`
pro ID generování a `new Date().toLocaleTimeString()` pro timestampy —
nedeterministické, ne čistá funkce.

Vypadá jako backing store pro UI demo/prototyp (dashboard zobrazující
seznam dodavatelů a mapování), ne jako doménová pravidla. Pokud Nexus
bude potřebovat ekvivalent (perzistovaná supplier konfigurace a
product→supplier mapování), je to nová práce na `core/tenant`-scoped
konfiguraci + skutečné storage (D1/KV), ne migrace tohoto souboru —
migrace by jen přenesla mock/demo data do produkčního kódu.

## Workflow.ts (`ProcurementWorkflow`)

Čistá I/O orchestrace — každá veřejná metoda (`createPlan`, `receive`,
`cancelPurchaseOrder`, `approvePurchaseOrder`, `syncSupplierStatus`, ...)
je `async` a řetězí volání přes porty (`IdempotencyPort`, `AuditPort`,
`PurchaseOrderPort`, `SupplierDispatchPort`, `LoggerPort` — viz `ports.ts`,
už migrováno jako architektonický vzor beze změny). Jediná skutečná
business logika uvnitř je delegace na `ProcurementEngine.plan/receive`,
což už je migrováno (`domains/procurement/ProcurementRule.ts`).

`ProcurementWorkflow` je tedy budoucí **konzument** už migrovaných Rules,
ne něco k migraci samo o sobě — je to přesně vrstva, která má vzniknout
až bude mít k dispozici skutečné port implementace (Connector Layer
napojení na D1/KV/Shoptet, mimo scope této session).

## Pozorování k Workflow.ts (ne akce, jen poznámka pro budoucí práci)

`createPlan` iteruje `plan.purchaseOrders.filter(po => po.status === 'DRAFT')`
a přepíná na `'SENT'` přes `markAsSent()`. To je přesně ten
`PurchaseOrder.status` přechod, který `CANONICAL-MODEL-CONTRACT.md` §6
bod 1 označuje jako potřebu rozdělit na nezávislé osy (lifecycle/
cancellationState/supplierEcho) — `core/state-machine/StateAxisDefinition`
by tady dával smysl jako budoucí vynucení validních přechodů (DRAFT→SENT,
ne DRAFT→RECEIVED přímo), ale to je nová práce navazující na existující
`core/state-machine` framework, ne migrace `Workflow.ts` samotného.
