// HTTP helpery + structured logging. Vzor `corsResponse` / `jsonError`
// PŘEVZAT z ~/shoptet-cart-bypass-poc/src/worker.js, přepsán do TS.
//
// ZMĚNY OPROTI PoC:
//   1. PoC vrací `Access-Control-Allow-Origin: *` natvrdo. Tady je origin
//      volitelně omezitelný přes `ALLOWED_ORIGINS` -- validační endpoint
//      prozrazuje zůstatek platidla, takže wildcard je vědomé rozhodnutí
//      per tenant, ne default bez rozmyslu. Bez konfigurace se chová jako
//      PoC (`*`), protože Shoptet šablona běží na doméně e-shopu a
//      request nenese cookies (`credentials` se nepoužívají).
//   2. `Vary: Origin` -- bez něj by cache vrátila odpověď s cizím
//      `Allow-Origin` hlavičkou.
//   3. Structured logging (master rule "chyby čitelné bez dolování"):
//      jeden JSON řádek s `requestId`, ne `console.error("[Worker]", err)`.

export interface LogFields {
    readonly [key: string]: unknown;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Jeden strukturovaný řádek do Workers Logs (`observability.enabled: true`
 * v wrangler.jsonc). JSON, ne volný text -- jinak se v něm nedá filtrovat.
 *
 * NIKDY sem nepatří: `HMAC_SECRET`, celý token, plný kód voucheru.
 * Na to je `redactVoucherCode` / `redactToken` níže.
 */
export function log(level: LogLevel, event: string, fields: LogFields = {}): void {
    const line = JSON.stringify({
        level,
        event,
        ts: new Date().toISOString(),
        ...fields,
    });

    if (level === 'error') {
        console.error(line);
    } else if (level === 'warn') {
        console.warn(line);
    } else {
        console.log(line);
    }
}

/**
 * Kód voucheru je PLATIDLO (§4) -- do logu nesmí celý, jinak ho drží
 * kdokoli s přístupem k logům. Ponechá se prefix a poslední 4 znaky, což
 * stačí na dohledání incidentu, ale ne na uplatnění.
 */
export function redactVoucherCode(code: unknown): string {
    if (typeof code !== 'string' || code.length === 0) {
        return '<none>';
    }
    if (code.length <= 8) {
        return '***';
    }
    return `${code.slice(0, 6)}***${code.slice(-4)}`;
}

/** Z tokenu do logu jen prefix -- na korelaci stačí, na replay ne. */
export function redactToken(token: unknown): string {
    if (typeof token !== 'string' || token.length === 0) {
        return '<none>';
    }
    return `${token.slice(0, 8)}...`;
}

/** Strojově čitelné chybové kódy. Frontend na nich staví hlášky, ne na textu. */
export type ErrorCode =
    | 'INVALID_JSON'
    | 'VALIDATION_ERROR'
    | 'MISSING_BINDING'
    | 'NOT_FOUND'
    | 'METHOD_NOT_ALLOWED'
    | 'RATE_LIMITED'
    | 'REJECT_SIGNATURE'
    | 'REJECT_EXPIRED'
    | 'REJECT_REPLAY'
    | 'REJECT_AMOUNT_MISMATCH'
    | 'VOUCHER_NOT_FOUND'
    | 'VOUCHER_NOT_APPLICABLE'
    | 'REDEMPTION_CONFLICT'
    | 'HOLD'
    | 'STORAGE_UNAVAILABLE'
    | 'INTERNAL_ERROR';

/** Chyba s HTTP statusem a strojovým kódem. Vyhazuje ji route vrstva. */
export class ApiError extends Error {
    constructor(
        readonly code: ErrorCode,
        readonly status: number,
        message: string,
        readonly details?: LogFields,
    ) {
        super(message);
        this.name = 'ApiError';
    }
}

export function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
}

/** Tvar chybové odpovědi. `ok: false` je 1:1 z PoC (`jsonError`). */
export function jsonError(code: ErrorCode, message: string, status: number): Response {
    return jsonResponse({ ok: false, error: code, message }, status);
}

/**
 * Doplní CORS hlavičky. Vzor z PoC, rozšířený o allowlist a `Vary`.
 * Vrací NOVOU Response, protože hlavičky odpovědi z `Response.json()`
 * jsou v některých runtime immutable.
 */
export function withCors(response: Response, env: { ALLOWED_ORIGINS?: string }, origin: string | null): Response {
    const headers = new Headers(response.headers);

    headers.set('Access-Control-Allow-Origin', resolveAllowedOrigin(env.ALLOWED_ORIGINS, origin));
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Nexus-Signature');
    headers.set('Access-Control-Max-Age', '86400');
    // Bez Vary by sdílená cache podávala odpověď s Allow-Origin jiného originu.
    headers.append('Vary', 'Origin');

    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

/**
 * Bez `ALLOWED_ORIGINS` se chová jako PoC (`*`). S allowlistem vrací
 * konkrétní origin, jen když v seznamu je -- jinak `null`, což prohlížeč
 * odmítne. NIKDY nevrací origin, který v allowlistu není, jen proto, že
 * request nějaký poslal.
 */
function resolveAllowedOrigin(allowedOrigins: string | undefined, origin: string | null): string {
    if (!allowedOrigins || allowedOrigins.trim().length === 0) {
        return '*';
    }

    const allowed = allowedOrigins
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0);

    if (allowed.includes('*')) {
        return '*';
    }
    if (origin !== null && allowed.includes(origin)) {
        return origin;
    }
    return 'null';
}

/** Preflight. 204 bez těla, jako v PoC. */
export function preflightResponse(env: { ALLOWED_ORIGINS?: string }, origin: string | null): Response {
    return withCors(new Response(null, { status: 204 }), env, origin);
}
