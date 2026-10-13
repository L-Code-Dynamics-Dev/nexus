# Anastázie / NEXUS — přesné schopnosti adminu odvozené z kódu

Tato revize respektuje instrukci uživatele určit rozsah **z kódu**, bez čekání na původní klientské zadání. Předchozí analytické hypotézy založené na auditních dokumentech nejsou použité jako potvrzení hotových schopností.

## Závěr

Admin má pokrýt **konkrétní operace, jejich skutečné vstupy, omezení a výsledky** pro každý aktivní modul. Obecný seznam enginů ani univerzální JSON editor nestačí. V kódu jsou existující desktopové úkony, HTTP handlery, doménové funkce, storage porty, datové konfigurace a ukázkové implementace; tyto kategorie mají rozdílnou připravenost pro obsluhu.

Níže je 95 konkrétních požadavků na ovládání platformy. To není tvrzení, že provozovatelka Anastázie musí denně obsluhovat sklad či BARF: aktivace modulu a přidělená role určují, které z těchto schopností její admin nabízí. Podklady pro samotné audio-commerce a rezervace v aktuálním kódu chybějí; to je implementační mezera, nikoli důvod z těchto funkcí dělat už hotové obrazovky.

## Co bylo přečteno a jak

Statická analýza prošla 536 autorských TS/TSX/JS souborů (73683 řádků), 695 rozhraní a 580 metod. Vytěžila deklarace, pole, typy, validační schémata, použití vstupů, route větve, role a Electron IPC. Dále byly přímo posouzené konkrétní rozhodovací a zapisující implementace: desktop policyManager/resolveProductLimits/save-policies; Worker sync/reconciliation/coupon configuration; SafeOrder role guards/admin/config/privacy/audit repository; Tutani knowledge/tenant/store; NEXUS cenový řetězec, kampaně/lifecycle, vouchers/storage/audit, dostupnost/procurement a účetní rozhodování.

Strojový inventář s hashy a řádky je v [CODE_INVENTORY.json](CODE_INVENTORY.json), každé deklarované pole v [CODE_FIELDS.csv](CODE_FIELDS.csv) a routy/role/IPC v [CODE_ROUTES_AND_ROLES.md](CODE_ROUTES_AND_ROLES.md). Analýza nevykonává handlery, neprovádí žádný externí zápis a nečte credential files. Testy, binární/fontové assety a generované závislosti jsou mimo business inventory; rozsah je explicitně v JSON. Nalezených 82 route entries není 82 admin endpointů — zahrnují veřejné a integrační routy i prefixy.

## Zkoumané verze

- `nexus`: `df83463494892a91eff5fe861d66b380c25b7f3d`.
- `okfish-pricing-engine`: `ec68ec4b183549a6a911062455d3d83ae1783aef`.
- `pricing-engine-platform`: `465f5393e9fa8f0e2ba363c653d52e046d8e8448`.
- `safeorder-3.0`: `ce146558b1cbf267eb98664efb0363a05d22e0bb`.
- `tutani-barf-worker`: `8b5c15f65e1c1a4df21c789bba61a0dc1a68ae30`.

## Stavové kategorie

- **API:** skutečný routovaný handler existuje ve zdroji; dostupnost nasazení a jeho současná oprávnění tím nejsou ověřené.
- **DESKTOP:** existuje operace Electron IPC / její zapisující helper; přenos do webového adminu potřebuje adaptér.
- **STORE:** existuje perzistenční implementace/kontrakt; veřejné admin API nemusí existovat.
- **DOMAIN:** existuje výpočet nebo stavový průchod; persistence a UI/API mohou chybět.
- **DATA:** existuje načítaná konfigurační/znalostní sada; neimplikuje dynamickou editaci běžící služby.
- **CODE:** parametr je dnes pevný v kódu; změna z adminu vyžaduje explicitní runtime konfiguraci.
- **MODEL:** typ/kontrakt existuje, ale nelze z něj odvodit hotový zapisující workflow.
- **PORTS:** orchestrátor závisí na integračních portech; jejich funkční nasazení není doložené.
- **DEMO:** ukázková in-memory implementace/seed; neděláme z ní autoritativní klientská data.
- **APP:** náš lokální server má funkční správu draftů či NEXUS simulaci. Nejde o aktivaci v produkčním modulu.

## Matice konkrétních operací

[Celá CSV matice](ADMIN_CODE_REQUIREMENTS.csv) obsahuje u každé položky pole, readonly výsledek, stav, soubor, symbol, řádek, omezení a oprávnění.

| ID | Oblast | Co admin musí nabídnout, pokud je modul aktivní | Stav | Přímý zdroj |
| --- | --- | --- | --- | --- |
| CODE-001 | Ceny | Spravovat věrnostní úrovně | DATA | `okfish-pricing-engine/src/core/EngineBuilder.ts:10` / `PolicySchema` |
| CODE-002 | Ceny | Spravovat obratová pásma a vazby úrovní | CODE | `okfish-pricing-engine/src/core/config.ts:13` / `LOYALTY_TIERS` |
| CODE-003 | Ceny | Nastavovat značkové limity | DESKTOP | `okfish-pricing-engine/desktop-app/lib/policyManager.js:70` / `saveBrandLimits` |
| CODE-004 | Ceny | Nastavovat celoroční akční slevy značek | DESKTOP | `okfish-pricing-engine/desktop-app/lib/policyManager.js:76` / `saveBrandSaleDiscounts` |
| CODE-005 | Ceny | Nastavovat limity podle kategorie | DESKTOP | `okfish-pricing-engine/desktop-app/lib/policyManager.js:82` / `saveCategoryLimits` |
| CODE-006 | Ceny | Nastavovat individuální produktové stropy | DESKTOP | `okfish-pricing-engine/desktop-app/lib/policyManager.js:88` / `saveProductOverrides` |
| CODE-007 | Ceny | Zařazovat produkty bez slevy | DESKTOP | `okfish-pricing-engine/desktop-app/lib/policyManager.js:92` / `saveZeroDiscount` |
| CODE-008 | Ceny | Nastavovat a plánovat výprodej | DESKTOP | `okfish-pricing-engine/desktop-app/lib/resolveProductLimits.js:14` / `resolveClearancePct` |
| CODE-009 | Ceny | Zobrazit výsledek složení všech produktových pravidel | DOMAIN | `okfish-pricing-engine/desktop-app/lib/resolveProductLimits.js:48` / `resolveProductLimits` |
| CODE-010 | Ceny | Simulovat cenu a vysvětlit pravidla | APP | `nexus/apps/admin/service.ts:336` / `simulate` |
| CODE-011 | Ceny | Spravovat pravidlo zaokrouhlení jako pokročilé nastavení | CODE | `okfish-pricing-engine/src/policies/RoundingPolicy.ts:3` / `RoundingPolicy` |
| CODE-012 | Ceny | Zobrazit pořadí cenového řetězce a případně schváleně parametrizovat | CODE | `okfish-pricing-engine/src/core/PricingEngine.ts:8` / `use` |
| CODE-013 | Kupóny | Vybrat kupónový režim a výchozí strop | DATA | `okfish-pricing-engine/cloudflare-worker/src/coupon/coupon-config.ts:13` / `CouponPolicyFile` |
| CODE-014 | Kupóny | Zakázat kupóny pro konkrétní zákaznické úrovně | API | `okfish-pricing-engine/cloudflare-worker/src/coupon/coupon-config-endpoint.ts:46` / `handleCouponConfig` |
| CODE-015 | Kupóny | Zakázat značky/produkty s časovou platností | DATA | `okfish-pricing-engine/cloudflare-worker/src/coupon/coupon-config.ts:11` / `DisabledEntry` |
| CODE-016 | Kupóny | Ukázat způsobilost kupónu a zbylý prostor | DOMAIN | `okfish-pricing-engine/cloudflare-worker/src/coupon/compute-coupon-writes.ts:149` / `computeCouponWrites` |
| CODE-017 | Katalog a import | Načíst/obnovit katalog a prohlédnout cenový přehled | DESKTOP | `okfish-pricing-engine/desktop-app/main.js:149` / `load-catalog` |
| CODE-018 | Katalog a import | Zpracovat produktový XLSX a volitelně synchronizovat | DESKTOP | `okfish-pricing-engine/desktop-app/main.js:122` / `process-products` |
| CODE-019 | Katalog a import | Exportovat seznam pravidel pro Shoptet import | DESKTOP | `okfish-pricing-engine/desktop-app/main.js:229` / `export-rule-csv` |
| CODE-020 | Zákazníci | Vyhledat zákazníka a otevřít detail | DESKTOP | `okfish-pricing-engine/desktop-app/main.js:285` / `find-customers` |
| CODE-021 | Zákazníci | Změnit zákaznickou úroveň | DESKTOP | `okfish-pricing-engine/desktop-app/main.js:297` / `set-customer-tier` |
| CODE-022 | Zákazníci | Importovat zákaznický CSV a VIP slevy | DESKTOP | `okfish-pricing-engine/desktop-app/main.js:309` / `process-customers` |
| CODE-023 | Dostupnost produktu | Změnit externí dostupnost produktu | DESKTOP | `okfish-pricing-engine/desktop-app/main.js:273` / `set-product-availability` |
| CODE-024 | Synchronizace | Uložit pravidla a sledovat dílčí výsledky aplikace | DESKTOP | `okfish-pricing-engine/desktop-app/main.js:178` / `save-policies` |
| CODE-025 | Synchronizace | Spustit a sledovat cenový sync | API | `okfish-pricing-engine/cloudflare-worker/src/index.ts:263` / `/v1/admin/worker-sync` |
| CODE-026 | Synchronizace | Zkontrolovat a opravit drift konkrétního ceníku | API | `okfish-pricing-engine/cloudflare-worker/src/index.ts:291` / `/v1/admin/reconcile` |
| CODE-027 | Synchronizace | Zařadit produkty do fronty nucené synchronizace | API | `okfish-pricing-engine/cloudflare-worker/src/index.ts:325` / `/v1/force-sync` |
| CODE-028 | Synchronizace | Spustit generování feedu a zobrazit report | API | `okfish-pricing-engine/cloudflare-worker/src/index.ts:212` / `/v1/feed/generate` |
| CODE-029 | Synchronizace | Diagnostikovat import a stav cache | API | `okfish-pricing-engine/cloudflare-worker/src/index.ts:414` / `/v1/products/import/begin` |
| CODE-030 | Pricing Platform | Zachovat rozdíly druhé cenové varianty | DESKTOP | `pricing-engine-platform/desktop-app/main.js:176` / `save-policies` |
| CODE-031 | Pricing Platform | Převést brandová pravidla do Shoptet XLSX | DESKTOP | `pricing-engine-platform/desktop-app/lib/setBrandRules.js:73` / `setBrandRules` |
| CODE-032 | Promo | Spravovat množstevní skupiny a breakpointy | DOMAIN | `nexus/core/canonical/entities/Price.ts:99` / `QuantityTierGroup` |
| CODE-033 | Promo | Nastavit X+X a produktový scope | DOMAIN | `nexus/domains/pricing/XPlusXRule.ts:37` / `XPlusXRule` |
| CODE-034 | Kampaně | Spravovat promo skupiny a slevové hodnoty | DOMAIN | `nexus/core/canonical/entities/Campaign.ts:57` / `PromoGroup` |
| CODE-035 | Kampaně | Vytvořit, aktivovat, pozastavit a ukončit kampaň | DOMAIN | `nexus/domains/campaign/CampaignLifecycleRule.ts:35` / `CampaignLifecycleRule` |
| CODE-036 | Kampaně | Vyřešit konflikt promo skupin a ukázat vítěze | DOMAIN | `nexus/domains/campaign/PromoGroupPriorityRule.ts:68` / `resolveConflict` |
| CODE-037 | Obsah kampaní | Spravovat kreativu a její umístění | DOMAIN | `nexus/core/canonical/entities/Campaign.ts:146` / `Creative` |
| CODE-038 | Obsah kampaní | Publikovat či archivovat kreativu | DOMAIN | `nexus/domains/campaign/CreativeLifecycleRule.ts:34` / `CreativeLifecycleRule` |
| CODE-039 | SafeOrder | Zobrazit rozhodnutí, důvody a základní statistiky | API | `safeorder-3.0/src/api/routes/admin.ts:11` / `handleAdminDashboard` |
| CODE-040 | SafeOrder | Provést lidskou opravu rozhodnutí | API | `safeorder-3.0/src/api/routes/admin.ts:45` / `handleAdminOverride` |
| CODE-041 | SafeOrder | Nastavit obchodní rizikovou politiku | API | `safeorder-3.0/src/api/routes/config.ts:38` / `handleUpdatePolicyConfig` |
| CODE-042 | SafeOrder | Nastavit ekonomický profil | API | `safeorder-3.0/src/api/routes/admin.ts:134` / `handleAdminEconomicsUpdate` |
| CODE-043 | SafeOrder | Nastavit či zobrazit přístup do reputační sítě | API | `safeorder-3.0/src/storage/repositories/tenant-repo.ts:190` / `setNetworkMode` |
| CODE-044 | SafeOrder | Pokročile spravovat váhy a časový rozpad | CODE | `safeorder-3.0/src/core/risk-engine/engine.ts:52` / `evaluateRisk` |
| CODE-045 | SafeOrder | Pokročile spravovat kalibraci a učení | CODE | `safeorder-3.0/src/core/calibration/calibration-engine.ts:60` / `calibrateRiskProbability` |
| CODE-046 | SafeOrder | Importovat historické objednávky k vyhodnocení | API | `safeorder-3.0/src/api/routes/import.ts:12` / `handleHistoricalImport` |
| CODE-047 | SafeOrder | Vyřídit ACCESS/EXPORT/DELETE soukromých rizikových dat | API | `safeorder-3.0/src/api/routes/privacy.ts:11` / `handleDsarRequest` |
| CODE-048 | SafeOrder | Spravovat registraci, stav a ukončení služby | API | `safeorder-3.0/src/api/routes/onboarding.ts:71` / `handleOnboardingOffboard` |
| CODE-049 | SafeOrder | Zobrazit limity a stav SaaS plánu | DOMAIN | `safeorder-3.0/src/core/billing/plans.ts:43` / `PlanManager` |
| CODE-050 | Tutani | Nastavit celý profil a zdroje obchodu | DATA | `tutani-barf-worker/src/domain/tenant.ts:39` / `TenantConfiguration` |
| CODE-051 | Tutani | Spravovat dávkovací matici | DATA | `tutani-barf-worker/src/engine/feeding-calculator/resolveDoseRule.ts:34` / `DoseRule` |
| CODE-052 | Tutani | Nastavit řešení překryvů dávkovacích pravidel | DATA | `tutani-barf-worker/src/engine/feeding-calculator/resolveDoseRule.ts:118` / `resolveDoseRule` |
| CODE-053 | Tutani | Spravovat poměry složek a limity kompozice | DATA | `tutani-barf-worker/src/domain/health/Condition.ts:151` / `CompositionLimit` |
| CODE-054 | Tutani | Spravovat diagnózy a zdravotní stavy | DATA | `tutani-barf-worker/src/domain/health/Condition.ts:29` / `Condition` |
| CODE-055 | Tutani | Spravovat každé zdravotní pravidlo | DATA | `tutani-barf-worker/src/domain/health/Condition.ts:74` / `ConditionRule` |
| CODE-056 | Tutani | Spravovat suroviny, alergeny a toxické příznaky | DATA | `tutani-barf-worker/src/rules/KnowledgeRuleEngine.ts:39` / `KnowledgeRuleEngine` |
| CODE-057 | Tutani | Spravovat výživové hodnoty a normové cíle | DATA | `tutani-barf-worker/src/engine/nutrient-coverage/calculateNutrientCoverage.ts:168` / `calculateNutrientCoverage` |
| CODE-058 | Tutani | Spravovat produktové složení a jeho doložení | STORE | `tutani-barf-worker/src/infrastructure/TutaniProductStore.ts:78` / `upsertProduct` |
| CODE-059 | Tutani | Spravovat doplňky a dávkovací údaje | STORE | `tutani-barf-worker/src/infrastructure/TutaniProductStore.ts:142` / `upsertSupplement` |
| CODE-060 | Tutani | Spravovat mapování kategorií a slov pro matching | DATA | `tutani-barf-worker/src/domain/tenant.ts:109` / `CategoryMapping` |
| CODE-061 | Tutani | Spravovat zákaznické aktivity, obaly a období | DATA | `tutani-barf-worker/src/domain/tenant.ts:101` / `ActivityOption` |
| CODE-062 | Tutani | Spravovat recept a údaje do PDF | DATA | `tutani-barf-worker/src/domain/tenant.ts:39` / `TenantConfiguration` |
| CODE-063 | Tutani | Sledovat stav katalogu a skladové synchronizace | STORE | `tutani-barf-worker/src/infrastructure/D1ProductStore.ts:467` / `health` |
| CODE-064 | Tutani | Řešit rozpory gramáže a vyřazené produkty | STORE | `tutani-barf-worker/src/infrastructure/D1ProductStore.ts:112` / `WeightConflictRecord` |
| CODE-065 | Tutani | Ověřit dávku a PDF proti skutečné metodice | API | `tutani-barf-worker/src/index.ts:202` / `route` |
| CODE-066 | Poukazy | Vyhledat poukaz a zkontrolovat platnost | API | `nexus/workers/api/index.ts:107` / `route` |
| CODE-067 | Poukazy | Vystavit poukaz z potvrzeného nákupu | STORE | `nexus/domains/voucher/CreditVoucherStore.ts:356` / `issue` |
| CODE-068 | Poukazy | Čerpat a zobrazit finanční transakce | STORE | `nexus/domains/voucher/CreditVoucherStore.ts:427` / `redeem` |
| CODE-069 | Poukazy | Vrátit čerpání a ukázat vazbu na původní transakci | STORE | `nexus/domains/voucher/CreditVoucherStore.ts:491` / `refund` |
| CODE-070 | Poukazy | Řešit stav ACTIVE/DEPLETED/EXPIRED/CANCELLED | DOMAIN | `nexus/domains/voucher/CreditVoucherLifecycleRule.ts:68` / `CreditVoucherLifecycleRule` |
| CODE-071 | Poukazy | Zobrazit transakční historii a účetní nejasnosti | STORE | `nexus/domains/voucher/CreditVoucherStore.ts:549` / `listTransactions` |
| CODE-072 | Poukazy | Vyřídit nadčerpání nebo nerozpoznanou slevu | DOMAIN | `nexus/domains/voucher/VoucherRedemptionAudit.ts:132` / `requiresManualReview` |
| CODE-073 | Základní data | Zobrazit/spravovat produkty, varianty a vazby identit | MODEL | `nexus/core/canonical/entities/Product.ts:19` / `Product` |
| CODE-074 | Základní data | Zobrazit zákaznický a B2B profil | DOMAIN | `nexus/domains/b2b/BusinessProfileValidationRule.ts:42` / `BusinessProfileValidationRule` |
| CODE-075 | Základní data | Zobrazit objednávku a položky s externím stavem | MODEL | `nexus/core/canonical/entities/Order.ts:27` / `Order` |
| CODE-076 | Dostupnost a jednotky | Zobrazit dostupnost a správu podkladů variant | DOMAIN | `nexus/connectors/availability-intelligence/legacy/availability/types.ts:21` / `VariantAvailability` |
| CODE-077 | Dostupnost a jednotky | Nastavit prodejní jednotky a množstevní omezení | DOMAIN | `nexus/connectors/availability-intelligence/legacy/sales-units/types.ts:6` / `SalesUnit` |
| CODE-078 | Dostupnost a jednotky | Nastavit obaly a zálohy | DOMAIN | `nexus/domains/availability/PackagingDepositRule.ts:18` / `PackagingDepositRule` |
| CODE-079 | Dostupnost a jednotky | Nastavit obchodní řazení a ukázat výsledek | DOMAIN | `nexus/domains/availability/SortingRule.ts:21` / `SortingRule` |
| CODE-080 | Sklad | Spravovat aktivní sklady a vazby skladových pozic | DOMAIN | `nexus/domains/warehouse/WarehouseStockLinkRule.ts:54` / `WarehouseStockLinkRule` |
| CODE-081 | Nákup | Spravovat dodavatele a produktová mapování | DEMO | `nexus/connectors/availability-intelligence/legacy/procurement/SupplierMappingService.ts:74` / `SupplierMappingService` |
| CODE-082 | Nákup | Nastavit výběr dodavatelů a režim schvalování | DOMAIN | `nexus/connectors/availability-intelligence/legacy/procurement/types.ts:129` / `ProcurementPolicy` |
| CODE-083 | Nákup | Vytvořit plán a schválit či zrušit nákupní objednávku | PORTS | `nexus/connectors/availability-intelligence/legacy/procurement/Workflow.ts:106` / `approvePurchaseOrder` |
| CODE-084 | Nákup | Upravit množství, dodavatele a alokaci | PORTS | `nexus/connectors/availability-intelligence/legacy/procurement/Workflow.ts:182` / `overridePurchaseOrderSupplier` |
| CODE-085 | Nákup | Přijmout zboží a synchronizovat stav dodavatele | PORTS | `nexus/connectors/availability-intelligence/legacy/procurement/Workflow.ts:61` / `receive` |
| CODE-086 | Nákup | Řešit nepokryté poptávky | DOMAIN | `nexus/connectors/availability-intelligence/legacy/procurement/types.ts:96` / `UnfulfilledDemand` |
| CODE-087 | CSV a integrace | Nahrát a ověřit dodavatelský/objednávkový CSV | DOMAIN | `nexus/domains/supplier-csv/SupplierCsvRule.ts:32` / `ImportSupplierOffersRule` |
| CODE-088 | Doklady a Omega | Zobrazit vazbu dokladu na objednávku a účetní potvrzení | DOMAIN | `nexus/domains/invoice/OrderInvoiceOmegaFlow.ts:54` / `evaluateOrderInvoiceOmegaFlow` |
| CODE-089 | Doklady a Omega | Vyřídit validační HOLD/REJECT a doplnit chybné podklady | DOMAIN | `nexus/domains/omega/DecisionRules.ts:32` / `DecisionEngineRule` |
| CODE-090 | Doklady a Omega | Odeslat import přes účetní integraci a zkontrolovat skutečné potvrzení | PORTS | `nexus/connectors/omega/legacy/agent/OmegaExecutor.ts:84` / `execute` |
| CODE-091 | Tarify platformy | Spravovat TenantPlan a Subscription lifecycle | DOMAIN | `nexus/domains/billing/TenantSubscriptionPlanFlow.ts:52` / `evaluateTenantSubscriptionPlanFlow` |
| CODE-092 | Integrace a incidenty | Zobrazit čekající/nejisté operace a řízenou reconciliaci | STORE | `nexus/connectors/d1/D1ExecutionIntentStore.ts:305` / `findRequiringReconciliation` |
| CODE-093 | Integrace a incidenty | Spravovat tenant scoped mapování ceníků a režim integrace | MODEL | `nexus/core/tenant/types.ts:122` / `TenantScopedTierConfig` |
| CODE-094 | Přístupy a audit | Uplatnit skutečné role obsluhy pro jednotlivé akce | API | `safeorder-3.0/src/api/middleware/auth.ts:26` / `requireRole` |
| CODE-095 | Přístupy a audit | Verzovat konfiguraci a vidět změny i konflikty | APP | `nexus/apps/admin/service.ts:240` / `save` |

## Nejpodstatnější změny oproti dosavadnímu návrhu

1. **Chybějící tři cenové sady v každé cenové variantě:** `product-max-discount-overrides.json`, `zero-discount-products.json`, `clearance-sale-products.json`. Desktop je načítá/zapisuje a resolveProductLimits je používá. Dosavadní nový katalog načetl jen policy-v1 a coupon-policy; nedává tedy úplnou správu cenových pravidel. Doplnit šest dokumentů a konkrétní produktové ovládání, nikoli pouze přidat názvy menu.
2. **Platnost a jednotky:** clearance má číslo nebo `{pct,validFrom,validTo}`; kupónové výjimky mají string nebo `{value,validFrom,validTo}`. Náš lokální kupónový schema validator přijímá jen string[] a odmítá časované objekty podporované Workerem. Značkové limity/tiery jsou poměr 0–1, produktové JSON limity a clearance jsou procenta 0–100. Admin potřebuje jednoznačné jednotky a převod. `assertNoCrossFileConflicts` navíc zakazuje stejný SKU současně v zeroDiscount, clearance a productOverrides — i když je clearance teprve budoucí; tento konflikt je potřeba ukázat před uložením.
3. **Výsledek uložení není jeden boolean:** OKFISH save-policies může změnit Worker/Shoptet a pak selhat při Git push. Musí být vidět samostatně uložená konfigurace, vzdálená verze, aplikovaný zápis, budoucí/pending změny a ověření. Budoucí clearance není prokázaný automatický scheduler jen tím, že má validFrom — desktop výslovně vrací zprávu o novém uložení v den začátku.
4. **Reálné operátorské úkony:** zákaznická úroveň, produktová dostupnost, souborové importy, exporty pro Shoptet, spuštění dry-run, režim live, výsledky reconciliation a fronta force-sync jsou konkrétní existující operace. Obsluhovat je samostatnými obrazovkami se skutečným průběhem a chybami.
5. **SafeOrder:** VIEWER/OPERATOR/ADMIN/OWNER mají skutečně odlišné akce. Ruční override potřebuje decisionId, nový výsledek a reasonNotes. Snapshot původního rozhodnutí je v handleru tvrdě RESTRICT a nemusí odpovídat realitě; opravu auditních podkladů nepřeskočit. Lokální admin relace není implementace těchto produkčních rolí.
6. **Nepravdivé finanční přehledy:** `packages/dashboard/dashboard.tsx` doplňuje ukázková čísla chráněné hodnoty, ROI apod. Zobrazit je jako skutečné podnikatelské KPI by bylo chybné. `AuditRepository` poskytuje skutečné základní počty; další metriky musejí dostat skutečný výpočet a data. Navíc recentDecisions aktuálně vrací calibrated_probability=0 jako projekční placeholder.
7. **Více cest SafeOrder policy:** validované `/v1/config/policy` používá MerchantPolicyUpdateSchema a historii; `/v1/admin/policies` používá typed cast a neposkytuje totéž validační/auditní chování. Jednotný admin musí mít jeden explicitní kontrakt, nikoli náhodně volit endpoint podle formuláře. DSAR export/ACCESS má konkrétní statický rozpor: handler vybírá `raw_score` a `calibrated_probability`, zatímco migrace `0005_audit_ledger_and_privacy.sql` definuje `risk_score` a pole calibrated_probability v aktuálních migracích není. To je mezera v kódovém/schema kontraktu; běh nad nasazenou databází zde nebyl testován. DELETE signálů není hotové smazání celého commerce zákazníka.
8. **Priority nejsou univerzální:** cenové policy řadí menší priority dříve; PromoGroup/Creative vyšší hodnoty preferují; zdravotní pravidla kombinují restrikce podle konkrétního typu. Jednotný libovolný editor priorit může změnit sémantiku. Každý modul má vlastní validovaný model.
9. **Tutani:** kód rozlišuje metodiku, zdraví, kompozici, výživové normy, suroviny, produktovou evidence, doplňky, mapování názvů, skladový sync a zákaznický výpočet. U některých existuje D1 upsert, ale Worker route má dávku/PDF/knowledge/health, nikoli kompletní admin CRUD. Každé tvrzení o editaci musí mít skutečný zapisující endpoint a consumer, který novou verzi přečte.
10. **Kampaně a obsah:** kampaně bez promo skupiny nelze aktivovat; ukončené kampaně jsou terminální. Kreativu bez obsahu nelze publikovat a ARCHIVED nelze opět publikovat. CampaignPlacement není používanou autoritou umístění — skutečné placementTypes jsou na Creative. To určuje formuláře a dovolená tlačítka.
11. **Poukazy:** vydání/čerpání/refundace/transakce jsou konkrétní peněžní operace. Lifecycle typ CANCELLED není sám hotové storno API. Zůstatek je výsledek transakcí, ne běžné editovatelné políčko. Nadčerpání a nerozpoznané slevy mají explicitní případ vyžadující dohledání.
12. **Demo a porty:** SupplierMappingService je mock se seed daty, procurement workflow závisí na portech a Omega na externím agentu. Členství kupujícího v placeném obsahu nelze odvodit z TenantPlan/Subscription, které řeší SaaS tenanty.

## Co v kódu Anastázie chybí

V prozkoumaných zdrojích nebyl nalezen implementovaný commerce audio katalog, model customer entitlement/chráněné knihovny ani booking service. Historická auditní matice tyto oblasti jmenuje, ale nepředstavuje jejich kód. Proto nyní neexistují konkrétní adminové CRUD/routy pro šest audio položek EP.001, automatické přidělování placeného obsahu či termíny a přesuny rezervací. KAR má speech/chat routy; nejsou to produkty ani placená zákaznická knihovna Anastázie. Tyto produktové schopnosti mají být samostatnou implementací, nikoli falešně funkčním ovládáním generického enginu.

## Jak podle výsledku postupovat

Pro klientské obrazovky používat položky matice jednotlivě: formulář produktu ukáže zdroj a výsledný limit; detail zákazníka nabídne konkrétní změnu tieru; SafeOrder případ vyžaduje důvod override; uložený cenový zásah ukáže Git/Worker/Shoptet výsledek odděleně.

Nejdřív zpřesnit skutečné konfigurační kontrakty a jejich konzumenty: kompletní cenové sady, časované výjimky, import/export a stav aplikace; pak reálné klientské operace používaných modulů. U každé akce spojit formulář → validované serverové údaje → tenant/role → zdroj pravdy → změna stavu/consumer → potvrzení výsledku/audit. Co má jen typ, demo nebo port, ponechat jako jasnou implementační mezeru. Admin nemá předstírat, že SQLite draft změnil konfiguraci Workeru.

Podklad je uzavřený **pro uvedený rozsah statické kódové analýzy**; neprokazuje aktuální nasazení, poskytovatele ani osobní četnost práce klientky. Původní zadání zde není blokující podmínkou dalšího kódového mapování. Zjištěné mezery byly zdokumentované; v této fázi nebyla měněna aplikační logika ani proveden živý e-shopový zápis.
