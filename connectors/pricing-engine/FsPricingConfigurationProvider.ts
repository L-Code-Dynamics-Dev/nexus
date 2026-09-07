// Filesystem implementace `PricingConfigurationProvider` -- Node-only.
//
// PROČ TADY A NE V domains/pricing/: `fs` je platform detail. Doména smí
// znát jen port (`PricingConfigurationProvider`), nikdy konkrétní zdroj dat
// -- stejné pravidlo, podle kterého D1 implementace `CreditVoucherStore`
// žije v `connectors/d1/` a ne v `domains/voucher/`, a podle kterého
// `core/idempotency/IdempotencyStore.ts` drží jen kontrakt. Kdyby `fs`
// import zůstal v doméně, pricing by se nedal nasadit do Cloudflare Workeru
// ani po zavedení portu -- bundler by ten import stáhl s sebou.
//
// Config se čte JEDNOU v konstruktoru, ne při každém `getPolicyConfig()`:
// zachovává to chování původního `createNexusPricingCalculator`, které
// soubor načetlo jednou při stavbě kalkulátoru, a drží port synchronní
// bez I/O za běhu.

import * as fs from 'fs';
import type { TenantContext } from '../../core/tenant/types.js';
import type {
    PolicyConfig,
    PricingConfigurationProvider,
} from '../../domains/pricing/PricingConfigurationProvider.js';

export class FsPricingConfigurationProvider implements PricingConfigurationProvider {
    private readonly config: PolicyConfig;

    constructor(configPath: string) {
        let raw: string;
        try {
            raw = fs.readFileSync(configPath, 'utf-8');
        } catch (err) {
            throw new Error(
                `FsPricingConfigurationProvider: cannot read pricing policy config at "${configPath}": ` +
                `${err instanceof Error ? err.message : String(err)}`
            );
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch (err) {
            throw new Error(
                `FsPricingConfigurationProvider: pricing policy config at "${configPath}" is not valid JSON: ` +
                `${err instanceof Error ? err.message : String(err)}`
            );
        }

        const candidate = parsed as Partial<PolicyConfig> | null;
        if (candidate === null || typeof candidate !== 'object' || typeof candidate.loyaltyTiers !== 'object' || candidate.loyaltyTiers === null) {
            throw new Error(
                `FsPricingConfigurationProvider: pricing policy config at "${configPath}" is missing required "loyaltyTiers" object.`
            );
        }

        this.config = candidate as PolicyConfig;
    }

    /**
     * Jeden soubor = jedna konfigurace. Tenant se ignoruje záměrně -- tahle
     * implementace je single-tenant (lokální běh, golden parity testy proti
     * legacy policy-v1.json). Multi-tenant runtime musí použít provider,
     * který konfiguraci podle tenanta skutečně rozlišuje (D1/KV), ne tenhle.
     */
    getPolicyConfig(_context: TenantContext): PolicyConfig {
        return this.config;
    }
}
