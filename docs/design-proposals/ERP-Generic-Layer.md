# Design Proposal: `connectors/erp-generic/` — obecná účetní (ERP) vrstva

Status: **NÁVRH K PROJEDNÁNÍ** — nic z tohoto dokumentu není implementováno.
Autor návrhu: průzkumný agent, zadání Lucky 2026-09-06.
Rozhodovací autorita: Lucky + Jose. Dokud návrh neschválí, `connectors/erp-generic/`
zůstává prázdný.

Účel: L-Code dnes nasazuje **tři účetní systémy** — KROS **Omega** (SK),
Stormware **Pohoda** (CZ), Solitea **Money S3** (CZ). V repu je naplněný jen
`connectors/omega/` (legacy port z `~/omega-bridge`) a adresář
`connectors/erp-generic/` je **prázdný** (ověřeno `ls -la`, 2026-09-06).
Tenhle dokument fixuje design vrstvy dřív, než vznikne první řádek kódu —
a hlavně **pojmenovává, kde ta abstrakce nefunguje**.

---

## 1. Současný stav v repu (ověřeno proti kódu)

### 1.1 Obecný kontrakt konektoru

`connectors/Connector.ts` je jediný obecný kontrakt v celém stromě konektorů.
Definuje:

- `ConnectorType = 'shoptet-csv' | 'shoptet-api' | 'shopify' | 'erp' | 'wms' | 'accounting'`
  — pozor: **`'erp'` i `'accounting'` už existují jako dvě samostatné hodnoty**,
  aniž by kdekoli bylo řečeno, čím se liší. To je první dluh (viz §6).
- `ConnectorCapabilities { canRead, canWrite, requiresApi }`
- `Connector<TExternal, TCanonical>` s `toCanonical()` / `toExternal()` —
  komentář explicitně říká: *„Adapter NIKDY nepočítá business hodnotu — jen
  překládá tvar dat."*
- `WritableConnector` s `write(canonical): Promise<{ externalReference?, error? }>`
  a `read(externalId)`. Zásadní věta v komentáři:
  *„Connector reportuje jen SENT, nikdy CONFIRMED — to potvrzuje až
  Reconciliation nad Actual External State."*

**Zjištění: tento kontrakt nikdo neimplementuje.** Grep přes celý strom
(`implements Connector`, `WritableConnector`, `ConnectorType`) nevrátil ani
jeden zásah mimo samotný `Connector.ts`. `connectors/omega/`,
`connectors/shoptet/`, `connectors/safeorder/` obsahují **výhradně**
podadresář `legacy/` a nikdo z nich se s `Connector.ts` nepotkává.

### 1.2 Účetní doklad dnes

`connectors/omega/legacy/core/CanonicalAccountingDocument.ts`:

```ts
export interface CanonicalAccountingDocument {
  sourceDocumentId: string;          // korelační ID
  documentType: 'INVOICE' | 'CREDIT_NOTE';
  issueDate: Date;
  currency: string;
  supplier: AccountingParty;         // id, name, ico?, dic?, street, city, zipCode, country
  customer: AccountingParty;
  lines: AccountingLineItem[];       // text, quantity, unitPriceWithoutTax, taxRate:number, taxAmount, totalWithTax
  summary: { totalWithoutTax; totalTax; totalWithTax };  // vše Decimal
}
```

Komentář v souboru tvrdí, že je *„completely detached from Shoptet structure"* —
to je pravda. **Není ale detached od Omegy.** Chybí v něm všechno, co Omega
neumí a co Pohoda i Money vyžadují nebo silně preferují: splatnost (`dueDate`),
variabilní symbol, číselná řada, způsob platby, bankovní účet, členění DPH
(`classificationVAT`), režim přenesené daňové povinnosti, skladová vazba
položky (kód zásoby), účet/středisko/činnost/zakázka. Viz §4.1.

Jde tedy o **nejmenší společný jmenovatel jednoho systému**, ne tří.

### 1.3 Jak se doklad dnes dostane ven (Omega řetěz)

Řetěz je: `CanonicalAccountingDocument[]` → `OmegaAdapter.process()` →
`OmegaMapper.map()` → Gate 4 (`OmegaOutputValidationGate`) →
`OmegaImportPayload` → agent → `OmegaExecutor.execute()` → Gate 5
(`OmegaPostImportValidationGate` nad `OmegaImportLogParser`).

Klíčové soubory a to, co v nich reálně je:

- **`connectors/omega/legacy/TargetAdapter.ts`** — obecnější, než vypadá jméno.
  `TargetPayload { content: string; encoding: string; payloadHash: string;
  documentCount; itemCount; correlationId }` a
  `ITargetAdapter<TDocument, TPayload>.process(documents, correlationId)`
  s výsledkem `'READY_FOR_DELIVERY' | 'OUTPUT_VALIDATION_FAILED' | 'SYSTEM_ERROR'`.
  **Tohle je nejlepší existující kandidát na základ erp-generic** — payload je
  už dnes neutrální `content: string` + `encoding`, což XML (Pohoda, Money)
  stejně dobře jako TSV (Omega). Jediné, co je Omega-specifické, je
  `OmegaImportPayload extends TargetPayload { omegaFormatVersion: string }`.
  Vadou je umístění (`connectors/omega/legacy/`) a jeden ošklivý import:
  `TargetAdapter.ts` importuje `ValidationResult` ze
  `connectors/shoptet/legacy/validation/types.js` — konektor závisí na jiném
  konektoru.

- **`connectors/omega/legacy/OmegaMapper.ts`** — generuje **TSV text**, ne XML:
  hlavička `R00\tL-CODE\tOMEGA_IMPORT`, pak `R01` (hlavička dokladu, 12 sloupců)
  a `R02` (položka, 8 sloupců), oddělovač TAB, konce řádků `\r\n`, desetinná
  čárka (`toFixed(2).replace('.', ',')`), datum `DD.MM.YYYY`, encoding
  **Windows-1250**. Typ dokladu se mapuje `INVOICE → 'OFA'`, jinak `'ODD'`.
  Poznámka: `content` začíná řetězcem označeným v kódu jako `// Mock header`.

- **`connectors/omega/legacy/agent/OmegaExecutor.ts`** — reálný
  `child_process.spawn` na Windows agentovi. Whitelist na **přesný basename
  `AkciaOmega.bat`** (ne suffix — explicitně zpřísněno proti
  `EvilAkciaOmega.bat`), `timeoutMs` (default 60s) → SIGTERM →
  `killGracePeriodMs` (5s) → SIGKILL, cap výstupu `maxOutputBytes` (1 MiB).
  Vrací `ExecutorResult { pid, exitCode, stdout, stderr, startTime, endTime,
  durationMs, logContent, error? }`, chybové kódy `SPAWN_FAILED`,
  `TIMEOUT_KILLED`. V hlavičce souboru je celý threat model (6 bodů) a
  varování: **„NEOVĚŘENO PROTI REÁLNÉMU WINDOWS AGENTOVI (2026-09-05)"** —
  testováno jen proti mock `echo`/`timeout` skriptům.

- **`connectors/omega/legacy/gate5/OmegaPostImportValidationGate.ts`** —
  jediné místo, kde se rozhoduje o výsledku. Výstup
  `'COMPLETED' | 'POST_IMPORT_VALIDATION_FAILED' | 'TARGET_RESULT_UNKNOWN' |
  'QUARANTINED'`. Pořadí kontrol: hash payloadu ověřený agentem → existence
  `executorResult` → `exitCode === 0` → log existuje → log neobsahuje chyby →
  počet dokladů sedí → každé očekávané ID je v logu potvrzené.
  **Cokoli nejasného končí `TARGET_RESULT_UNKNOWN`, nikdy „úspěch".**
  To je nejcennější vzor v celém konektoru a musí přežít do erp-generic.

- **`connectors/omega/legacy/gate5/OmegaImportLogParser.ts`** — parsuje log
  regexem `/Document:\s+(\S+)\s+SUCCESS/`, chyby detekuje přes
  `line.includes('ERROR') || line.includes('Chyba')`. Čistě textový, čistě
  Omega. `null` log → `'LOG_MISSING'`.

### 1.4 `domains/omega/`

Obsahuje `OmegaMapperRule.ts`, `OmegaValidationRules.ts`, `ValidatorRules.ts`,
`DecisionRules.ts` a `NOT_MIGRATED.md`. Poslední jmenovaný je důležitý —
dokumentuje, že `LCodePipelineOrchestrator` (E2E řetěz Gate 1→5) **vědomě
nebyl migrován**, protože je to konzument Rules, ne Rule. Stejně tak
`SyncJob.ts` (jen typy `JobState`/`SyncJob`/`SyncJobAnomaly`, už použité jako
vzor v `core/state-machine/StateMachine.ts`) a `PipelineAuditRecord.ts`.

Pozorování: `domains/omega/` je pojmenované po **dodavateli**, ne po doméně.
Ostatní domény jsou `domains/invoice/`, `domains/billing/`, `domains/pricing/` —
tam jméno popisuje business oblast. `domains/omega/` je jediná doména
pojmenovaná po konkrétním externím produktu, což je samo o sobě signál, že se
sem něco protlačilo z konektorové vrstvy. (Dluh, ne akce — viz §6.)

### 1.5 `core/canonical/entities/Invoice.ts` — pole `omegaDocumentId`

```ts
export interface Invoice extends CanonicalEntity {
    readonly orderId: EntityId;    // ROZHODNUTO: striktně 1:1, ne souhrnná faktura
    omegaDocumentId?: string;      // reference na Omega CanonicalAccountingDocument, NE kopie dat
    documentType: string;          // TBD
    issueDate: string;
    total: Money;
    status: InvoiceLifecycleState; // PENDING -> ISSUED -> CANCELLED
}
```

Hlavička souboru: **„ROZHODNUTO (Jose 2026-09-05)"**, lifecycle
`PENDING → ISSUED → CANCELLED`, obě koncové stavy terminální, s odůvodněním
*„NEXUS nevytváří účetní pravdu — Omega zůstává účetním zdrojem pravdy"*.

**Platí Non-Interference. Tento návrh na `Invoice.ts` nesahá.** Pojmenování
`omegaDocumentId` je pro tři systémy věcně špatné a je zaneseno jako **dluh
D-1 v §6**, ne jako navrhovaná změna.

Doplňující kontext z `docs/entity-audit/Invoice.md`: entita je označená jako
**NEW BUILD / NO LEGACY CONTRACT** a audit sám pojmenoval čtyři osy, které se
nesmí slít do jednoho `status`: invoice lifecycle / payment / delivery /
**accounting-ERP sync**. Ta čtvrtá osa je přesně to, co má vlastnit
erp-generic — a `Invoice.status` dnes tuhle osu **nemá** (má jen lifecycle).

### 1.6 Jak abstrakci řeší ostatní konektory — je vzor k následování?

Krátká odpověď: **není, kromě `TargetAdapter.ts`.**

- `connectors/shoptet/` = jen `legacy/{cart,csv,validation}` — žádná
  implementace `Connector.ts`. Přesto je `connectors/shoptet/legacy/validation/`
  de facto sdílená knihovna: `ValidationResult`, `createResult`, `addError`,
  `AbstractValidationGate`, `ValidationGate` odtud importuje i Omega
  (`OmegaPostImportValidationGate.ts:1-2`, `TargetAdapter.ts:1`).
  **To je nechtěná závislost napříč konektory** a druhý dluh (D-2, §6).
- `connectors/safeorder/` = 14 legacy podadresářů, vlastní svět, nulový
  průnik s `Connector.ts`.
- `docs/ARCHITECTURE_MAP.md` to potvrzuje černé na bílém v sekci „Co v žádném
  zdrojovém systému dnes NEEXISTUJE (nová stavba, ne migrace)":
  *„Jednotný Connector Layer (Shoptet V1 no-API + ERP generic) — existují jen
  fragmenty (GOLIÁŠ cart adapter, Omega CSV parser, AIE Shoptet read client),
  nikdy jako jedna abstrakce."*

Referenční vzor, na který se `Connector.ts` odvolává (`EcommercePlatformAdapter`
z `~/pricing-engine-platform`), **v tomhle repu není** — je jen citovaný
v komentáři.

---

## 2. Jak reálně fungují ty tři systémy

Rešerše externích zdrojů, 2026-09-06.

### 2.1 KROS Omega (SK)

- **Transport: žádný.** Import je **manuální přes GUI**: Firma → Import →
  Import z textového súboru → výběr souboru → Štart. KROS dokumentace
  neuvádí automatizaci příkazovou řádkou.
- **Formát: TXT**, řádky `R00` (typ údajů) / `R01` (hlavička dokladu) /
  `R02` (položka) — **přesně to, co generuje `OmegaMapper`.** Struktura je
  definovaná v XLS šablonách KROS (`ImportExport_28_00_2025.xls`,
  `typy_sum_2025.xlsx`), od roku 2025 je nová verze struktury.
- **Typy dokladů:** OFA (odoslaná faktúra), ODD (dobropis), preddavkové,
  storno, penalizačné faktúry, pohyby v sklade, partneri, skladové karty.
- **Výsledek:** není strojově čitelná odpověď. Existuje jen log/protokol.
- **Proto ten `.bat` agent.** `AkciaOmega.bat` je L-Code obcházení toho, že
  Omega nemá API — automatizuje GUI/dávkový import na Windows stroji.
  `OmegaExecutor` + Gate 5 nad logem je **náhražka za chybějící response**.
- Doplňkově: SEPA XML pro bankovní výpisy, Excel/XML pro některé agendy —
  pro fakturační směr irelevantní.

### 2.2 Stormware Pohoda — mServer (CZ)

- **Transport: HTTP(S), synchronní request/response.**
  - `POST http://<host>:<port>/xml` — jediný endpoint pro import i export.
  - `GET /status` — `<status>idle|working</status>`, bez autentizace;
    `GET /status?companyDetail` s autentizací.
  - `GET /documents/<cesta>` — stahování souborů z dokumentů firmy,
    podporuje `If-Modified-Since`.
- **Autentizace:** hlavička `STW-Authorization: Basic <base64(user:heslo)>`.
  **Jediná podporovaná metoda.** Volitelně `STW-Application` (identifikace
  v logu), `STW-Instance` (ID komunikace), `STW-Check-Duplicity`
  (server-side kontrola duplicit — pozor, to je *jiná* idempotence než
  Nexus `core/idempotency/`, viz §4.5).
- **Formát:** XML dle schémat Pohody (`dataPack` obálka + agendové namespacy),
  `Content-Type: text/xml`, charset **Windows-1250**. Odpověď
  `<rsp:responsePack version state="ok|…" programVersion ico>` —
  **strojově čitelný výsledek per doklad.**
- **Omezení:** zpracování je **sériové/synchronní** — souběžné požadavky se
  serializují. Timeout → HTTP 408. HTTP kódy: 200 / 401 (chybí nebo neplatná
  autentizace) / 403 (uživatel nemá práva na účetní jednotku) / 404 (chybná
  URL, typicky chybí `/xml`) / 500. Práva se nastavují v Pohodě:
  `Práva → Soubor → Datová komunikace` a `Práva → Administrátorské funkce →
  POHODA mServer`. Dokumentace neuvádí max. velikost payloadu ani limit
  paralelních požadavků.
- **Nasazení:** mServer běží na stroji s Pohodou, primárně LAN; přes internet
  jen HTTPS nebo VPN. **Pohoda musí být spuštěná.**
- **Alternativa bez mServeru:** klasická XML komunikace přes soubory
  (vstupní/výstupní adresář, XML import/export agenda v Pohodě). Stejné XML
  schéma, jiný transport, žádná synchronní odpověď — výsledek se čte
  z výstupního souboru. Tohle je fallback pro klienty bez mServeru
  (mServer je placený modul).

### 2.3 Solitea Money S3 (CZ)

Dvě různé cesty, **nesmí se plést**:

**(a) XML přenosy (XML DE)** — souborová výměna.
- XSD schémata v datové složce programu: `Data/XMLDE/Schemas`, ke stažení
  i jako ZIP z money.cz. Vzorové XML k dispozici.
- Agendy: adresa, kmenová karta, skladová zásoba, faktura, zakázka,
  objednávka, nabídka, poptávka, příjemka, výdejka, dodací list, prodejka,
  bankovní a pokladní doklad.
- **Automatizace přes parametry příkazové řádky** Money S3:
  `/e` spustí funkci (`/eXXXML` = XML export/import), `/p` heslo, `/a` agenda,
  `/r` rok, `/f` předání hodnot funkci. Při parametrickém spuštění program
  **přepisuje soubory bez dotazu**.
- Princip: *„Při importu má vždy přednost to, co je v XML."*
- Detailní reference: `money.cz/wp-content/uploads/2023/07/xml_prenosy.pdf`.

**(b) S3 API** — placený rozšiřující modul.
- Autentizace **Client ID + Client Secret**, generuje se v Money S3:
  Nástroje → S3Api → Klíče API. Každá třetí aplikace má vlastní klíč,
  volitelně navázaný na konkrétního uživatele Money (ten určuje scope).
- **Čtení je real-time, zápis je ASYNCHRONNÍ** — jde do fronty
  (Nástroje → S3Api → Fronta importu), kterou zpracovává **S3 Automatic**
  (úloha „S3Api – fronta XML importu"). Fronta ukazuje stav a chyby
  jednotlivých záznamů, jde ručně restartovat tlačítkem Importovat.
- Rozsah dat pevně definovaný. Při přidání nového roku je nutný **restart
  služby S3Api**.
- Konkrétní endpointy/protokol veřejná dokumentace neuvádí — odkazuje na
  `money.cz/navod/api-v-money-s3-pro-vyvojare/` a `api@money.cz`.
  **→ Před implementací je nutné si vyžádat technickou dokumentaci
  a testovací licenci. Neimplementovat na základě dohadů.**

### 2.4 Srovnávací tabulka

| | **Omega (KROS)** | **Pohoda (mServer)** | **Money S3 (API)** | **Money S3 (XML DE)** |
|---|---|---|---|---|
| Transport | lokální soubor + `.bat` na Windows | HTTP(S) POST | HTTP (spec neveřejná) | lokální soubor + CLI parametry |
| Formát | TSV `R00/R01/R02` | XML `dataPack` | XML (XSD Money) | XML (XSD Money) |
| Encoding | Windows-1250 | Windows-1250 | dle XSD | dle XSD |
| Autentizace | žádná (běží pod uživatelem) | `STW-Authorization: Basic` | Client ID + Secret | heslo přes `/p` |
| Odpověď | jen textový log | `<rsp:responsePack state>` synchronně | **asynchronní fronta** | výstupní soubor |
| Kdy víme výsledek | až po parsování logu | **v odpovědi na request** | **až po dotazu na frontu** | až po přečtení výstupu |
| Souběžnost | 1 běh `.bat` | serializováno serverem | fronta | 1 běh procesu |
| Server-side dedup | ne | `STW-Check-Duplicity` | fronta řeší po svém | ne |
| Vyžaduje běžící GUI aplikaci | **ano** | **ano** (Pohoda musí běžet) | ano (služba S3Api) | **ano** |
| Placený modul navíc | ne | **ano** (mServer) | **ano** (modul API) | XML DE / XML DE Profi |

---

## 3. Návrh abstrakce `connectors/erp-generic/`

### 3.1 Vůdčí princip

Abstrahovat **doménu účetního dokladu**, nikoli transport. Transport je
zaměnitelná strategie pod ní. A hlavně: **abstrakce nesmí předstírat, že
Omega umí to, co Pohoda.** Kde systém něco neumí, kontrakt to musí umět
*říct* (capability flag), ne to potichu spolknout.

Druhý princip, převzatý z `Connector.ts` a Gate 5: **konektor nikdy nehlásí
úspěch.** Hlásí, co se stalo. O `COMPLETED` rozhoduje reconciliace.

### 3.2 Navržené soubory

```
connectors/erp-generic/
├── AccountingDocument.ts        # rozšířený neutrální doklad (nadmnožina tří systémů)
├── AccountingConnector.ts       # hlavní port — co Core smí volat
├── AccountingCapabilities.ts    # co konkrétní systém UMÍ (klíčové!)
├── DeliveryTransport.ts         # transportní strategie (HTTP / process / file-drop)
├── DeliveryReceipt.ts           # co se vrátilo — bez interpretace
├── AccountingOutcome.ts         # interpretovaný výsledek (Gate 5 zobecněné)
└── AccountingSystemId.ts        # enum + registry
```

### 3.3 Identifikace systému

```ts
// AccountingSystemId.ts
export type AccountingSystemId =
    | 'kros-omega'
    | 'stormware-pohoda'
    | 'money-s3';
```

Řetězcová union, ne volný `string` — ale **hodnota se nikdy nesmí objevit
v `core/`** (`Connector.ts` §16: *„Core nesmí obsahovat if ERP === ..."*).
Slouží k výběru konektoru v registry a k audit trailu.

### 3.4 Capabilities — nejdůležitější část kontraktu

```ts
// AccountingCapabilities.ts
export interface AccountingCapabilities {
    /** Vrátí systém výsledek v rámci jednoho volání? Omega: false. Pohoda: true. Money API: false. */
    readonly synchronousResult: boolean;
    /** Umí systém strojově potvrdit doklad po doklad? Omega: false (jen log). */
    readonly perDocumentConfirmation: boolean;
    /** Umí systém vrátit stav už odeslaného dokladu na dotaz? */
    readonly canQueryDocumentState: boolean;
    /** Umí systém přijmout storno jako operaci? (Ani jeden ze tří pořádně — viz §4.4.) */
    readonly canCancelDocument: boolean;
    /** Umí systém přijmout/vrátit párování plateb? */
    readonly canReconcilePayments: boolean;
    /** Má systém vlastní ochranu proti duplicitám? Pohoda: STW-Check-Duplicity. */
    readonly hasServerSideDeduplication: boolean;
    /** Vyžaduje běžící desktop aplikaci na cílovém stroji? Všechny tři: true. */
    readonly requiresLiveDesktopSession: boolean;
    /** Maximální počet dokladů v jedné dávce, pokud je omezen. */
    readonly maxDocumentsPerBatch?: number;
}
```

Tohle je jádro návrhu. Bez capabilities by abstrakce lhala — a lhající
abstrakce je horší než tři samostatné konektory.

### 3.5 Hlavní port

```ts
// AccountingConnector.ts
export interface AccountingConnector {
    readonly systemId: AccountingSystemId;
    readonly mappingVersion: string;              // 'OMEGA-MAPPING-V1' vzor už existuje
    readonly capabilities: AccountingCapabilities;

    /** Neutrální doklad → payload cílového systému. ŽÁDNÁ business logika. */
    buildPayload(
        documents: AccountingDocument[],
        correlationId: string
    ): Promise<PayloadBuildResult>;

    /** Odeslání. Vrací DeliveryReceipt = surová evidence, NIKDY 'success: true'. */
    deliver(payload: TargetPayload): Promise<DeliveryReceipt>;

    /** Interpretace evidence → outcome. Zobecněná Gate 5. */
    interpret(
        receipt: DeliveryReceipt,
        expectedDocumentIds: string[]
    ): AccountingOutcome;

    /** Jen pokud capabilities.canQueryDocumentState. Jinak vyhodí NotSupported. */
    queryDocumentState?(externalDocumentId: string): Promise<AccountingOutcome>;
}
```

Rozdělení `deliver` / `interpret` je záměrné: `deliver` je I/O a smí selhat,
`interpret` je čistá funkce a je testovatelná bez ERP. Přesně tak je dnes
oddělený `OmegaExecutor` (I/O) od `OmegaPostImportValidationGate` (čistý).

### 3.6 Outcome — zobecněná Gate 5

```ts
// AccountingOutcome.ts
export type AccountingOutcomeStatus =
    | 'ACCEPTED'          // cílový systém potvrdil (Gate5 'COMPLETED')
    | 'REJECTED'          // cílový systém výslovně odmítl
    | 'PARTIAL'           // část dokladů prošla, část ne — Pohoda a Money to umí, Omega ne
    | 'PENDING_EXTERNAL'  // NOVÉ: přijato do fronty, výsledek zatím neznámý (Money S3 API)
    | 'UNKNOWN'           // nevíme, co se stalo (Gate5 'TARGET_RESULT_UNKNOWN')
    | 'QUARANTINED';      // porušená integrita, člověk to musí vidět

export interface AccountingOutcome {
    readonly status: AccountingOutcomeStatus;
    readonly confirmedDocumentIds: string[];
    readonly rejectedDocuments: { documentId: string; code: string; message: string }[];
    readonly rawEvidenceHash: string;   // odkaz na uloženou surovou evidenci
    readonly errors: string[];
}
```

`PENDING_EXTERNAL` je stav, který dnešní Omega Gate 5 **nemá a mít nemusí** —
Money S3 API ho ale potřebuje nutně, protože zápis je asynchronní přes frontu.
Bez něj by se Money muselo mapovat na `UNKNOWN`, což by zbytečně vyvolávalo
alerty na úplně normální průběh.

### 3.7 Transport — jak žít s `.bat` i s HTTP

```ts
// DeliveryTransport.ts
export type TransportKind = 'http-request' | 'local-process' | 'file-drop';

export interface DeliveryTransport {
    readonly kind: TransportKind;
    send(payload: TargetPayload): Promise<DeliveryReceipt>;
}
```

```ts
// DeliveryReceipt.ts — SUROVÁ evidence, žádná interpretace
export interface DeliveryReceipt {
    readonly transportKind: TransportKind;
    readonly correlationId: string;
    readonly payloadHash: string;
    readonly payloadHashVerified: boolean;
    readonly startedAt: Date;
    readonly finishedAt: Date;
    /** http-request: status kód a tělo odpovědi. */
    readonly http?: { statusCode: number; body: string; headers: Record<string, string> };
    /** local-process: dnešní ExecutorResult 1:1. */
    readonly process?: { pid: number; exitCode: number | null; stdout: string; stderr: string };
    /** file-drop / local-process: obsah logu nebo výstupního souboru. */
    readonly artifact?: { path: string; content: string | null };
    readonly transportError?: 'SPAWN_FAILED' | 'TIMEOUT_KILLED' | 'CONNECTION_FAILED'
                            | 'AUTH_FAILED' | 'HTTP_TIMEOUT' | 'FILE_NOT_WRITTEN';
}
```

Tři konkrétní transporty:

- **`LocalProcessTransport`** — dnešní `OmegaExecutor` beze změny chování:
  whitelist basename, timeout → SIGTERM → SIGKILL, cap výstupu. Jen se
  zparametrizuje `ALLOWED_EXECUTABLE_BASENAME` (dnes konstanta
  `'AkciaOmega.bat'`), aby šel použít i pro `Money.exe /eXXXML`.
  **Whitelist musí zůstat whitelistem** — konfigurovatelný, ale ne volný string
  z DB. Použije: Omega, Money S3 XML DE.
- **`HttpTransport`** — POST na mServer, hlavičky `STW-Authorization`,
  `STW-Application`, `STW-Instance`, `STW-Check-Duplicity`. Retry **jen** na
  408/5xx, nikdy na 401/403/404 (to jsou konfigurační chyby, retry je jen
  zhorší). Použije: Pohoda, Money S3 API.
- **`FileDropTransport`** — zapíše payload do vstupního adresáře, poll na
  výstupní soubor s timeoutem. Použije: Pohoda bez mServeru, Money S3 XML DE.

**Klíč k tomu, aby to nebyla falešná abstrakce:** transport vrací jen
`DeliveryReceipt` — surovou evidenci s union polí (`http?` / `process?` /
`artifact?`). Nikdy nepřevádí HTTP 200 na „exitCode 0". Tam, kde jsou systémy
tvarově nesouměřitelné, se to nesouměřitelné **ponechá** a interpretaci
udělá až konektor, který ví, co ta čísla znamenají.

### 3.8 Rozšířený `AccountingDocument`

Nadmnožina tří systémů, s explicitně volitelnými poli. Nadmnožinu volím
záměrně proti dnešnímu průniku — chybějící pole se v mapperu dá vynechat,
neexistující pole se doplnit nedá.

Přírůstky proti dnešnímu `CanonicalAccountingDocument`:

| Pole | Kdo to potřebuje | Poznámka |
|---|---|---|
| `dueDate` | Pohoda, Money | dnes chybí úplně |
| `variableSymbol` | Pohoda, Money | VS je v CZ povinná praxe |
| `numberSeries` / `documentNumber` | všechny | dnes se všude cpe `sourceDocumentId` |
| `paymentMethod` | Pohoda, Money | |
| `bankAccount` | Pohoda, Money | |
| `vatClassification` | Pohoda (`classificationVAT`) | tuzemsko / EU / mimo EU / PDP |
| `reverseCharge: boolean` | Pohoda, Money, Omega | přenesená daňová povinnost |
| `lines[].stockItemCode` | všechny (pokud skladová vazba) | |
| `lines[].unit` | Pohoda, Money | dnes chybí |
| `lines[].taxRate` | **rozšířit z `number`** | viz §4.2 |
| `costCentre` / `activity` / `contract` | Pohoda, Money, Omega | středisko/činnost/zakázka |
| `documentType` | **rozšířit z 2 hodnot** | viz §4.3 |

`supplier`/`customer`/`summary`/`currency`/`lines` zůstávají tvarově stejné.
`Decimal` všude (`core/canonical/entities/base.ts` konvence).

---

## 4. Kde abstrakce NEFUNGUJE a proč — číst dřív než §3

Tohle je nejdůležitější sekce dokumentu. Každý bod je místo, kde
„jednotné ERP rozhraní" buď někoho podvede, nebo se rozbije.

### 4.1 Omega nemá odpověď. Tečka.

Pohoda vrátí `<rsp:responsePack state="ok">` v odpovědi na request. Money
zapíše stav do fronty, kam se dá dotázat. **Omega vrátí textový log, který
`OmegaImportLogParser` parsuje regexem `/Document:\s+(\S+)\s+SUCCESS/` a
chyby hledá přes `line.includes('ERROR') || line.includes('Chyba')`.**

To znamená:
- „Potvrzení dokladu" je u Omegy **odvozené**, ne přijaté. Je to nejlepší
  odhad z textu, jehož formát nikdo negarantuje a který se může změnit
  s libovolnou verzí Omegy.
- Kdokoli bude číst `AccountingOutcome.status === 'ACCEPTED'`, dostane u
  Pohody tvrdý fakt a u Omegy interpretaci textu. **Stejná hodnota, jiná
  epistemická váha.**
- Navíc: hlavička `OmegaExecutor.ts` říká **„NEOVĚŘENO PROTI REÁLNÉMU
  WINDOWS AGENTOVI"** a *„skutečný formát stdout/log souboru z AkciaOmega.bat"*
  je mezi neověřenými věcmi. Ten regex je dnes napsaný proti odhadu.

**Návrh, jak s tím žít:** `AccountingOutcome` musí nést pole
`confirmationQuality: 'SYSTEM_CONFIRMED' | 'LOG_INFERRED'`. Ne kvůli logice —
kvůli tomu, aby operátor a reconciliace věděli, čemu věří. Kdo z toho udělá
jedno pole `ok: boolean`, ten tenhle rozdíl zahodí a jednou na to doplatí.

### 4.2 `taxRate: number` je časovaná bomba

Dnešní `AccountingLineItem.taxRate: number` a `OmegaMapper` řádek 60:
`line.taxRate.toString().padStart(2, '0')` → `'21'`, `'00'`.

Problémy:
- **CZ i SK mají různé sazby a mění se v čase.** SK 2025 zavedla nové sazby;
  CZ má 21/12/0. Pouhé číslo nerozliší „0 % osvobozeno" od „0 % mimo předmět
  daně" od „přenesená daňová povinnost". Účetně jsou to **tři různé věci** —
  Pohoda i Money je rozlišují (`classificationVAT`), Omega má typy súm.
- `padStart(2, '0')` **rozbije jakoukoli neceločíselnou sazbu** (`10.5`
  → `'10.5'`) a jakoukoli sazbu ≥ 100.
- Sazba je vlastnost **položky v čase vystavení**, ne konstanta.

**Návrh:** `taxRate` musí být `{ rate: Decimal; classification: VatClassification }`,
kde `VatClassification` je uzavřený enum mapovaný per systém.
**A tohle nesmí mapovat vývojář odhadem — musí to potvrdit účetní.**

### 4.3 `documentType: 'INVOICE' | 'CREDIT_NOTE'` nestačí ani jednomu ze tří

Omega sama umí OFA, ODD, **preddavkové faktúry, storno faktúry, penalizačné
faktúry**, pohyby v sklade. Pohoda i Money umí zálohové faktury, dobropisy,
opravné daňové doklady, proforma. `OmegaMapper` dnes dělá
`doc.documentType === 'INVOICE' ? 'OFA' : 'ODD'` — tedy **cokoli, co není
faktura, je dobropis**. Kdyby přišel jakýkoli třetí typ, tiše se z něj stane
dobropis. To není edge case, to je datová koroze.

`docs/entity-audit/Invoice.md` má tuhle otázku otevřenou dodnes
(*„Invoice vs credit note rozlišení — nerozhodnuto"*), stejně jako
`Invoice.ts` (`documentType: string` s komentářem TBD).

**Návrh:** enum `AccountingDocumentType` musí vzniknout **jako business
rozhodnutí s účetní**, ne jako technický překlad. A mapper musí na neznámý
typ **selhat**, ne fallbacknout.

### 4.4 Storno není operace. Je to nový doklad.

Zadání se ptá na storno jako na součást abstrakce. Účetně to takhle nefunguje:
**vystavený daňový doklad se nemaže.** Storno/oprava = **nový doklad
s opačným znaménkem**, navázaný na původní.

Důsledky:
- `cancelDocument(id)` v generickém rozhraní by byla **lživá metoda** —
  navádí na operaci, která neexistuje.
- `Invoice.ts` s tím už počítá správně: `CANCELLED` je terminální stav
  *Nexus reprezentace*, nikoli pokyn ERP systému. A hlavička říká
  *„NEXUS nevytváří účetní pravdu"*.
- Ani Omega, ani Pohoda, ani Money nemají spolehlivé „zruš tenhle doklad"
  přes import. Omega storno faktúry je vlastní typ dokladu.

**Návrh: `AccountingConnector` NEMÁ metodu `cancel()`.** Storno se řeší jako
**další `AccountingDocument`** typu `CANCELLATION` / `CREDIT_NOTE`
s `relatedDocumentId`. `capabilities.canCancelDocument` je proto u všech tří
systémů `false` a slouží jen jako explicitní dokumentace toho, že to takhle
nejde.

### 4.5 Idempotence se u tří systémů řeší na třech různých místech

- **Pohoda:** `STW-Check-Duplicity` — dedup dělá **server**.
- **Money S3 API:** fronta má vlastní chování při opakovaném zápisu
  (nezdokumentované veřejně).
- **Omega:** **nic.** Pustit `AkciaOmega.bat` dvakrát = dvakrát naimportovaný
  doklad. `OmegaExecutor.ts` to v threat modelu bod 6 přiznává a explicitně
  vyhazuje mimo scope: *„Souběžné spuštění stejného jobu dvakrát (retry race)
  → MIMO SCOPE TÉTO TŘÍDY — řeší AgentWorker/DeliveryJob úroveň"*.

To znamená, že **retry politika nemůže být vlastnost generické vrstvy.**
U Pohody je slepý retry po timeoutu relativně bezpečný (server dedupuje).
U Omegy je slepý retry po `TIMEOUT_KILLED` **cestou k duplicitní faktuře
v účetnictví** — protože `.bat` mohl doběhnout a jen se nestihl vrátit.

**Návrh:** `AccountingCapabilities.hasServerSideDeduplication` řídí, jestli
retry vůbec smí být automatický. Kde je `false`, jde `UNKNOWN` **vždy na
člověka**, nikdy do automatického retry. Nexus `core/idempotency/` řeší
Nexus stranu; ERP stranu neřeší nikdo a předstírat opak je nebezpečné.

### 4.6 „Párování plateb" je čtení, ne zápis — a jde proti směru toku

Celý dnešní řetěz je **jednosměrný ven**: Nexus → payload → ERP. Párování
plateb je opačný směr: banka → ERP → Nexus. K tomu je potřeba **číst** stav
z ERP.

- Pohoda: čtení jde (`POST /xml` s exportním dotazem).
- Money S3 API: čtení je real-time — jediný z trojice, kde je to elegantní.
- **Omega: čtení prakticky nejde.** Není API, `.bat` agent je jednosměrný
  import. Šlo by jen přes exportní soubor generovaný ručně nebo přes další
  `.bat`.

Přidat `readPayments()` do společného rozhraní by znamenalo, že u jedné
třetiny nasazení metoda z principu nefunguje.

**Návrh:** párování plateb **není v erp-generic v první iteraci vůbec.**
Až se bude řešit, patří do samostatného portu `AccountingReadPort`, který
implementují jen systémy s `capabilities.canQueryDocumentState === true`.
Pozn.: `docs/entity-audit/Invoice.md` výslovně píše, že pro párování plateb
*„žádný reconciliation vzor v portfoliu neexistuje. Nová práce."*

### 4.7 Encoding a formát čísel jsou past

Windows-1250 (Omega i Pohoda), desetinná **čárka** u Omegy
(`toFixed(2).replace('.', ',')`), datum `DD.MM.YYYY`, řádky `\r\n`,
TAB jako oddělovač. XML u Pohody má vlastní escapování a Money má vlastní XSD.

`OmegaMapper.sanitizeString()` dnes maže taby a nové řádky a ořezává délku
(`name` na 100, `line.text` na 200). **Tichý ořez.** V TSV je to nutnost
(tab = oddělovač), v XML je to zbytečná ztráta dat.

**Návrh:** sanitizace a délkové limity patří **do konkrétního mapperu**, ne do
generické vrstvy. Generický `AccountingDocument` nese plná data. A **tichý ořez
musí zmizet** — buď se ořízne s auditním záznamem, nebo se doklad odmítne.
Dnes se faktura s dlouhým názvem firmy tiše zkomolí a nikdo se to nedozví.

### 4.8 Všechny tři vyžadují běžící desktop aplikaci na Windows

Nejméně technický, provozně nejdražší bod. Pohoda musí běžet, aby mServer
odpovídal. Omega musí být nainstalovaná pro `.bat`. Money S3 potřebuje
běžící službu S3Api a případně S3 Automatic.

Znamená to, že **„ERP konektor" v Nexusu není síťová služba** — je to
koordinace se strojem u klienta. `capabilities.requiresLiveDesktopSession`
je proto `true` u všech tří a monitoring musí sledovat dostupnost stroje,
ne jen návratové kódy. Pro Pohodu je `GET /status` levný healthcheck;
pro Omegu ekvivalent **neexistuje** — zjistíme to až selháním importu.

### 4.9 Money S3 API je zatím neznámá

Veřejná dokumentace neuvádí protokol ani endpointy — jen že existuje Client
ID/Secret a asynchronní fronta. **Návrh konektoru pro Money S3 je proto
podmíněný** získáním technické dokumentace (`api@money.cz`) a testovací
licence. Dokud ji nemáme, jediná bezpečně implementovatelná cesta pro Money
je **XML DE přes `file-drop` / CLI parametry**, ne API.

---

## 5. Migrace: co s dnešním Omega konektorem

Non-Interference: `connectors/omega/legacy/` je funkční, otestovaný port.
**Návrh na něj nesahá.**

Navrhovaný postup je **paralelní, ne přepisovací**:

1. `connectors/erp-generic/` vznikne jako **nové rozhraní bez implementace** —
   čisté typy, žádné I/O, žádná změna existujícího chování.
2. Vznikne **tenký `OmegaAccountingConnector`**, který `AccountingConnector`
   implementuje a **deleguje** na dnešní `OmegaAdapter` / `OmegaExecutor` /
   `OmegaPostImportValidationGate`. Adapter pattern, ne přepis.
3. Existující Omega řetěz zůstává volatelný přímo, dokud nový nedoběhne
   ověřením na reálném Windows agentovi (což ještě neproběhlo — viz §1.3).
4. Teprve pak vznikne Pohoda konektor **jako první nativní uživatel** nové
   vrstvy. Pohoda je správný první test, protože je transportně nejdál od
   Omegy (HTTP + synchronní odpověď vs. `.bat` + log) — když abstrakce
   unese tenhle rozdíl, unese i Money.

---

## 6. Dluhy k projednání (NEMĚNIT bez schválení)

**D-1 — `Invoice.omegaDocumentId` (Josovo rozhodnutí, Fáze 6.1).**
Pole je pojmenované po jednom ze tří dodavatelů. Pro klienta na Pohodě bude
`Invoice.omegaDocumentId` obsahovat ID Pohoda dokladu, což je matoucí
v kódu, v DB, v logu i v supportu.

Navrhované (NEPROVEDENO, k projednání s Josem):
```ts
readonly accountingSystem?: AccountingSystemId;   // 'kros-omega' | 'stormware-pohoda' | 'money-s3'
readonly accountingDocumentId?: string;           // dnešní omegaDocumentId
```
Zdůvodnění: `Invoice.ts` sám v komentáři říká *„Omega zůstává účetním zdrojem
pravdy"* — to je pravda pro dnešní klienty, ale zdroj pravdy je obecně
**účetní systém tenanta**, ne konkrétně Omega. Dvojice pole navíc řeší to, co
samotné přejmenování neřeší: **bez `accountingSystem` není `accountingDocumentId`
interpretovatelné** (stejný string může být Omega evidenční číslo i Pohoda ID).

**Dopad změny:** `core/canonical/entities/Invoice.ts`,
`domains/invoice/InvoiceLifecycleRule.ts`,
`domains/invoice/OrderInvoiceOmegaFlow.ts` (samo jméno souboru obsahuje
„Omega"). Není to kosmetika — je to změna kontraktu entity.
**Rozhoduje Jose. Do té doby zůstává `omegaDocumentId`.**

**D-2 — `ConnectorType` má `'erp'` i `'accounting'`.**
`connectors/Connector.ts:11`. Nikde není definováno, čím se liší.
Před vznikem erp-generic je potřeba to rozhodnout, jinak vzniknou dva
paralelní světy. Návrh: `'accounting'` pro účetní systémy (Omega/Pohoda/Money),
`'erp'` zrušit nebo rezervovat pro skladové/ERP systémy jiného typu.

**D-3 — `connectors/omega/legacy/TargetAdapter.ts:1` importuje z
`connectors/shoptet/legacy/validation/types.js`.**
Konektor závisí na jiném konektoru. `ValidationResult` / `createResult` /
`addError` / `AbstractValidationGate` jsou de facto sdílená infrastruktura a
patří do `core/validation/` (ten adresář existuje). Totéž
`OmegaPostImportValidationGate.ts:1-2`. Bez narovnání zdědí erp-generic
závislost na Shoptetu, což je absurdní.

**D-4 — `domains/omega/` je pojmenovaná po dodavateli.**
Jediná doména pojmenovaná po externím produktu. Kandidát na `domains/accounting/`,
až se bude řešit doména jako celek. Nízká priorita, ale zaznamenáno.

**D-5 — `Invoice.status` nemá ERP-sync osu.**
`docs/entity-audit/Invoice.md` explicitně varuje před slitím čtyř os
(lifecycle / payment / delivery / **accounting-sync**). Dnešní
`InvoiceLifecycleState = 'PENDING' | 'ISSUED' | 'CANCELLED'` pokrývá jen
lifecycle. Kam se zapíše `AccountingOutcome` (ACCEPTED / UNKNOWN /
QUARANTINED), dnes **nemá místo**. Bez rozhodnutí Josa hrozí, že to někdo
nacpe do `Invoice.status` — přesně chyba, před kterou audit varuje.

**D-6 — `OmegaMapper` má `// Mock header` a tichý ořez řetězců.**
`OmegaMapper.ts:27` (`'R00\tL-CODE\tOMEGA_IMPORT'` označeno v kódu jako mock)
a `sanitizeString()` s tichým `substring()`. Před ostrým během musí být
ověřeno proti KROS šabloně `ImportExport_28_00_2025.xls` (struktura se navíc
od roku 2025 změnila).

**D-7 — celý Omega write-path je neověřený proti reálnému stroji.**
Hlavička `OmegaExecutor.ts` to říká sama. Platí dodnes. Jakékoli rozšiřování
na další systémy by mělo počkat, až první systém projde reálným během —
jinak se replikuje neověřený vzor třikrát.

---

## 7. Doporučené pořadí prací

| # | Krok | Blokuje | Výstup |
|---|---|---|---|
| 0 | **Schválit tenhle dokument** (Lucky + Jose), rozhodnout D-1, D-2, D-5 | vše | rozhodnutí zapsaná sem |
| 1 | Ověřit `OmegaExecutor` + `OmegaImportLogParser` proti **reálnému** Windows agentovi a skutečnému logu z `AkciaOmega.bat` (D-7, D-6) | 3, 4 | opravený parser + potvrzený formát logu |
| 2 | Vyžádat od Money technickou dokumentaci S3 API + testovací licenci (`api@money.cz`), rozhodnout API vs. XML DE (§4.9) | 6 | odpověď od Solitea |
| 3 | Napsat **jen typy** `connectors/erp-generic/` (§3.2), nulové I/O, nulová změna chování | 4 | 7 souborů, kompiluje se, nic nevolá |
| 4 | `OmegaAccountingConnector` jako **delegující adaptér** nad dnešním řetězem (§5.2), paralelně vedle existující cesty | 5 | Omega jede přes nové rozhraní, staré funguje dál |
| 5 | **Pohoda konektor** — `HttpTransport` + XML mapper + parser `responsePack`. První nativní uživatel vrstvy, největší transportní rozdíl (§5.4) | — | ověřená abstrakce, nebo důkaz že je špatná |
| 6 | Money S3 podle výsledku kroku 2 (`file-drop` XML DE, nebo API + `PENDING_EXTERNAL`) | — | třetí systém |
| 7 | Narovnat D-3 (`core/validation/`), pak D-4 | — | čistý strom závislostí |
| 8 | `AccountingReadPort` (párování plateb, §4.6) — **samostatné zadání**, ne součást téhle vrstvy | — | — |

Kroky 1 a 2 běží nezávisle a **musí být hotové dřív** než 4 a 6.
Krok 3 jde dělat okamžitě po schválení — je bezrizikový.

Pravidlo pro krok 5: **jestli Pohoda konektor vyžaduje ohnutí `AccountingConnector`
rozhraní, je rozhraní špatně navržené a vrací se sem, ne do kódu.**

---

## 8. Otevřené otázky pro Lucky/Jose

1. **D-1** — přejmenovat `omegaDocumentId` → `accountingDocumentId` +
   `accountingSystem`? (Josovo rozhodnutí Fáze 6.1.)
2. **D-5** — kam patří ERP-sync stav? Nové pole na `Invoice`, nebo samostatná
   entita `AccountingSyncJob` (vzor: `SyncJob`/`JobState` z `domains/omega/NOT_MIGRATED.md`)?
3. **§4.2/§4.3** — kdo (jaká účetní) potvrdí mapování `VatClassification`
   a `AccountingDocumentType` pro CZ i SK? Bez toho se ta pole navrhnout nedají.
4. **§4.5** — souhlas s pravidlem *„kde není server-side dedup, jde `UNKNOWN`
   vždy na člověka, nikdy do auto-retry"*?
5. **§4.6** — potvrzujeme, že párování plateb je mimo scope první iterace?
6. Je **Pohoda** skutečně druhý systém v pořadí, nebo tlačí termín u Money S3?
   (Návrh volí Pohodu z technických důvodů; obchodní priorita může být jiná.)

---

## Zdroje

- [POHODA mServer — pro vývojáře (Stormware)](https://www.stormware.cz/pohoda/xml/mserver/provyvojare/)
- [POHODA XML API komunikace](https://www.stormware.cz/pohoda/xml/)
- [Money S3 — API v Money S3](https://money.cz/navod/api-v-money-s3/)
- [Money S3 — XML přenosy, informace pro vývojáře (XSD)](https://money.cz/navod/s3xmlde/)
- [Money S3 — XML přenosy, PDF reference](https://money.cz/wp-content/uploads/2023/07/xml_prenosy.pdf)
- [KROS OMEGA — import a export údajov pre doklady od roku 2025](https://akademia.kros.sk/faq/podvojne-uctovnictvo/import-a-export-udajov-z-ineho-softveru-pre-doklady-od-roku-2025/)
- [KROS OMEGA — importy a exporty dát](https://www.kros.sk/omega/funkcie/importy-exporty/)
