// PricingConfigurationProvider -- explicitní port pro pricing konfiguraci
// (P0 rozhodnutí Lucky 2026-09-07):
//
//   Tenant -> PricingConfigurationProvider -> PricingConfig -> Pricing Rules
//
// PROČ TO NENÍ KOSMETIKA: `createNexusPricingCalculator` dosud četl policy
// JSON přes `fs.readFileSync(configPath)`. Cloudflare Workers nemají
// filesystem, takže celý pricing chain byl odříznutý od runtime, na kterém
// běží zbytek Nexusu (voucher). Port ten vstup obrací -- konfiguraci dodává
// volající, doména si ji nesmí nikde vzít sama.
//
// KAM PATŘÍ (rozhodnutí): rozhraní zůstává v `domains/pricing/`, ne v
// `core/`. Důvod: `PolicyConfig` je pricing-specifický tvar (loyaltyTiers,
// brandLimits, categoryLimits) -- nemá žádného konzumenta mimo pricing
// doménu, takže by v `core/` byl jen cizí typ bez důvodu. Vzor
// `core/idempotency/IdempotencyStore.ts` je port SDÍLENÉ infrastruktury;
// tenhle je port jedné domény, tedy patří k ní. Co ale platí stejně jako
// tam: PRODUKČNÍ IMPLEMENTACE ŽIJE MIMO doménu -- filesystem varianta je
// v `connectors/pricing-engine/FsPricingConfigurationProvider.ts`, protože
// `fs` je platform detail (§15: core/domains nesmí znát konkrétní
// platformu), stejně jako D1 implementace `CreditVoucherStore` sedí
// v `connectors/d1/`, ne v `domains/voucher/`.
//
// Formát `PolicyConfig` je BEZE ZMĚNY totožný s legacy policy-v1.json,
// který čte `EngineBuilder.fromConfig()` -- žádná nová konfigurace, jen
// jiná cesta, kudy se do pricingu dostane.

import type { TenantContext } from '../../core/tenant/types.js';

/**
 * Pricing policy konfigurace -- 1:1 tvar legacy policy-v1.json.
 * `loyaltyTiers` je povinný (definuje množinu platných customerTier),
 * limity jsou volitelné stejně jako v legacy configu.
 */
export interface PolicyConfig {
    readonly loyaltyTiers: Record<string, number>;
    readonly brandLimits?: Record<string, number>;
    readonly categoryLimits?: Record<string, number>;
    /**
     * `brandSaleDiscounts` z legacy policy-v1.json -- celoroční brandová
     * AKČNÍ CENA (DELPHIN 0.15, DELPHIN BOMB 0.15, MIVARDI 0.10, MIKADO 0.09).
     *
     * NENÍ TO STROP. `brandLimits` je maximální sleva, tohle je syntetizovaná
     * akční cena pro produkty té značky, které vlastní akční cenu nemají --
     * dvě nezávislé mapy, které se u MIVARDI náhodou shodují na 0.10.
     * Konzumuje BrandSaleDiscountRule; podrobnosti a hraniční případy jsou
     * v hlavičce toho souboru.
     *
     * Volitelné a v legacy formátu už existující -- tenhle řádek jen
     * zpřístupňuje pole, které policy-v1.json nese od začátku, ale
     * `PolicyConfig` ho zatím zahazoval. Žádná nová konfigurace.
     */
    readonly brandSaleDiscounts?: Record<string, number>;
}

/**
 * Port: vrací pricing konfiguraci pro KONKRÉTNÍHO tenanta. Tenant je
 * parametr, ne globální stav -- dva tenanti mají různé loyalty tiery
 * i limity a nikdy se nesmí potkat (viz TenantScopedTierConfig v
 * core/tenant/types.ts, stejný princip).
 *
 * Synchronní záměrně: `createNexusPricingCalculator` je synchronní factory
 * a chain runner uvnitř je čistá funkce bez I/O (Rule.ts: "Žádné skryté
 * side effects uvnitř evaluate()"). Asynchronní načtení (D1, KV, fetch)
 * patří PŘED sestavení kalkulátoru -- implementace si data přednačte
 * a tento port pak jen vrací už držený objekt. Kdyby byl port async,
 * protekl by await do každého volání ceny.
 */
export interface PricingConfigurationProvider {
    getPolicyConfig(context: TenantContext): PolicyConfig;
}

/**
 * In-memory implementace -- pro testy a pro runtime, který si konfiguraci
 * načetl jinudy (D1 row, KV hodnota, request payload) a jen ji potřebuje
 * podat pricingu. Žádný I/O, funguje ve Workeru i v Node.
 *
 * Je v doméně (ne v connectors/) schválně: nesahá na žádnou platformu,
 * je to čistý datový držák, ne connector.
 */
export class InMemoryPricingConfigurationProvider implements PricingConfigurationProvider {
    constructor(private readonly config: PolicyConfig) {}

    getPolicyConfig(_context: TenantContext): PolicyConfig {
        return this.config;
    }
}
