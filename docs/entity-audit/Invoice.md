# ENTITY: Invoice

## STATUS: NEW BUILD / NO LEGACY CONTRACT
Toto NENÍ dokončený audit v tom smyslu jako Order/PurchaseOrder. Neexistuje TYPE→PORT→WORKFLOW→REPOSITORY→DB→READ MODEL řetězec k rekonstrukci — nulový výchozí bod. Nezaměňovat s "auditováno a v pořádku". Odloženo do samostatného specifikačního sezení s Janem (viz OPEN QUESTIONS níže) — nevrací se do fronty entity-by-entity auditu, dokud nebude Billing doména řešena jako celek.


## SOURCE SYSTEMS
- **Žádný zdrojový systém v portfoliu neobsahuje `interface Invoice` ani ekvivalentní datový model.** Ověřeno grepem napříč Pricing Engine, SafeOrder, AIE, omega-bridge — nula výskytů.
- Nejbližší příbuzný koncept: Omega `AccountingDocument`-like objekt (přesný název typu neznámý, ověřeno jen přes použití v `OmegaMapper.ts`) s poli `documentType: 'INVOICE' | jiné`, `sourceDocumentId`, `issueDate`, `customer.{ico,dic,name,street,city,zipCode}`, `currency`. Toto je **výstupní projekce pro R01/R02 export do KROS Omega**, ne plnohodnotný faktury model s lifecycle, platbami, dobropisy.
- Toto je **čistě NEW BUILD entita** (potvrzeno, ne předpokládáno) — přesně jak `MIGRATION_PLAN.md` už avizoval pro Billing doménu.

## PROČ TOHLE POTVRZUJE JANOVO UPOZORNĚNÍ
Jan správně upozornil, že `Invoice.status` nesmí být to samé jako `payment.status`/`delivery.status`/`accounting.status`. Protože **žádný existující kód tohle nikdy neřešil**, nemáme ani špatný/nekonzistentní vzor k opravě (jako u PurchaseOrder) — máme čistý list. To je jak příležitost (žádný dluh k rozmotání), tak riziko (žádná ověřená praxe, ze které by šlo vycházet — musí se navrhnout od nuly, bez domýšlení).

## IDENTITY
- TBD — zcela nenavrženo.

## EXTERNAL STATUS
- Nerelevantní stejným způsobem jako u Order — Invoice by měla být Nexus-owned (jako PurchaseOrder), ne zrcadlo externího systému, POKUD nejde o import existujících faktur z účetního systému (Omega/Pohoda) při onboardingu klienta — TBD, jestli tenhle scénář má nastat.

## NEXUS LIFECYCLE — ZCELA NEURČENO, ŽÁDNÝ ZDROJ K OVĚŘENÍ
Jan's zadání (master prompt §14) žádá:
- faktury, zálohové faktury, dobropisy, storna, číselné řady, variabilní symboly, splatnosti, měny, DPH, B2B/B2C, párování plateb, účetní export (ISDOC), PDF, hromadné vystavování, opravy, audit

Žádná z těchto vlastností nemá dnes jedinou implementaci nikde v portfoliu. Toto NENÍ auditovatelné proti existujícímu kódu — je to čistě specifikační práce, kterou je potřeba udělat SPOLEČNĚ s Janem (business pravidla účetnictví, ne něco, co lze odvodit z kódu).

## KLÍČOVÉ ROZLIŠENÍ K NAVRŽENÍ (Jan's upozornění, zapsáno jako otevřený problém, ne řešení)
Čtyři nezávislé osy, které se nesmí sloučit do jednoho `status` pole:
1. **Invoice lifecycle** (DRAFT → ISSUED → SENT → ... → PAID/CANCELLED?) — dokumentový stav samotné faktury
2. **Payment status** — zaplaceno/nezaplaceno/částečně, nezávislé na tom, jestli je faktura vystavená
3. **Delivery status** — dodáno/nedodáno zboží k té faktuře (relevantní pro zálohové faktury vystavené před dodáním)
4. **Accounting/ERP sync status** — jestli je faktura zaúčtovaná v Omega/Pohoda (viz Omega `SyncJob` state machine jako možný vzor PRO TUHLE osu konkrétně, ne pro celou Invoice)

Toto je přesně stejný typ chyby, jaké se PurchaseOrder vyhnula shodou okolností (nemá payment/delivery zapletené do jednoho pole) — u Invoice je riziko sloučení os vysoké, protože business jazyk ("stav faktury") svádí k jednomu poli.

## RECONCILIATION
- Omega straně: hash triáda (source/canonical/target payload) z `omega-bridge` je **přímo použitelný vzor** pro "opravdu se to zaúčtovalo v Omega tak, jak jsme poslali" — ale to řeší jen osu č. 4 výše, ne celou Invoice entitu.
- Párování plateb (bod §14) — žádný reconciliation vzor v portfoliu k tomuhle existuje. Nová práce.

## OPEN QUESTIONS (VŠECHNY, protože nic není ověřeno)
- Má Invoice čtyři oddělené status enumy (lifecycle/payment/delivery/accounting-sync), nebo jinou dekompozici?
- Vzniká Invoice v Nexusu, nebo se importuje z existujícího účetního systému klienta při onboardingu?
- Jak se řeší číselné řady/VS per-tenant (multi-tenant invariant, ale číslování faktur má often specifická legislativní pravidla per-country/per-VAT-registration)?
- ISDOC export — existuje nikde v portfoliu referenční implementace? (Odpověď dle gerpu: ne, 0 výskytů "ISDOC" v celém prohledaném stromu.)
- Vztah Invoice ↔ Order ↔ CreditNote — kardinalita (1 Order = 1 Invoice? Může být víc faktur na jednu objednávku — zálohová + finální?)

**Tahle entita potřebuje samostatné pracovní sezení s Janem k navržení Billing domény od nuly — audit proti kódu tady dosáhl svého limitu (nic k auditování).**
