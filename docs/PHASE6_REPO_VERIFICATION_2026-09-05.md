# Příloha k dotazu na Jose — Fáze 6 (Billing/Marketing/B2B/Campaign/Creative)

Ověření repa `~/nexus` provedené 2026-09-05 (HEAD `bc1c6f0`) k šesti otázkám
poslaným Josemu. Účel: potvrdit, že repo skutečně neobsahuje odpovědi, ne že
jsme je jen nenašli — aby rozhodnutí šlo udělat na základě reálného stavu
kódu, ne domněnky o něm.

**Závěr předem:** repo obsahuje přesně tytéž otevřené otázky, jaké byly
poslány Josemu — často doslova stejnou formulací — ale žádnou odpověď.
Nic v kódu žádný z šesti bodů implicitně nerozhoduje.

---

## 1. Campaign / PromoGroup

`core/canonical/entities/Campaign.ts` — placeholder, "žádné obchodní
rozhodnutí" explicitně v hlavičce souboru. `PromoGroup` interface má jen
`name` + volitelný `memberProductSkus`. Otevřená otázka č. 1 v souboru:

> "Vztah PromoGroup <-> Product/PriceList: je PromoGroup nezávislá entita
> ..., nebo odvozená z existujícího PriceList konceptu?"

— slovo od slova stejná otázka jako poslaná Josemu. `docs/CANONICAL_MODEL_SYNTHESIS.md`
řádek 43: `PromoGroup/Campaign/Placement/Creative | NEEXISTUJE`.

## 2. Invoice

`core/canonical/entities/Invoice.ts` — placeholder. Tři OPEN QUESTIONS
v souboru odpovídají 1:1 struktuře dotazu:
1. 1:1 vs N:1 vůči Order — nerozhodnuto.
2. Vztah k Omega `CanonicalAccountingDocument` (`connectors/omega/legacy/core/CanonicalAccountingDocument.ts`)
   — tenhle typ existuje a má `documentType: 'INVOICE' | 'CREDIT_NOTE'`, ale
   komentář v `Invoice.ts` explicitně varuje: je to "EXPORT FORMÁT pro
   existující CanonicalAccountingDocument (Omega-side typ), ne Nexus
   canonical Invoice entita. Nezaměňovat." — tedy i kdyby se řeklo "ano,
   Omega je zdroj", pořád to vyžaduje rozhodnutí o mapování, ne automatické odvození.
3. Automatické vytvoření vs. manuální workflow — nerozhodnuto.

`docs/ARCHITECTURE_MAP.md` řádek 39: "Billing/fakturace domain (ISDOC,
číselné řady, VS, dobropisy) — 0 kódu nikde v portfoliu."

## 3. Warehouse / Supplier

`core/canonical/entities/Warehouse.ts` — placeholder, `isPhysical: boolean`
jediné pole navíc k identitě. Dvě OPEN QUESTIONS v souboru:
1. Vztah k `StockPosition` — rozšířit o `warehouseId`, nebo nezávislá dimenze?
2. Je Supplier totéž co Warehouse, nebo oddělené koncepty?

Ověřeno přímo v kódu: `core/canonical/entities/Stock.ts` (`StockPosition`)
dnes NEMÁ žádné `warehouseId` pole — jen `productId`/`variantId`/
`quantity`/`purchasable`/`canPreorder`/`inTransit`/`observedAt`. Napojení
by tedy vyžadovalo změnu existující entity, ne jen doplnění.

`Supplier` jako typ v celém repu neexistuje (grep na `interface Supplier`/
`class Supplier`/`type Supplier` — nulový výsledek). Jediná stopa je
`domains/procurement/SupplierSelectionRule.ts` (Rule, ne entita). Otázka
"je Supplier totéž co sklad" tedy nemá ani referenční bod v kódu, o který
by se dalo opřít.

## 4. Billing

Žádný soubor s tímto pojmenováním existuje jako doména (`domains/billing/`
je prázdný adresář — 0 souborů). `TenantPlan` existuje (`core/tenant/types.ts:57`,
pokrytý testem `tests/unit/TenantConfig.test.ts`), ale nic v repu ho
propojuje s fakturačním smyslem (bod 2) ani se subscription/SaaS smyslem —
je to čistě tenant-plán konfigurace (tiery/limity), ne platební záznam.
Rozhodnutí "co Billing znamená" tedy nejde odvodit ani z existující
`TenantPlan` struktury.

## 5. Marketing

`domains/marketing/` — prázdný adresář, 0 souborů. `docs/ARCHITECTURE_MAP.md`
řádek 42: "Marketing domain — 0 kódu nikde v portfoliu." Žádná stopa k
emailovým kampaním, retargetingu ani affiliate — pojem se v repu nikde
dál nerozvíjí mimo název adresáře.

## 6. B2B

`domains/b2b/` — prázdný adresář, 0 souborů. `docs/ARCHITECTURE_MAP.md`
řádek 41: "B2B nabídkový modul — 0 kódu nikde v portfoliu." `docs/CANONICAL_MODEL_SYNTHESIS.md`
řádek 133 (TBD sekce): "Má PriceList zůstat 1:1 s loyalty tier, nebo
nezávislá dimenze (B2B)?" — jediná zmínka B2B v celém repu, a je to
otevřená otázka, ne odpověď.

---

## Souhrnný nález

`docs/MIGRATION_PLAN.md` řádky 61-62 (Fáze 6+) to shrnuje explicitně za
všech pět oblastí najednou:

> "Čistě NEW BUILD. Žádný zdrojový systém neobsahuje kód k migraci.
> Postavit až po Fázi 0-5, na hotovém Canonical Model + Connector Layer —
> jinak vzniknou stejné hardcoded/single-tenant chyby, co řešíme u Pricing
> Engine dnes."

Repo si je tohoto stavu vědomo a sám sebe na to upozorňuje v hlavičkách
placeholder souborů ("žádné obchodní rozhodnutí", "nedomýšlet za obchodní
stranu") — nejde o mezeru, která by unikla pozornosti, je to vědomě
zaparkovaný stav čekající na přesně tohle rozhodnutí od Jose/Lucky.

**Doporučení:** nezakládat žádnou novou entitu ani neupravovat `Campaign.ts`/
`Invoice.ts`/`Warehouse.ts`/`Stock.ts` dokud nepadne odpověď na body 1–6.
Až se rozhodne, promítnout odpověď přímo do OPEN QUESTIONS sekcí v
příslušných souborech (nahradit komentář rozhodnutím s odkazem na tento
dokument nebo na zprávu, ve které padlo).
