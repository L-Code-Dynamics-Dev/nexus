# Validation Framework Contract

Survey existujících implementací (Omega Gate 1-5, SafeOrder 5-stage `INPUT/IDENTITY/SIGNAL/RISK_POLICY/...`, Pricing Engine Stage 1-5 `config-load/pre-write/regression/fail-closed/reconciliation`) potvrzuje: **tři nezávislé implementace téhož principu, s odlišným jmenováním stages a odlišným rozsahem.** Žádná se nekopíruje 1:1 — tento kontrakt je sjednocující nadstavba.

**Co Validation Framework NESMÍ**: definovat Canonical Model, měnit Entity taxonomy, vytvářet Entity kvůli validaci, obsahovat business logiku (patří do Rules), rozhodovat místo Decision vrstvy. Framework pouze bezpečně provádí a ověřuje průchod dat.

## Pět stages

```
INPUT -> PARSER -> CORE -> OUTPUT -> POST/OUTCOME
```

- **INPUT**: ověřuje použitelnost vstupu (soubor existuje, tenant/connector známý, batch má identitu, source fingerprint validní, duplicita). NEinterpretuje business význam.
- **PARSER**: převádí externí formát na strukturu pro Core (`externalId`, `price`, ...). NErozhoduje ("tento zákazník má dostat 22%" patří do Rules). Chybný řádek nesmí spadnout celý batch.
- **CORE**: propojuje Canonical Model + Rules + States + Decisions + Invariants. Deterministický (`CanonicalInput + RuleVersion + TenantConfig = Decision`). Nezapisuje přímo do externího systému.
- **OUTPUT**: transformuje Decision na externí formát (Expected Execution State → Shoptet CSV / ERP payload). Oddělené od execution — vygenerovaný výstup ≠ potvrzená změna.
- **POST/OUTCOME**: Expected → Execution → Actual → Reconciliation → Outcome. Neúspěch importu ≠ neúspěch business outcome (a naopak — úspěšný import ≠ úspěšný business outcome).

Viz `types.ts` pro `StageResult<T>` kontrakt a `errorIsolation.ts`/`retry.ts` pro §7-9.
