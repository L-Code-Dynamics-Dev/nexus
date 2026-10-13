# NEXUS — lokální administrace pravidel

Editor nyní ukládá návrhy na server do SQLite. Konfigurace má vlastní revize, audit autora a změn a je oddělená podle obchodu. Uložení přežije obnovení prohlížeče a restart serveru. Zápis proti staré revizi vrací konflikt a nepřepisuje novější změnu.

## Spuštění

Z `/workspace/nexus`, s Node.js 24 a nainstalovanými root závislostmi:

```bash
npm run admin:dev
```

Server naslouchá pouze na loopback rozhraní na portu 8790. V cloudovém onboarding prostředí nejsou podporované uživatelské webové náhledy; HTTP požadavky a testy zde slouží pro interní ověření. Zdravotní kontrola je `GET /health`.

`admin:build` vygeneruje inventář ze všech pěti sousedních checkoutů a přeloží server i jeho skutečné závislosti na cenovém enginu. Jiný nadřazený adresář lze určit pomocí `ADMIN_WORKSPACE`. Očekávané checkouty jsou `nexus`, `okfish-pricing-engine`, `pricing-engine-platform`, `tutani-barf-worker` a `safeorder-3.0`.

SQLite, WAL a SHM jsou standardně v ignorovaném adresáři `apps/admin/.state`. Nastavit lze `ADMIN_STATE_DIR` a `ADMIN_PORT`. Živé procesy je po obnovení cloudového prostředí třeba spustit znovu; uložená databáze je samostatná od procesů.

## Co funguje

- Serverové ukládání všech konfigurací a návrhů pravidel z inventáře, včetně obou cenových variant, SafeOrder, Tutani a domén NEXUSu.
- Monotónní revize, transakční kontrola souběhu, audit a načtení předchozí verze do návrhu.
- Serverová validace cenové politiky, kupónů, obchodní politiky SafeOrder a návrhového obalu pravidel; základní kontroly ostatních JSON datových sad. U ostatních sad jde o draft storage, nikoli o kompletní validaci jejich runtime schémat.
- Cenová simulace přes existující `createNexusPricingCalculator`, jeho Decimal aritmetiku a skutečně aplikovaná pravidla. Porovnává poslední uloženou konfiguraci s editovaným návrhem nad stejným produktem. Podporuje věrnostní slevy, produktové/brandové/kategoriální limity, vlastní akční cenu a syntézu akční ceny značky podle schopností tohoto konkrétního NEXUS řetězce.
- Izolované lokální obchody CZ a SK, podepsaná HttpOnly relace, ověření Host/Origin pro zápisy a žádný klientem dodávaný tenant. Relace je určena pro jednoho lokálního operátora; její podpisový klíč je náhodný pro každý běh a není ukládaný do repozitáře.

## Hranice této verze

Toto je lokální vývojová aplikace. Lokální relace není produkční identita uživatele a ukázkové obchody nejsou připojené skutečné e-shopy. Server nevystavujte veřejně. Víceuživatelské nasazení vyžaduje skutečné přihlášení, serverový registr členství a rolí, produkční persistentní storage a příslušné integrační adaptéry.

Uložení znamená **uložený návrh**, ne aktivaci v produkci. Kupóny, SafeOrder, BARF, sklad a další enginy mají zatím správu návrhů, nikoli připojené runtime konzumenty či simulace. Priorita, aktivace, podmínky a výjimky v univerzálním obalu pravidel se ukládají a validují, ale současné enginy tento nový obal ještě nevyhodnocují. Ve formuláři jsou tyto části označené.

Změna konfigurace prostřednictvím tohoto serveru nezapisuje ceny, zásoby ani objednávky do e-shopu, nedeployuje Workers a nemění konfigurace ostatních služeb. Cenová simulace ověřuje NEXUS výpočet, nikoli všechny legacy a Worker cenové cesty.

## API

| Operace | Význam |
| --- | --- |
| `GET /api/bootstrap` | Povolené lokální obchody a poslední uložené konfigurace |
| `GET /api/history?shop=<id>` | Posledních 100 verzí daného obchodu |
| `POST /api/validate` | Serverová kontrola návrhu |
| `POST /api/config` | Uložení nové revize; zastaralá revize vrací 409 |
| `POST /api/simulate/pricing` | NEXUS simulace uložené a navržené cenové politiky |

Zápisy mají tělo `{ shop, id, baseRevision, configuration }`. Simulace navíc přijímá `input` s kódem produktu a základní cenou jako desetinným řetězcem; další podporované vstupy definuje serverové schéma. Tenant je odvozen pouze ze serverového registru povolených obchodů. Neznámé sady či obchody, nepovolené klíče a nadměrné požadavky jsou odmítnuty. Stabilní identifikátory dokumentů jsou odvozené ze zdrojového souboru a typu konfigurace.

## Ověření

```bash
npm run admin:build
npm run admin:test
npm run build
npm test -- --maxWorkers=2
```

Testy zahrnují persistenci přes restart storage, izolaci obchodů i tenantů, konflikty revizí, invalidní konfiguraci, autorizační a origin kontroly a skutečný dopad změny slevy na cenu. Prohlížečové ověření dále prověřilo uložení a obnovení stránky, konflikt dvou otevřených editorů se zachováním návrhu, serverovou historii a porovnání ceny 96 → 75 při změně úrovně ZR4 ze 4 na 25 %.
