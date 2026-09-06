// Minimální typy Worker runtime + Env binding kontrakt.
//
// PROČ VLASTNÍ TYPY A NE `@cloudflare/workers-types`:
// package.json ten balík dnes NEMÁ a přidávat závislost není součástí
// tohoto kroku (master rule: pinuj verze, upgrady vědomě). Worker vrstva
// potřebuje z celého D1 API jen `prepare/bind/first/run/batch` -- to je
// pár řádků. Až se balík doplní, tenhle soubor se smaže a nahradí
// `types: ["@cloudflare/workers-types"]` v workers/tsconfig.json.
//
// Tvary odpovídají veřejnému D1 API (developers.cloudflare.com/d1/worker-api).

export interface D1Meta {
    /** Počet změněných řádků. §7: `meta.changes === 1` je JEDINÝ důkaz úspěchu čerpání. */
    readonly changes: number;
    readonly duration: number;
    readonly last_row_id: number;
    readonly rows_read?: number;
    readonly rows_written?: number;
}

export interface D1Result<T = Record<string, unknown>> {
    readonly results: T[];
    readonly success: boolean;
    readonly meta: D1Meta;
    readonly error?: string;
}

export interface D1PreparedStatement {
    bind(...values: unknown[]): D1PreparedStatement;
    first<T = Record<string, unknown>>(): Promise<T | null>;
    first<T = unknown>(column: string): Promise<T | null>;
    run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
    all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface D1Database {
    prepare(query: string): D1PreparedStatement;
    /**
     * D1 batch je JEDNA implicitní transakce -- buď projde vše, nebo nic.
     * To je jediná dostupná atomicita: D1 nepodporuje interaktivní
     * BEGIN/COMMIT napříč await hranicemi. Čerpací UPDATE + INSERT
     * transakce proto MUSÍ jít jedním `batch()`, ne dvěma `run()`.
     */
    batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

/**
 * ============================================================================
 * KONTRAKT NONCE STORE -- replay protection (§6.2)
 * ============================================================================
 * V PoC je tohle Durable Object `SecurityCoordinator` s endpointem
 * `/reserve-nonce`: in-memory `Set` pro synchronní rezervaci + `state.storage`
 * pro perzistenci. Ten vzor je produkčně ověřený (parallel replay test).
 *
 * ZDE JE JEN ROZHRANÍ. DO třída se v tomhle kroku VĚDOMĚ NEPÍŠE -- je to
 * samostatná perzistenční vrstva s vlastním wrangler bindingem
 * (`durable_objects.bindings` + `migrations` v wrangler.jsonc, které tam
 * dnes nejsou) a patří do vlastního kroku.
 *
 * SÉMANTIKA, KTEROU IMPLEMENTACE MUSÍ SPLNIT:
 *   - `reserve(nonce)` je ATOMICKÉ test-and-set. Vrací `true` právě jednou
 *     pro daný nonce; každé další volání `false`. Ne "zkontroluj a pak zapiš"
 *     ve dvou krocích -- mezi nimi je TOCTOU okno a paralelní replay projde.
 *   - Musí být korektní i při SOUBĚŽNÝCH voláních ze dvou requestů. Proto
 *     DO (single-threaded aktér), ne KV (eventually consistent -- dva
 *     souběžné čtení uvidí "volný" nonce oba).
 *   - Selhání úložiště se NESMÍ tvářit jako úspěšná rezervace. Implementace
 *     hodí; volající (`routes/voucher.ts`) to překlopí na 503 a odečet
 *     neproběhne. U platidla je fail-closed jediná přípustná politika.
 *
 * ŽÁDNÝ FALLBACK: PoC má `CONFIG.MOCK_KV_STORE` pro případ chybějícího
 * bindingu. Pro platidlo se ten fallback NEKOPÍRUJE -- in-memory Map žije
 * per-isolate, takže by replay protection na druhém isolate mlčky
 * neexistovala. Chybí-li binding, request MUSÍ selhat.
 */
export interface NonceStore {
    /**
     * Atomická rezervace. `true` = nonce byl volný a je nyní zabraný.
     * `false` = už byl použit (replay).
     * Hodí při nedostupnosti úložiště -- NIKDY nevrací `true` "pro jistotu".
     */
    reserve(nonce: string, ttlSeconds: number): Promise<boolean>;
}

/** Durable Object namespace -- minimální tvar pro binding v `Env`. */
export interface DurableObjectId {
    toString(): string;
}

export interface DurableObjectStub {
    fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}

export interface DurableObjectNamespace {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): DurableObjectStub;
}

/**
 * Env bindingy. Povinné položky NEMAJÍ `?` -- ale TypeScript o runtime
 * realitě nic neví, takže se stejně validují za běhu
 * (`assertRequiredBindings` v index.ts). Typ je dokumentace, ne obrana.
 */
export interface Env {
    /** D1 binding dle wrangler.jsonc (`d1_databases[].binding = "DB"`). */
    readonly DB: D1Database;
    /**
     * HMAC klíč. NIKDY ve `vars` ani v wrangler.jsonc --
     * jen `wrangler secret put HMAC_SECRET` (příp. Secrets Store).
     */
    readonly HMAC_SECRET: string;
    /**
     * Durable Object pro nonce replay protection (§6.2). Binding dnes
     * v wrangler.jsonc NENÍ -- doplní ho krok, který DO třídu napíše.
     * Optional v typu, ale POVINNÝ za běhu pro `/redeem`: chybí-li,
     * redemption vrátí 503, nepokračuje bez replay ochrany.
     */
    readonly VOUCHER_SECURITY?: DurableObjectNamespace;
    /** Volitelný allowlist originů pro CORS, čárkou oddělený. */
    readonly ALLOWED_ORIGINS?: string;
    /** Sdílené tajemství order webhooku (Shoptet -> NEXUS). */
    readonly WEBHOOK_SECRET?: string;
}
