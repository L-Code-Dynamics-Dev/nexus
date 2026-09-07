// ShoptetApiClient -- HTTP klient pro Shoptet REST API.
//
// Každé volání prochází `ReadOnlyGuard`. Token, se kterým NEXUS pracuje, je
// PRODUKČNÍ okfish.sk -- zápis je proto blokovaný konstrukčně, ne konvencí.
//
// OVĚŘENO NAŽIVO 7.9.2026 (§17 návrhu):
//   - autentizace hlavičkou `Shoptet-Private-API-Token`
//     (`Shoptet-Access-Token` vrací 401)
//   - `Content-Type: application/vnd.shoptet.v1.0+json`
//   - parametr `?limit=` NENÍ podporovaný (vrací 400)
//
// CO TENHLE KLIENT NEDĚLÁ:
//   - neretryuje. Rozhodnutí o retry patří `IntentExecutor`, který jediný
//     ví, jestli je bezpečný (u UNKNOWN u systému bez idempotence není).
//   - nemapuje na canonical model. To je věc konektoru, ne přenosové vrstvy.

import {
    assertRequestAllowed,
    READ_ONLY,
    type ShoptetAccessMode,
} from './ReadOnlyGuard.js';

const API_BASE = 'https://api.myshoptet.com/api';
const ACCEPT = 'application/vnd.shoptet.v1.0+json';

/** Timeout jednoho volání. Shoptet bývá rychlý; delší čekání je zaseknutí. */
const REQUEST_TIMEOUT_MS = 8000;

export class ShoptetApiError extends Error {
    constructor(
        message: string,
        readonly status: number,
        /**
         * `true` = prokazatelně se nic nestalo (4xx). `false` = nevíme
         * (5xx, timeout, síť). Mapuje se na `FAILED` vs `UNKNOWN`
         * v `IntentExecutor` -- proto to nese klient, který jediný zná
         * skutečný status.
         */
        readonly definiteFailure: boolean,
    ) {
        super(message);
        this.name = 'ShoptetApiError';
    }
}

/** Sleva na objednávce, jak ji Shoptet vrací. */
export interface ShoptetOrderDiscount {
    readonly type?: string;
    readonly code?: string;
    readonly value?: number | string;
    readonly name?: string;
}

/**
 * Objednávka -- jen pole, která voucher audit potřebuje.
 *
 * VĚDOMĚ NEÚPLNÉ: modelovat celou objednávku by znamenalo přebírat
 * závislost na tvaru, který se může měnit. Nezmapovaná pole se ignorují.
 */
export interface ShoptetOrder {
    readonly code?: string;
    readonly creationTime?: string;
    readonly priceWithVat?: number | string;
    readonly discounts?: readonly ShoptetOrderDiscount[];
    /** Fallback: některé verze vracejí slevy pod jiným klíčem. */
    readonly discount?: ShoptetOrderDiscount;
    readonly [key: string]: unknown;
}

export class ShoptetApiClient {
    constructor(
        private readonly token: string,
        /** Výchozí read-only. Zápis se musí povolit vědomě. */
        private readonly access: ShoptetAccessMode = READ_ONLY,
    ) {
        if (token.trim() === '') {
            throw new Error('ShoptetApiClient: prázdný token.');
        }
    }

    /**
     * `GET /api/orders/{code}`. Číslo objednávky je to, co přijde
     * ve webhooku jako `eventInstance`.
     */
    async getOrder(orderCode: string): Promise<ShoptetOrder> {
        const body = await this.get(`/orders/${encodeURIComponent(orderCode)}`);
        const order = (body as { data?: { order?: unknown } }).data?.order;

        if (order === undefined || order === null) {
            throw new ShoptetApiError(
                `Objednávka ${orderCode}: odpověď neobsahuje data.order.`,
                200,
                // Odpověď dorazila a byla čitelná -- jen jinak, než čekáme.
                // Retry ji nezmění, takže je to prokazatelné selhání.
                true,
            );
        }

        return order as ShoptetOrder;
    }

    private async get(path: string): Promise<unknown> {
        const url = `${API_BASE}${path}`;

        // Guard PŘED odesláním. U GET projde vždy, ale kontrola tu je
        // proto, aby ji nikdo nemohl obejít přidáním jiné metody.
        assertRequestAllowed({ method: 'GET', url }, this.access);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        try {
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Shoptet-Private-API-Token': this.token,
                    'Content-Type': ACCEPT,
                },
                signal: controller.signal,
                // Redirect by mohl token poslat na cizí host.
                redirect: 'error',
            });

            if (!response.ok) {
                throw new ShoptetApiError(
                    `Shoptet API vrátilo ${response.status} pro ${path}.`,
                    response.status,
                    // 4xx = požadavek byl odmítnut, nic se nestalo.
                    // 5xx a 429 = nevíme, server mohl něco udělat a spadnout.
                    response.status >= 400 && response.status < 500 && response.status !== 429,
                );
            }

            return await response.json();
        } catch (error) {
            if (error instanceof ShoptetApiError) throw error;

            const isAbort = error instanceof Error && error.name === 'AbortError';
            throw new ShoptetApiError(
                isAbort
                    ? `Shoptet API timeout po ${REQUEST_TIMEOUT_MS} ms (${path}).`
                    : `Shoptet API selhalo (${path}): ${error instanceof Error ? error.message : String(error)}`,
                0,
                // Timeout ani síťová chyba NEJSOU prokazatelné selhání --
                // požadavek mohl dorazit a odpověď se ztratit.
                false,
            );
        } finally {
            clearTimeout(timer);
        }
    }
}

/**
 * Součet slev na objednávce v HALÉŘÍCH.
 *
 * PROČ TAK OPATRNĚ: tvar pole slev není ověřený proti reálné odpovědi
 * (§17 -- token jsme testovali jen na existenci endpointů). Funkce proto
 * zkouší obě známé varianty a nezmapovaný tvar hlásí, místo aby tiše
 * vrátila nulu. Nula by tady znamenala "nic se neuplatnilo", což by
 * u účetního podkladu byla lež.
 */
export function sumOrderDiscountsMinor(order: ShoptetOrder): {
    readonly totalMinor: number;
    readonly recognised: boolean;
} {
    const list: ShoptetOrderDiscount[] = [];

    if (Array.isArray(order.discounts)) list.push(...order.discounts);
    if (order.discount !== undefined) list.push(order.discount);

    if (list.length === 0) {
        // Žádné slevy -- ale nevíme, jestli je Shoptet nevrátil, nebo jich
        // opravdu nebylo. `recognised: false` to nechává na volajícím.
        return { totalMinor: 0, recognised: false };
    }

    let total = 0;
    for (const d of list) {
        const parsed = parseAmountToMinor(d.value);
        if (parsed === null) return { totalMinor: 0, recognised: false };
        // Shoptet vrací slevu jako kladné číslo (částka, o kterou se snižuje).
        total += Math.abs(parsed);
    }

    return { totalMinor: total, recognised: true };
}

/**
 * Částka na celé haléře. Vrací `null` místo hádání -- volající pak ví,
 * že hodnotě nerozumí, místo aby počítal s nulou.
 */
function parseAmountToMinor(value: number | string | undefined): number | null {
    if (value === undefined || value === null) return null;

    const text = typeof value === 'number' ? value.toString() : value.trim().replace(',', '.');
    if (!/^-?\d+(\.\d{1,2})?$/.test(text)) return null;

    const [whole = '0', frac = ''] = text.split('.');
    const negative = whole.startsWith('-');
    const minor = Number(negative ? whole.slice(1) : whole) * 100 + Number(frac.padEnd(2, '0'));

    if (!Number.isSafeInteger(minor)) return null;
    return negative ? -minor : minor;
}
