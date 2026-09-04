# ENTITY: PurchaseOrder

## SOURCE
- Availability Intelligence Engine / Automatic Procurement Engine
  - `src/core/procurement/types.ts` (TS union type)
  - `src/core/procurement/Workflow.ts` (orchestrace — `cancelPurchaseOrder()`, `approvePurchaseOrder()`, `createPlan()`, `receive()`)
  - `src/core/procurement/ports.ts` (`PurchaseOrderPort` kontrakt)
  - `src/platform/persistence/PostgresProcurementRepository.ts` (skutečné SQL zápisy — REVIDOVÁNO, viz níže)
  - `migrations/001_procurement_core.sql` (DB CHECK constraint)
  - `tests/ProcurementEngine.test.ts` (jediný test odkazující na status)

## CURRENT TYPE
`PurchaseOrder.status` deklaruje (`types.ts:108`):
```
DRAFT | PENDING_APPROVAL | SENT | CANCELLED | COMPLETED | RECEIVED | PARTIALLY_RECEIVED
```

## ACTUAL IMPLEMENTATION — REVIDOVÁNO po hlubší kontrole `PostgresProcurementRepository.ts`

Moje první průchod (grep jen na literály v `types.ts`/`Workflow.ts`) byl nedostatečný — `Workflow.ts` volá porty, skutečné SQL je v repository. Po ověření tam je obraz odlišný a přesnější:

```sql
-- cancel(): SKUTEČNĚ zapisuje CANCELLED
UPDATE procurement_purchase_orders SET status = 'CANCELLED'
WHERE id = $1 AND tenant_id = $2 AND status NOT IN ('RECEIVED','COMPLETED','CANCELLED')

-- approve(): NEZAPISUJE nic — jen ČTE, ověřuje že status = 'PENDING_APPROVAL', jinak throw
SELECT id FROM procurement_purchase_orders WHERE id = $1 AND tenant_id = $2 AND status = 'PENDING_APPROVAL'
-- (chybí UPDATE na 'SENT'/jiný stav v samotném approve() -- markAsSent() se volá SAMOSTATNĚ z Workflow.ts:119)

-- markAsSent(): zapisuje SENT
UPDATE procurement_purchase_orders SET status = 'SENT'
WHERE id = $1 AND status IN ('DRAFT','PENDING_APPROVAL','SENT')

-- updateStatus(): zapisuje ACCEPTED | SHIPPED | CANCELLED -- JINÁ osa, viz EVIDENCE níže
UPDATE procurement_purchase_orders SET status = $1 WHERE id = $2 AND tenant_id = $3
```

## EVIDENCE

1. **`CANCELLED` SE reálně zapisuje** (`cancel()` v repository) — moje první tvrzení "CANCELLED se nikde nezapisuje" bylo NESPRÁVNÉ, opraveno.
2. **`COMPLETED` se skutečně nikde nezapisuje** — 0 výskytů `SET status = 'COMPLETED'` v celém repository. Toto tvrzení zůstává platné.
3. **DB CHECK constraint neobsahuje `CANCELLED` ani `COMPLETED`**:
   ```sql
   CHECK (status IN ('DRAFT','PENDING_APPROVAL','SENT','PARTIALLY_RECEIVED','RECEIVED'))
   ```
   → **`cancel()` metoda tedy dnes prakticky VŽDY selže na constraint violation při reálném spuštění proti této migraci** — to je aktivní, netestovaný runtime bug, ne mrtvý kód. Žádný test tohle nezachytil (jediný status test v `ProcurementEngine.test.ts` ověřuje jen `PENDING_APPROVAL` po `createPlan()`, ne `cancel()` flow).
4. **`approve()` nezapisuje žádný status přechod sama** — jen ověřuje předpoklad. Skutečný přechod `PENDING_APPROVAL → SENT` dělá `markAsSent()`, volaná samostatně z `Workflow.approvePurchaseOrder()` (řádek 119) PO úspěšném `dispatchPurchaseOrder()`. Toto je funkčně v pořádku, ale znamená to, že "schválení" a "přechod stavu" jsou dva oddělené kroky spojené jen orchestrací ve `Workflow.ts`, ne atomicky v jedné transakci.
5. **`updateStatus(status: 'ACCEPTED'|'SHIPPED'|'CANCELLED')` píše do STEJNÉHO `status` sloupce jako `cancel()`/`markAsSent()`** — ale `ACCEPTED`/`SHIPPED` nejsou v DB CHECK constraintu ANI v TS union type `PurchaseOrder.status`. To je **třetí, zcela oddělená sada hodnot zapisovaná do jednoho sloupce** bez schématové ochrany. Tohle přímo podporuje Janovu hypotézu (C) — `status` má být rozdělen na nezávislé osy, protože dnes se do jednoho pole tlačí minimálně dvě různé věci: (a) interní PO lifecycle, (b) externí `SupplierStatusUpdate` echo (`ACCEPTED`/`SHIPPED` jsou hodnoty ze `SupplierStatusUpdate.status`, ports.ts:137).
6. **`PENDING_APPROVAL` jako počáteční stav potvrzen testem** (`ProcurementEngine.test.ts:36`) — `plan.purchaseOrders[0]?.status === 'PENDING_APPROVAL'` po `createPlan()` v manual-approval módu. Toto je jediný stav, co má i test, i kód, i (částečně) DB podporu.

## DATABASE
DB CHECK constraint nepovoluje `CANCELLED` ani `COMPLETED` — ale kód (`cancel()`) se **aktivně snaží** `CANCELLED` zapsat. Je to nekonzistence mezi schémou a repository kódem, ne jen mezi TS typem a schémou, jak jsem tvrdil napoprvé.

## CONCLUSION
- TypeScript union je širší než DB constraint (potvrzeno).
- **NENÍ pravda, že `CANCELLED` je čistě aspirační/mrtvá hodnota** — je aktivně zapisovaná kódem, ale write by měl podle DB constraintu spadnout. Tohle je buď (a) nikdy reálně nezavoláno v produkci, nebo (b) migrace v produkční DB je jiná/novější než `001_procurement_core.sql` v repu, nebo (c) je to čekající bug.
- `COMPLETED` zůstává potvrzeně mrtvá hodnota — nikde se nezapisuje.
- `updateStatus()` zapisuje TŘETÍ, nezávislou sadu hodnot (`ACCEPTED`/`SHIPPED`) do stejného sloupce — silný signál pro rozdělení na nezávislé osy (Janova hypotéza C).

## STATE MATRIX (metodika: TYPE → PORT → WORKFLOW → REPOSITORY → DB → READ MODEL → TESTS)

| Stav | Type | Port | Workflow | Repository (SQL) | DB constraint | Read model | Test | Verdikt |
|---|---|---|---|---|---|---|---|---|
| DRAFT | ✓ | — (implicitní default) | ✓ (`createPlan` produkuje) | — (nikdy explicitně SET, jen INSERT default) | ✓ | — | — | potvrzen jako počáteční stav |
| PENDING_APPROVAL | ✓ | `approve()` čte, nezapisuje | ✓ (`createPlan` v manual-approval módu) | `approve()` jen `SELECT ... WHERE status='PENDING_APPROVAL'`, nikde `SET status='PENDING_APPROVAL'` nalezeno | ✓ | ✓ (`DashboardEndpoint` SQL filtruje `WHERE po.status = 'PENDING_APPROVAL'`) | ✓ (`ProcurementEngine.test.ts:36`, `Workflow.test.ts` scénář 6 — ale **mockovaný port/DB**, ne reálný SQL běh) | **potvrzen v testu (mock), ale zápis do DB nikdy neověřen integračně** |
| SENT | ✓ | `markAsSent()` | ✓ | `UPDATE ... SET status='SENT' WHERE status IN ('DRAFT','PENDING_APPROVAL','SENT')` | ✓ | — | ✓ (mock) | potvrzen v kódu, DB zápis integrálně neověřen |
| PARTIALLY_RECEIVED | ✓ | `recordReceipt()` (přes `receive()`) | ✓ | **`recordReceipt()` NEZAPISUJE `status` vůbec** — jen `UPDATE ... SET received_quantity = LEAST(...)` na line-level. `ProcurementEngine.receive()` (core, statická metoda) PŘEPOČÍTÁVÁ `order.status = 'RECEIVED'\|'PARTIALLY_RECEIVED'` **jen na in-memory objektu** předaném volajícímu — nikde se tento přepočet neukládá zpět do DB | ✓ (constraint existuje, ale nikdy nedostane tuhle hodnotu k zápisu z tohoto flow) | — | ✓ (`ProcurementEngine.test.ts`, testuje jen in-memory výsledek) | **POTVRZENÝ BUG: stejná třída chyby jako dnešní okfish kupónový incident — výpočet je správný, zápis do trvalého úložiště chybí. `PurchaseOrder.status` v DB pravděpodobně zůstává `SENT` navěky po receive()** |
| RECEIVED | ✓ | `recordReceipt()` | ✓ | stejně jako výše | ✓ (nedosažitelné z tohoto flow) | — | ✓ (mock) | **stejný bug jako PARTIALLY_RECEIVED** |
| CANCELLED | ✓ | `cancel()` — PÍŠE | ✓ (`cancelPurchaseOrder`) | `UPDATE ... SET status='CANCELLED' WHERE status NOT IN ('RECEIVED','COMPLETED','CANCELLED')` — **aktivní SQL zápis existuje** | **✗ CHYBÍ v CHECK constraintu** | — | ✓ `Workflow.test.ts` scénář 4 — **mock, `purchaseOrders.cancel` je `vi.fn()`, žádný reálný SQL run** | **kód existuje a aktivně zapisuje, ale nikdy integrálně netestováno proti reálné DB → runtime constraint violation je nanejvýš pravděpodobná, ne jistá (produkční schéma může být jiné než repo) — STAV: aktivní podezření na bug, ne mrtvý kód** |
| COMPLETED | ✓ | — | — | 0 výskytů `SET status='COMPLETED'` v celém repu | ✗ chybí | — | — | **potvrzeno mrtvá/aspirační hodnota — žádná vrstva ji zapisuje** |
| ACCEPTED (jiná osa) | ✗ nemá v `PurchaseOrder.status` union | `updateStatus()` | — (nevoláno z `Workflow.ts` v prohlédnutém kódu) | `UPDATE ... SET status=$1` (generický, bez CHECK ochrany v kódu) | ✗ nepatří do `PurchaseOrder.status` typu ani CHECK | — | — | **zapisuje se do STEJNÉHO sloupce jako lifecycle, ale je to jiná sémantická osa (SupplierStatusUpdate echo) — silný důkaz pro rozdělení stavu (Janova hypotéza C)** |
| SHIPPED (jiná osa) | ✗ | `updateStatus()` | — | stejně jako ACCEPTED | ✗ | — | — | stejný verdikt jako ACCEPTED |

**Klíčová metodická poznámka**: VŠECHNY testy v `Workflow.test.ts` i `PostgresProcurementRepository.test.ts` mockují buď `PurchaseOrderPort` (Workflow testy), nebo přímo `db.transaction`/`tx.query` (Repository testy, `vi.fn().mockResolvedValue(...)`). **Žádný test v celém AIE repu neběží proti reálné PostgreSQL instanci s aktivním CHECK constraintem.** To znamená: SQL text v repository je čitelný a jeho logický konflikt s DB schématem je odvoditelný staticky (jak výše), ale samotný "runtime fails" verdikt u `CANCELLED` je **odvozený ze čtení kódu, ne pozorovaný v běhu**. Rozdíl je důležitý — je to potvrzené strukturální riziko, ne potvrzený incident.

## METODICKÁ POZNÁMKA K TESTOVÁNÍ (kritická pro NEXUS architekturu, ne jen pro tuhle entitu)
Repository testy (`PostgresProcurementRepository.test.ts`) **neprokazují kompatibilitu s databázovým schématem**. Mockují `db.transaction` i `tx.query`, takže validují pouze to, že repository zavolá očekávaný SQL příkaz se správnými parametry — **nevalidují, zda tento příkaz PostgreSQL skutečně přijme** (CHECK constraint, typy, FK). Stejně tak `Workflow.test.ts` mockuje celý `PurchaseOrderPort`, takže testuje jen orchestrační logiku, ne skutečnost.

**Důsledek pro NEXUS Core**: DB constrainty nejsou dokumentace, jsou součást runtime kontraktu Canonical Modelu. `core/state-machine/` a `tests/integration/` musí od začátku obsahovat integrační testy proti skutečné databázi (testcontainers/lokální Postgres/SQLite), ne jen mock-based unit testy — jinak se přesně tenhle typ bugu (výpočet správný v paměti, zápis do DB chybí/kolidující) bude opakovat nepozorovaně, jako se stalo tady u `RECEIVED`/`PARTIALLY_RECEIVED`/`CANCELLED`.

## CANONICAL DECISION
**PurchaseOrder lifecycle zatím NEUZAVÍRAT.**

Shrnutí nálezů, které to zdůvodňují:
1. `RECEIVED`/`PARTIALLY_RECEIVED` — vypočítáno správně v `ProcurementEngine.receive()`, ale nikdy zapsáno do DB (potvrzený bug, ne teoretický)
2. `CANCELLED` — aktivně zapisováno, ale DB CHECK constraint ho odmítá (strukturální riziko, runtime dopad neověřen integračně)
3. `COMPLETED` — potvrzeně mrtvá hodnota, nikde se nezapisuje
4. `ACCEPTED`/`SHIPPED` (`updateStatus()`) — zapisují se do STEJNÉHO sloupce jako lifecycle, ale jsou to hodnoty jiné sémantické osy (supplier echo) — podporuje Janovu hypotézu C (rozdělit na nezávislé osy)

## NEXT (podle Janova pořadí, se stavem po dnešním ověření)
1. ✅ Dohledat všechny transition funkce — HOTOVO (`cancel`, `approve`, `markAsSent`, `updateStatus`, vše v `PostgresProcurementRepository.ts`)
2. ✅ Dohledat všechny DB constraints — HOTOVO, ale **nutno ověřit, jestli produkční DB migrace odpovídá `001_procurement_core.sql` v repu** — pokud produkce běží na novější/ruční migraci, dnešní zjištění o "selhávajícím cancel()" může být neplatné
3. ✅ Dohledat všechny write paths — HOTOVO výše
4. ✅ Dohledat testy — HOTOVO, jen 1 relevantní assertion nalezena
5. ⏳ Dohledat PO API/adapter kontrakty — `PurchaseOrderPort`/`SupplierDispatchPort` zdokumentováno výše, ale nekontrolováno, jestli existuje HTTP/Worker endpoint, co tyhle metody vystavuje ven (mimo interní `Workflow.ts` volání)
6. Teprve potom definovat canonical lifecycle — **stále otevřeno**

## HYPOTÉZA K DALŠÍMU PROVĚŘENÍ (C — rozdělení na nezávislé osy)
Na základě zjištění č. 5 výše navrhuju, že rozdělení je pravděpodobně SPRÁVNĚJŠÍ řešení, ne jen jedna z možností:
```
PurchaseOrder
├── lifecycle        (DRAFT → PENDING_APPROVAL → SENT → PARTIALLY_RECEIVED → RECEIVED)  -- interní, Nexus-owned
├── cancellationState (ACTIVE | CANCELLED)                                                -- nezávislá, může nastat z jakéhokoli lifecycle stavu
├── supplierEcho      (dle SupplierStatusUpdate: ACCEPTED | SHIPPED | CANCELLED)          -- externí, dodavatelův pohled, jiná osa než cancellationState
└── receivingState    (odvozeno z PurchaseOrderItem.receivedQuantity agregace, ne vlastní pole)
```
Tohle by taky vyřešilo bod DB nekonzistence — `updateStatus()` by měl zapisovat do `supplierEcho`, ne do stejného sloupce jako `lifecycle`.

**Nerozhoduji o tomhle teď — čeká na tvé rozhodnutí po zbytku entity-by-entity auditu.**

## OPEN QUESTIONS
- Odpovídá produkční DB migrace `001_procurement_core.sql` v repu? (Nutno ověřit `wrangler d1` nebo přímý přístup, mimo scope tohoto READ-ONLY code auditu.)
- Byl `cancel()` flow vůbec někdy v produkci reálně zavolán? Pokud ne, je "bug" teoretický, ne aktivní incident.
- Existuje HTTP endpoint, co `cancelPurchaseOrder`/`approvePurchaseOrder` vystavuje mimo interní Workflow volání?
