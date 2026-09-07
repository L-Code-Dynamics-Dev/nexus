// ShoptetPriceConnector -- PRVNÍ skutečná implementace `Connector` kontraktu
// v repu (P1, rozhodnutí Lucky 2026-09-07).
//
// PROČ TO VZNIKÁ:
//   `grep -rn "implements Connector"` vracel do dneška NULA výsledků.
//   `connectors/Connector.ts` byl popisovaný napříč dokumentací jako hotová
//   infrastruktura Fáze 0, ale 79 z 83 souborů pod `connectors/` byly 1:1
//   legacy porty volané přímo, mimo jakékoli rozhraní. Tenhle soubor je
//   důkaz, že ten kontrakt je použitelný -- a zároveň referenční vzor pro
//   ostatní konektory (Pohoda, Omega, Money S3).
//
// CO TENHLE KONEKTOR DĚLÁ A CO NE:
//   DĚLÁ:   překládá tvar dat mezi canonical modelem a Shoptet REST API,
//           a provádí zápis ceny.
//   NEDĚLÁ: NIKDY nepočítá cenu, slevu ani tier. To je věc `domains/pricing/`.
//           Referenční vzor `EcommercePlatformAdapter` to říká doslova:
//           "an adapter NEVER computes a discount, tier, or final price.
//           It only translates platform data."
//
// SÉMANTIKA POTVRZOVÁNÍ -- proč je Shoptet `SYSTEM_CONFIRMED`, ale s háčkem:
//   Shoptet REST API vrací strojově čitelnou odpověď, takže na rozdíl od
//   Omegy (regex nad logem `.bat` agenta) víme, jestli požadavek prošel.
//   ALE: INC-016 v okfish repu dokumentuje, že **HTTP 200 OK neznamená
//   per-item úspěch** -- hromadný zápis může vrátit 200 a uvnitř mít
//   odmítnuté položky. Proto `isDefiniteFailure` níž vrací `false` pro
//   všechno, co jednoznačně nerozpozná: raději UNKNOWN a reconciliace než
//   FAILED a slepý retry.
//
// ZÁPIS SE DĚJE PŘES `ExecutionIntent`, ne přímo. Volající musí:
//   1. naplánovat Intent (`ExecutionIntentStore.plan`)
//   2. nárokovat ho (`claimForExecution`) -- PERZISTOVANĚ, před voláním API
//   3. teprve pak `executeIntent(intent, SHOPTET_PRICE_SEMANTICS, ...)`
//   Bez kroku 2 se po pádu procesu neví, jestli se zápis stihl provést.

import type { Connector, ConnectorCapabilities } from '../Connector.js';
import type { ConnectorSemantics, RawWriteResult } from '../../core/canonical/outcomes/IntentExecutor.js';

/**
 * Tvar, ve kterém Shoptet REST API drží cenu produktu v ceníku.
 * Odpovídá `PATCH /api/products/code/{code}` (ověřeno v živém okfish repu,
 * `cloudflare-worker/src/shoptet-api/client.ts:566`).
 */
export interface ShoptetPriceRow {
    readonly code: string;
    readonly pricelistId: number;
    /**
     * Cena jako STRING, ne number. Shoptet API ji tak vrací i přijímá
     * a převod přes `number` by na hraničních hodnotách ztratil přesnost --
     * přesně ten druh chyby, kterou shadow harness našel mezi okfish enginy
     * (root `Math.round` vs. worker integer-cents, rozdíl 1 haléř).
     */
    readonly price: string;
    readonly currency: string;
}

/** Canonical tvar téhož -- to, co zná `domains/pricing/`. */
export interface CanonicalProductPrice {
    readonly productCode: string;
    readonly tierKey: string;
    readonly priceMinor: number;
    readonly currency: string;
}

/**
 * Mapa tier -> Shoptet pricelist ID. Je PER TENANT, ne globální konstanta:
 * dva e-shopy mohou mít pro tentýž tier ("ZR20") jiné externí ID, protože
 * je to jejich vlastní Shoptet konfigurace. Odpovídá
 * `TenantScopedTierConfig` v `core/tenant/types.ts`.
 */
export type TierToPricelistMap = Readonly<Record<string, number>>;

/**
 * Sémantika pro `IntentExecutor`. Vyexportovaná zvlášť, aby se dala použít
 * i tam, kde se konektor nekonstruuje (testy, dry-run plánovač).
 */
export const SHOPTET_PRICE_SEMANTICS: ConnectorSemantics = {
    // Strojová odpověď, na rozdíl od Omegy.
    confirmationQuality: 'SYSTEM_CONFIRMED',

    // Shoptet REST API nemá server-side deduplikaci zápisů podle
    // idempotency klíče. Opakovaný PATCH téže ceny je sice neškodný
    // (idempotentní ve svém důsledku), ale to je vlastnost TÉHLE operace,
    // ne záruka platformy -- u operací, které nejsou přepis absolutní
    // hodnoty, by to neplatilo. Fail-closed: `false`.
    supportsIdempotency: false,

    isDefiniteFailure: (error: string): boolean => {
        const e = error.toLowerCase();

        // Prokazatelné neprovedení: požadavek byl odmítnut PŘED zápisem.
        // Jen stavy, u kterých je jisté, že se na straně Shoptetu nic
        // nezměnilo.
        if (e.includes('400') || e.includes('bad request')) return true;
        if (e.includes('401') || e.includes('unauthorized')) return true;
        if (e.includes('403') || e.includes('forbidden')) return true;
        if (e.includes('404') || e.includes('not found')) return true;
        if (e.includes('422') || e.includes('unprocessable')) return true;
        if (e.includes('validation')) return true;

        // VŠECHNO OSTATNÍ je nejistota, ne selhání:
        //   - 429 rate limit: požadavek mohl projít a odpověď se ztratit
        //   - 5xx: server mohl zapsat a spadnout při odpovědi
        //   - timeout, síť: klasický neznámý stav
        //   - "partial", "200 OK ale položky odmítnuty" (INC-016)
        // Chybné FAILED vede na retry a možný dvojí zápis. Chybné UNKNOWN
        // vede jen na zbytečnou reconciliaci -- levnější chyba.
        return false;
    },
};

const CAPABILITIES: ConnectorCapabilities = {
    canRead: true,
    canWrite: true,
    // Tenhle konektor jede přes REST API. CSV varianta je samostatná
    // implementace téhož kontraktu -- to je celý smysl toho rozhraní.
    requiresApi: true,
};

/**
 * Překlad mezi Shoptet API tvarem a canonical modelem.
 *
 * Implementuje `Connector`, NE `WritableConnector`: samotný zápis jde přes
 * `ExecutionIntent` + `IntentExecutor`, ne přes `connector.write()`.
 * Důvod je v hlavičce `IntentExecutor.ts` -- návratový tvar
 * `{ externalReference?, error? }` neumí vyjádřit UNKNOWN, a bez toho stavu
 * se nedá bezpečně rozhodnout o retry.
 */
export class ShoptetPriceConnector
    implements Connector<ShoptetPriceRow, CanonicalProductPrice>
{
    readonly connectorId: string;
    readonly connectorType = 'shoptet-api' as const;
    readonly capabilities = CAPABILITIES;

    private readonly pricelistToTier: ReadonlyMap<number, string>;

    constructor(
        connectorId: string,
        private readonly tierToPricelist: TierToPricelistMap,
    ) {
        this.connectorId = connectorId;

        // Obrácená mapa se staví jednou v konstruktoru, ne při každém
        // překladu -- `toCanonical` běží nad desítkami tisíc řádků.
        const reverse = new Map<number, string>();
        for (const [tier, pricelistId] of Object.entries(tierToPricelist)) {
            if (reverse.has(pricelistId)) {
                // Dva tiery na tentýž pricelist = nejednoznačný překlad zpět.
                // Radši selhat při konstrukci než tiše vracet špatný tier.
                throw new Error(
                    `ShoptetPriceConnector(${connectorId}): pricelist ${pricelistId} je namapovaný ` +
                        `na víc tierů ("${reverse.get(pricelistId)}" a "${tier}") -- překlad zpět ` +
                        `by byl nejednoznačný.`,
                );
            }
            reverse.set(pricelistId, tier);
        }
        this.pricelistToTier = reverse;
    }

    /**
     * Shoptet -> canonical. Cena přichází jako string; převádí se na celé
     * haléře, protože canonical model peníze ve float nedrží.
     */
    toCanonical(external: ShoptetPriceRow): CanonicalProductPrice {
        const tierKey = this.pricelistToTier.get(external.pricelistId);
        if (tierKey === undefined) {
            throw new Error(
                `ShoptetPriceConnector(${this.connectorId}): pricelist ${external.pricelistId} ` +
                    `nemá mapování na tier. Konektor NESMÍ hádat -- tenant konfigurace je neúplná.`,
            );
        }

        return {
            productCode: external.code,
            tierKey,
            priceMinor: parsePriceToMinor(external.price, external.code),
            currency: external.currency,
        };
    }

    /** Canonical -> Shoptet. */
    toExternal(canonical: CanonicalProductPrice): ShoptetPriceRow {
        const pricelistId = this.tierToPricelist[canonical.tierKey];
        if (pricelistId === undefined) {
            throw new Error(
                `ShoptetPriceConnector(${this.connectorId}): tier "${canonical.tierKey}" nemá ` +
                    `mapování na Shoptet pricelist.`,
            );
        }

        return {
            code: canonical.productCode,
            pricelistId,
            price: minorToPriceString(canonical.priceMinor),
            currency: canonical.currency,
        };
    }

    /**
     * Sestaví tělo `PATCH /api/products/code/{code}`. NEODESÍLÁ ho --
     * odeslání patří do `IntentExecutor`, tohle je jen tvar dat.
     */
    buildWritePayload(canonical: CanonicalProductPrice): {
        readonly path: string;
        readonly body: Record<string, unknown>;
    } {
        const row = this.toExternal(canonical);
        return {
            path: `/api/products/code/${encodeURIComponent(row.code)}`,
            body: {
                pricelists: [{ id: row.pricelistId, price: row.price }],
            },
        };
    }
}

/**
 * Cena ze Shoptetu ("12.71") na celé haléře. Fail-closed: cokoli, co není
 * čistý dekadický zápis s nejvýš dvěma desetinnými místy, je chyba.
 *
 * Zaokrouhlení se tu NEDĚLÁ. Tři desetinná místa znamenají, že se někde výš
 * počítalo ve floatu -- a tichý ořez by tu chybu schoval místo aby ji ukázal.
 * Přesně ten haléřový rozdíl, který shadow harness našel mezi okfish enginy.
 */
export function parsePriceToMinor(price: string, contextCode: string): number {
    if (!/^-?\d+(\.\d{1,2})?$/.test(price.trim())) {
        throw new Error(
            `ShoptetPriceConnector: cena "${price}" u produktu ${contextCode} není platný ` +
                `dekadický zápis s max. 2 desetinnými místy. Zaokrouhlení se tu NEDĚLÁ -- ` +
                `víc desetinných míst znamená float chybu výš v řetězu.`,
        );
    }

    const [whole = '0', frac = ''] = price.trim().split('.');
    const negative = whole.startsWith('-');
    const wholeAbs = negative ? whole.slice(1) : whole;
    const minor = Number(wholeAbs) * 100 + Number(frac.padEnd(2, '0'));

    if (!Number.isSafeInteger(minor)) {
        throw new Error(
            `ShoptetPriceConnector: cena "${price}" u produktu ${contextCode} přetekla ` +
                `bezpečný rozsah celých čísel.`,
        );
    }

    return negative ? -minor : minor;
}

/** Haléře zpět na Shoptet string tvar ("1271" -> "12.71"). */
export function minorToPriceString(minor: number): string {
    if (!Number.isInteger(minor)) {
        throw new Error(
            `ShoptetPriceConnector: priceMinor musí být celé číslo haléřů, dostal ${minor}.`,
        );
    }

    const negative = minor < 0;
    const abs = Math.abs(minor);
    const whole = Math.floor(abs / 100);
    const frac = String(abs % 100).padStart(2, '0');

    return `${negative ? '-' : ''}${whole}.${frac}`;
}
