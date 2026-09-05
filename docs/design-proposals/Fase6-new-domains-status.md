# Fáze 6: Nové domény — stav a otevřené otázky

Status: **PLACEHOLDER STAV, žádná implementace čeká na obchodní rozhodnutí.**

`docs/MIGRATION_PLAN.md` řádek 60-61 řadí do Fáze 6: Billing, Marketing, B2B,
Campaign, Creative. `docs/CANONICAL_MODEL_SYNTHESIS.md` §13 potvrzuje
"nula legacy kódu" pro všechny.

## Co bylo postaveno (typové kostry, žádná logika)

- `core/canonical/entities/Campaign.ts` — `Campaign`, `PromoGroup`,
  `CampaignPlacement`, `Creative`
- `core/canonical/entities/Invoice.ts` — `Invoice`
- `core/canonical/entities/Warehouse.ts` — `Warehouse`

Každý soubor obsahuje explicitní **OPEN QUESTIONS** sekci — otázky, které
vyžadují odpověď od Jana/Jose, ne domněnku.

## Co NEBYLO postaveno a proč

**Billing a Marketing jako domény, B2B jako dimenze** nemají v žádném
zdrojovém systému (Pricing Engine, SafeOrder, AIE, Omega, GOLIÁŠ) ani
jediný pojmenovaný koncept k odvození typové kostry od — na rozdíl od
Campaign/Invoice/Warehouse, které aspoň mají jméno a nějakou blízkou
analogii (Omega accounting document pro Invoice, Stock pro Warehouse).

Vymyslet konkrétní entity pro "Billing" nebo "Marketing" bez jediného
zdrojového vodítka by znamenalo domýšlet obchodní model — přesně to,
před čím varuje zkušenost s QuantityTier hypotézou (viz
`docs/design-proposals/QuantityTier-Hecmania.md`): tam alespoň existovala
pracovní hypotéza od Jose k otestování. Tady žádná není.

## Co by pomohlo, než se cokoliv dalšího napíše

1. **Billing**: Co přesně má tahle doména dělat? Fakturace je pokrytá
   (částečně) `Invoice.ts` výše — pokud "Billing" znamená totéž, netřeba
   nová doména. Pokud znamená subscription/SaaS billing (jako `TenantPlan`
   v `core/tenant/types.ts` — SafeOrder `tenant_plans` vzor), pak už
   částečný kontrakt existuje a stačí ho rozšířit, ne stavět novou doménu.
2. **Marketing**: Je to totéž jako Campaign/Creative výše, nebo něco jiného
   (email kampaně, retargeting, affiliate)? Bez odpovědi nelze rozlišit
   scope.
3. **B2B**: `docs/CANONICAL_MODEL_SYNTHESIS.md` řádek 133 zmiňuje otevřenou
   otázku "Má PriceList zůstat 1:1 s loyalty tier, nebo nezávislá dimenze
   (B2B)?" — to naznačuje, že B2B není samostatná doména, ale rozšíření
   `PriceList`/`TenantScopedTierConfig` (core/tenant/types.ts) o
   business-customer dimenzi. Vyžaduje rozhodnutí, ne novou stavbu.

## Doporučení

Nepokračovat v Fázi 6 dalšími kostrami, dokud nepadnou odpovědi na otázky
výše (a otevřené otázky v Campaign.ts/Invoice.ts/Warehouse.ts). Riziko:
každá další "kostra" postavená bez zdrojového vodítka by byla čistá
domněnka, kterou by později bylo nutné celou přepsat, ne jen doplnit.
