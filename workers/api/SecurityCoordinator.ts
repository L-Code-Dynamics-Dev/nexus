// Durable Object `SecurityCoordinator` -- bezpečnostní koordinátor voucher Workeru
// (docs/design-proposals/Digital-Voucher.md §4 rate limit, §6.2 replay protection).
//
// ============================================================================
// PROČ DURABLE OBJECT A NE KV
// ============================================================================
// Rezervace nonce musí být ATOMICKÉ test-and-set (viz kontrakt `NonceStore`
// v types.ts). KV je eventually consistent -- dva souběžné requesty by oba
// přečetly "nonce je volný" a oba by prošly. DO je single-threaded aktér:
// jeden objekt (`idFromName('global')`) zpracovává requesty sériově, takže
// mezi čtením a zápisem nikdo jiný nevleze.
//
// ============================================================================
// PŘEVZATO Z PoC (~/shoptet-cart-bypass-poc/src/worker.js, třída
// `SecurityCoordinator`) -- PRODUKČNĚ OVĚŘENÝ VZOR
// ============================================================================
// Parallel replay test na PoC: 10 souběžných requestů s týmž nonce ->
// 1x ACCEPT, 9x REJECT_REPLAY. Přebírá se:
//   1. DVOUSTUPŇOVÁ REZERVACE: nejdřív in-memory `Set`, teprve pak
//      `state.storage`. Set je SYNCHRONNÍ -- chytne souběh, který vznikne
//      mezi `await storage.get()` a `await storage.put()`. Bez něj by dva
//      requesty, které dorazí ve stejném mikrosekundovém okně, obě viděly
//      prázdné storage (DO sice běží single-threaded, ale `await` uvolní
//      event loop a druhý request se mezitím dostane ke slovu).
//      Storage je pak PERZISTENCE -- přežije eviction isolate, kdy se Set
//      vyprázdní sám od sebe.
//   2. Tvar odpovědi `{ok:true}` / `{ok:false, reason:'REJECT_REPLAY'}` --
//      `resolveNonceStore` v routes/voucher.ts čte přesně `data.ok === true`.
//   3. Endpointy `/reserve-nonce?nonce=` a `/rate-limit?key=` na interním
//      `fetch()` rozhraní DO.
//
// ============================================================================
// ZLEPŠENO OPROTI PoC -- a PROČ. V PoC jsou to vědomé zkratky pro PoC;
// pro PLATIDLO nestačí.
// ============================================================================
// (Z1) ŽÁDNÝ GLOBÁLNÍ `clear()`.
//      PoC dělá `if (this.reservedNonces.size > 1000) this.reservedNonces.clear()`
//      a totéž pro `rateLimits`. U nonce to ještě zachrání perzistentní
//      storage (Set je jen cache před ním), ALE u rate limitu je to díra:
//      vyprázdnění mapy resetuje počítadla VŠEM najednou. Útočník si to
//      umí vynutit -- pošle requesty z ~1000 různých klíčů, mapa přeteče,
//      jeho vlastní limit se vynuluje a může jet dál. Tady se místo toho
//      mažou JEN EXPIROVANÉ záznamy (podle času), a teprve když ani to
//      nestačí, LRU podle času posledního dotyku. Nikdy plošně.
//
// (Z2) TTL + `state.storage.setAlarm()` NA ÚKLID NONCE.
//      PoC zapisuje `storage.put(nonce, Date.now())` a nikdy nemaže --
//      storage roste donekonečna a s ním i účet i doba `list()`. Nonce
//      starší než `NONCE_MAX_AGE_MS` už NEMÁ CENU držet: token, ke kterému
//      patří, stejně expiroval na TTL kontrole ve Workeru
//      (`TOKEN_MAX_AGE_SECONDS`, vzor `MAX_AGE_SEC` z PoC), takže i kdyby
//      ho někdo přehrál, spadne dřív na `REJECT_EXPIRED`.
//      POZOR NA POŘADÍ VRSTEV: nonce se drží DÉLE než token
//      (`NONCE_TTL_SECONDS = TOKEN_MAX_AGE_SECONDS * 4` ve voucher.ts).
//      Úklid se proto řídí TTL, které pošle volající, ne konstantou tady --
//      smazat nonce dřív, než expiruje token, by replay ochranu otevřelo.
//
// (Z3) SLIDING WINDOW MÍSTO FIXED WINDOW.
//      PoC: `{count, windowStart}` a reset po 60 s. To dovolí 2x limit na
//      hranici okna -- 10 requestů v 59. sekundě a dalších 10 v 61. je
//      20 requestů za 2 sekundy, přestože limit zní "10 za minutu".
//      U endpointu, který prozrazuje ZŮSTATEK PLATIDLA (§6.1), je
//      dvojnásobná propustnost na hádání kódu reálný rozdíl. Tady se drží
//      seřazená pole timestampů a okno se posouvá spojitě.
//
// (Z4) `state.blockConcurrencyWhile()` V KONSTRUKTORU.
//      Bez něj by první request mohl doběhnout dřív, než se dočte stav ze
//      storage, a viděl by prázdný `nonceIndex` -- tedy "nonce je volný"
//      i pro nonce, který v storage je. `blockConcurrencyWhile` drží
//      všechny příchozí requesty, dokud inicializace neskončí.
//
// (Z5) FAIL-CLOSED NA CHYBĚ ÚLOŽIŠTĚ.
//      PoC nemá kolem `storage` try/catch. Selhání by probublalo jako
//      neošetřená výjimka a `resolveNonceStore` by z ní udělal 503 --
//      což je náhodou správně, ale spoléhat na náhodu u peněz nejde.
//      Tady se chyba loguje strukturovaně a vrací 503 VĚDOMĚ. NIKDY se
//      nevrací `{ok:true}` "pro jistotu": nedostupné úložiště neznamená
//      volný nonce.
//
// NEPŘEVZATO Z PoC: geocode fronta (`/geocode`, Nominatim throttling).
// Je to logika Goliáše, s voucherem nemá nic společného a v DO by jen
// držela stav a alarm sloty navíc.

import { log } from './http.js';

// ---------------------------------------------------------------------------
// Minimální typy DO runtime.
//
// PROČ VLASTNÍ A NE `@cloudflare/workers-types`: stejný důvod jako
// v types.ts -- balík v package.json není a přidávat závislost není součástí
// tohoto kroku (master rule: pinuj verze, upgrady vědomě). Z celého DO API
// potřebujeme `storage.get/put/delete/list/setAlarm` a
// `blockConcurrencyWhile`. Tvary odpovídají veřejnému API
// (developers.cloudflare.com/durable-objects/api/state).
// ---------------------------------------------------------------------------

interface DurableObjectListOptions {
    readonly prefix?: string;
    readonly limit?: number;
}

interface DurableObjectStorage {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put<T = unknown>(key: string, value: T): Promise<void>;
    put<T = unknown>(entries: Record<string, T>): Promise<void>;
    delete(key: string): Promise<boolean>;
    delete(keys: string[]): Promise<number>;
    list<T = unknown>(options?: DurableObjectListOptions): Promise<Map<string, T>>;
    setAlarm(scheduledTime: number | Date): Promise<void>;
    getAlarm(): Promise<number | null>;
}

interface DurableObjectState {
    readonly storage: DurableObjectStorage;
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// Konfigurace
// ---------------------------------------------------------------------------

/**
 * Prefix klíčů nonce ve storage. Odděluje je od případných budoucích klíčů
 * (metadata, počítadla) -- `list({prefix})` pak nemusí číst všechno.
 */
const NONCE_KEY_PREFIX = 'n:';

/**
 * Horní strop stáří nonce. Odpovídá `MAX_AGE_SEC` z PoC (5 min) x rezerva:
 * `routes/voucher.ts` posílá `NONCE_TTL_SECONDS = 300 * 4 = 1200 s`.
 * Tenhle strop je POJISTKA proti nesmyslnému `ttl` z requestu, ne primární
 * hodnota -- ta chodí od volajícího.
 */
const NONCE_TTL_MAX_SECONDS = 24 * 60 * 60;

/** Dolní mez TTL -- chrání před `ttl=0`, které by nonce smazalo hned. */
const NONCE_TTL_MIN_SECONDS = 60;

/** Default, když `ttl` v query chybí nebo je nesmyslné. Konzervativně dlouhý. */
const NONCE_TTL_DEFAULT_SECONDS = 1200;

/**
 * Strop in-memory cache nonce. Set je jen ZRYCHLENÍ a ochrana proti
 * mikrosekundovému souběhu -- autorita je storage. Při překročení se
 * (Z1) mažou nejstarší záznamy, ne celý Set.
 */
const NONCE_MEMORY_LIMIT = 5000;

/** Sliding window rate limitu (§4). */
const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Limit na klíč. Volající posílá `limit=` (per-IP jinak než globálně),
 * tohle je default a zároveň hodnota z PoC (`MAX_REQUESTS = 10`).
 */
const RATE_LIMIT_DEFAULT_MAX = 10;

/** Horní strop `limit=` z query -- klient si nesmí limit zvednout sám. */
const RATE_LIMIT_MAX_ALLOWED = 600;

/**
 * Strop počtu sledovaných klíčů. Rate limit je čistě in-memory (do storage
 * se NEPERZISTUJE): přežít restart nemusí, okno je 60 s a zápis každého
 * requestu do storage by byl dražší než samotná ochrana.
 */
const RATE_LIMIT_KEY_LIMIT = 10_000;

/** Perioda alarmu pro úklid expirovaných nonce (Z2). */
const CLEANUP_INTERVAL_MS = 5 * 60_000;

/** Kolik nonce klíčů projít v jednom běhu alarmu -- aby úklid neběžel do timeoutu. */
const CLEANUP_BATCH_LIMIT = 1000;

// ---------------------------------------------------------------------------

/** Hodnota nonce ve storage. PoC ukládal holé `Date.now()`; tady i expiraci. */
interface NonceRecord {
    readonly reservedAt: number;
    readonly expiresAt: number;
}

/**
 * ============================================================================
 * SecurityCoordinator
 * ============================================================================
 * Adresuje se `idFromName('global')` -- JEDEN objekt pro celý Worker.
 *
 * PROČ JEDEN A NE PER-IP: replay protection MUSÍ být globální (nonce použitý
 * z jedné IP nesmí projít z druhé). Rate limit by se dal škálovat na víc
 * objektů, ale §4 chce i GLOBÁLNÍ limit, který jde spočítat jen na jednom
 * místě. Propustnost jednoho DO (řádově tisíce req/s) je pro voucher provoz
 * s velkou rezervou dost; kdyby přestala stačit, dělí se AŽ rate limit
 * (např. `idFromName('rl:' + ipPrefix)`), nikdy ne nonce.
 */
export class SecurityCoordinator {
    private readonly state: DurableObjectState;

    /**
     * Synchronní rezervace (PoC vzor). `nonce -> expiresAt`. Map místo Setu,
     * aby šlo (Z1) mazat podle času, ne plošným `clear()`.
     */
    private readonly nonceCache = new Map<string, number>();

    /**
     * (Z3) Sliding window: `klíč -> seřazená pole timestampů requestů`.
     * PoC měl `{count, windowStart}` = fixed window.
     */
    private readonly rateWindows = new Map<string, number[]>();

    /** Hlídá, že se alarm plánuje jen když je co uklízet. */
    private cleanupScheduled = false;

    constructor(state: DurableObjectState) {
        this.state = state;

        // (Z4) Dokud běží tenhle callback, DO NEPŘIJÍMÁ requesty. Bez toho by
        // první `/reserve-nonce` po probuzení isolate mohl číst prázdnou cache
        // a alarm by se nikdy nenaplánoval.
        void this.state.blockConcurrencyWhile(async () => {
            try {
                const stored = await this.state.storage.list<NonceRecord>({
                    prefix: NONCE_KEY_PREFIX,
                    limit: NONCE_MEMORY_LIMIT,
                });

                const now = Date.now();
                for (const [key, record] of stored) {
                    if (record !== null && typeof record === 'object' && record.expiresAt > now) {
                        this.nonceCache.set(key.slice(NONCE_KEY_PREFIX.length), record.expiresAt);
                    }
                }

                // Alarm se obnoví po každém probuzení isolate -- jinak by po
                // eviction zůstalo storage bez úklidu, dokud nepřijde zápis.
                const existing = await this.state.storage.getAlarm();
                if (existing === null && stored.size > 0) {
                    await this.state.storage.setAlarm(Date.now() + CLEANUP_INTERVAL_MS);
                }
                this.cleanupScheduled = existing !== null || stored.size > 0;
            } catch (error) {
                // Selhání inicializace NESMÍ shodit konstruktor -- DO by se
                // nerestartoval do funkčního stavu. Cache zůstane prázdná,
                // autoritou je stejně storage a `/reserve-nonce` na její
                // nedostupnost odpoví 503 (Z5).
                log('error', 'security_do.init_failed', {
                    alert: true,
                    message: errorMessage(error),
                });
            }
        });
    }

    // -----------------------------------------------------------------------
    // Interní HTTP rozhraní. Volá ho `resolveNonceStore` v routes/voucher.ts
    // přes `stub.fetch('https://voucher-security.internal/...')`.
    // -----------------------------------------------------------------------

    async fetch(request: Request): Promise<Response> {
        let url: URL;
        try {
            url = new URL(request.url);
        } catch {
            return jsonBody({ ok: false, reason: 'BAD_REQUEST' }, 400);
        }

        switch (url.pathname) {
            case '/reserve-nonce':
                return this.handleReserveNonce(url);
            case '/rate-limit':
                return this.handleRateLimit(url);
            case '/health':
                return this.handleHealth();
            default:
                return jsonBody({ ok: false, reason: 'NOT_FOUND' }, 404);
        }
    }

    /**
     * Alarm handler (Z2). Smaže expirované nonce ze storage i z cache
     * a přeplánuje se, dokud je co uklízet.
     *
     * Mazání je DÁVKOVÉ (`CLEANUP_BATCH_LIMIT`) -- při velkém provozu by
     * jeden běh přes celé storage narazil na limit doby běhu. Zbytek dobere
     * další alarm; nic se neztratí, jen se uklidí o pár minut později.
     */
    async alarm(): Promise<void> {
        const now = Date.now();
        let deleted = 0;
        let remaining = 0;

        try {
            const stored = await this.state.storage.list<NonceRecord>({
                prefix: NONCE_KEY_PREFIX,
                limit: CLEANUP_BATCH_LIMIT,
            });

            const expiredKeys: string[] = [];
            for (const [key, record] of stored) {
                const expiresAt =
                    record !== null && typeof record === 'object' ? record.expiresAt : 0;
                if (expiresAt <= now) {
                    expiredKeys.push(key);
                    this.nonceCache.delete(key.slice(NONCE_KEY_PREFIX.length));
                } else {
                    remaining += 1;
                }
            }

            if (expiredKeys.length > 0) {
                deleted = await this.state.storage.delete(expiredKeys);
            }

            // Úklid cache tady taky -- záznamy, které v tomhle batchi nebyly.
            this.pruneNonceCache(now);

            // Přeplánovat, dokud storage není prázdné. `stored.size` na stropu
            // batche znamená, že tam pravděpodobně je ještě další stránka.
            const shouldReschedule = remaining > 0 || stored.size >= CLEANUP_BATCH_LIMIT;
            this.cleanupScheduled = shouldReschedule;
            if (shouldReschedule) {
                await this.state.storage.setAlarm(now + CLEANUP_INTERVAL_MS);
            }

            log('info', 'security_do.cleanup', {
                scanned: stored.size,
                deleted,
                remaining,
                rescheduled: shouldReschedule,
            });
        } catch (error) {
            // Selhání úklidu není bezpečnostní problém (nonce se jen drží
            // déle, což je fail-safe směr), ale nesmí zabít alarm smyčku.
            log('error', 'security_do.cleanup_failed', {
                alert: true,
                message: errorMessage(error),
            });
            try {
                await this.state.storage.setAlarm(Date.now() + CLEANUP_INTERVAL_MS);
            } catch (retryError) {
                this.cleanupScheduled = false;
                log('error', 'security_do.cleanup_reschedule_failed', {
                    alert: true,
                    message: errorMessage(retryError),
                });
            }
        }
    }

    // -----------------------------------------------------------------------
    // /reserve-nonce  (§6.2)
    // -----------------------------------------------------------------------

    /**
     * ATOMICKÉ test-and-set. Vrací `{ok:true}` právě JEDNOU pro daný nonce.
     *
     * POŘADÍ KROKŮ JE KRITICKÉ a je 1:1 z PoC:
     *   1. in-memory Map -- SYNCHRONNÍ, žádný `await` mezi testem a zápisem,
     *      takže tudy neprojde souběh vzniklý na `await` hranici storage;
     *   2. teprve pak storage -- perzistence přes restart isolate.
     * Prohodit je nelze: kdyby se nejdřív četlo storage, dva souběžné
     * requesty by mezi `get` a `put` oba viděly volno.
     */
    private async handleReserveNonce(url: URL): Promise<Response> {
        const nonce = url.searchParams.get('nonce');
        if (nonce === null || nonce.length === 0 || nonce.length > 128) {
            // Délka je omezená schválně: klíč storage z neomezeného vstupu
            // je cesta, jak DO zaplnit jedním requestem.
            return jsonBody({ ok: false, reason: 'BAD_REQUEST' }, 400);
        }

        const ttlSeconds = clampInt(
            url.searchParams.get('ttl'),
            NONCE_TTL_MIN_SECONDS,
            NONCE_TTL_MAX_SECONDS,
            NONCE_TTL_DEFAULT_SECONDS,
        );

        const now = Date.now();
        const expiresAt = now + ttlSeconds * 1000;

        // --- KROK 1: synchronní rezervace (PoC vzor) ---
        const cached = this.nonceCache.get(nonce);
        if (cached !== undefined && cached > now) {
            log('warn', 'security_do.nonce.replay_memory', { nonceLength: nonce.length });
            return jsonBody({ ok: false, reason: 'REJECT_REPLAY' }, 200);
        }

        // Zapisuje se PŘED `await` na storage -- to je celý smysl kroku 1.
        this.nonceCache.set(nonce, expiresAt);

        const storageKey = `${NONCE_KEY_PREFIX}${nonce}`;

        try {
            // --- KROK 2: perzistence ---
            const existing = await this.state.storage.get<NonceRecord>(storageKey);
            if (existing !== undefined && existing !== null && existing.expiresAt > now) {
                log('warn', 'security_do.nonce.replay_storage', { nonceLength: nonce.length });
                return jsonBody({ ok: false, reason: 'REJECT_REPLAY' }, 200);
            }

            await this.state.storage.put<NonceRecord>(storageKey, { reservedAt: now, expiresAt });
        } catch (error) {
            // (Z5) FAIL-CLOSED. Rezervace se z cache VRACÍ ZPĚT: kdyby tam
            // zůstala, legitimní retry téhož webhooku (po 503) by narazil na
            // "replay" z rezervace, která se nikdy nezapsala, a odečet by
            // navždy propadl. Vrátit ji je bezpečné -- storage zápis
            // neproběhl, takže nikdo neodečetl nic.
            this.nonceCache.delete(nonce);
            log('error', 'security_do.nonce.storage_failed', {
                alert: true,
                message: errorMessage(error),
            });
            return jsonBody({ ok: false, reason: 'STORAGE_UNAVAILABLE' }, 503);
        }

        // (Z1) Cache se ořezává podle ČASU, ne plošným `clear()`.
        this.pruneNonceCache(now);
        // (Z2) Zajistí, že storage nebude růst donekonečna.
        await this.ensureCleanupScheduled(now);

        return jsonBody({ ok: true }, 200);
    }

    // -----------------------------------------------------------------------
    // /rate-limit  (§4)
    // -----------------------------------------------------------------------

    /**
     * (Z3) SLIDING WINDOW.
     *
     * Drží se timestampy jednotlivých requestů v posledních
     * `RATE_LIMIT_WINDOW_MS`. Okno se posouvá spojitě, takže hraniční trik
     * z fixed window (2x limit přes hranu minuty) nefunguje.
     *
     * Volající posílá `key=` -- `ip:1.2.3.4` pro per-IP limit a `global`
     * pro globální, oba požaduje §4. DO je jen počítadlo, o strategii
     * rozhoduje volající.
     *
     * ODPOVĚĎ NENÍ 429, ale 200 s `{ok:false}`: 429 je odpověď PRO KLIENTA,
     * kterou skládá Worker. Interní volání DO 429 nevrací, aby se nespletlo
     * se skutečnou chybou stubu (`!response.ok` u volajícího).
     */
    private handleRateLimit(url: URL): Response {
        const key = url.searchParams.get('key');
        if (key === null || key.length === 0 || key.length > 128) {
            return jsonBody({ ok: false, reason: 'BAD_REQUEST' }, 400);
        }

        const limit = clampInt(
            url.searchParams.get('limit'),
            1,
            RATE_LIMIT_MAX_ALLOWED,
            RATE_LIMIT_DEFAULT_MAX,
        );
        const windowMs = clampInt(
            url.searchParams.get('windowMs'),
            1_000,
            10 * RATE_LIMIT_WINDOW_MS,
            RATE_LIMIT_WINDOW_MS,
        );

        const now = Date.now();
        const cutoff = now - windowMs;

        const timestamps = this.rateWindows.get(key) ?? [];

        // Pole je vzestupně seřazené (přidává se jen na konec), takže stačí
        // najít první index uvnitř okna a zbytek zahodit -- O(n) bez filtru.
        let firstFresh = 0;
        while (firstFresh < timestamps.length && (timestamps[firstFresh] as number) <= cutoff) {
            firstFresh += 1;
        }
        const fresh = firstFresh === 0 ? timestamps : timestamps.slice(firstFresh);

        if (fresh.length >= limit) {
            // Zapamatovat si ořezané pole i při odmítnutí -- jinak by se
            // stará data hromadila u klienta, který jede pořád na limitu.
            this.rateWindows.set(key, fresh);

            const retryAfterMs = Math.max(0, (fresh[0] as number) + windowMs - now);
            log('warn', 'security_do.rate_limited', {
                key,
                limit,
                windowMs,
                hits: fresh.length,
            });
            return jsonBody(
                {
                    ok: false,
                    reason: 'RATE_LIMITED',
                    retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
                },
                200,
            );
        }

        fresh.push(now);
        this.rateWindows.set(key, fresh);

        // (Z1) Při přetečení se NEMAŽE všechno (to by resetovalo limity i
        // útočníkovi). Nejdřív pryč prázdná/expirovaná okna, teprve pak LRU.
        if (this.rateWindows.size > RATE_LIMIT_KEY_LIMIT) {
            this.pruneRateWindows(now, windowMs);
        }

        return jsonBody({ ok: true, remaining: limit - fresh.length }, 200);
    }

    // -----------------------------------------------------------------------
    // /health -- ověření instalace (binding + storage + alarm)
    // -----------------------------------------------------------------------

    /**
     * Neověřuje jen "DO odpovídá", ale i to, že STORAGE ČTE. Binding může
     * existovat a objekt běžet, přitom storage selhává -- a to je stav,
     * ve kterém `/redeem` odmítne všechno na 503. Health to musí ukázat
     * dřív, než na to narazí zákazník.
     */
    private async handleHealth(): Promise<Response> {
        const now = Date.now();
        try {
            const alarmAt = await this.state.storage.getAlarm();
            return jsonBody(
                {
                    ok: true,
                    storage: 'ok',
                    nonceCacheSize: this.nonceCache.size,
                    rateLimitKeys: this.rateWindows.size,
                    cleanupScheduled: this.cleanupScheduled,
                    alarmAt,
                    now,
                },
                200,
            );
        } catch (error) {
            log('error', 'security_do.health_storage_failed', {
                alert: true,
                message: errorMessage(error),
            });
            return jsonBody({ ok: false, reason: 'STORAGE_UNAVAILABLE', now }, 503);
        }
    }

    // -----------------------------------------------------------------------
    // Údržba paměti (Z1)
    // -----------------------------------------------------------------------

    /**
     * (Z1) Nejdřív se mažou EXPIROVANÉ záznamy. Teprve když ani po tom není
     * pod stropem, mažou se nejstarší (LRU podle expirace = podle času
     * rezervace, TTL je pro všechny stejné).
     *
     * PoC dělal `clear()`. U nonce to nebyla přímá díra -- autoritou je
     * storage a to se nemazalo -- ale vyhozením cache se ztrácí ochrana
     * proti mikrosekundovému souběhu, kvůli které Set vůbec existuje.
     */
    private pruneNonceCache(now: number): void {
        if (this.nonceCache.size <= NONCE_MEMORY_LIMIT) {
            // Levný průběžný úklid: expirované záznamy pryč i pod stropem.
            for (const [nonce, expiresAt] of this.nonceCache) {
                if (expiresAt <= now) {
                    this.nonceCache.delete(nonce);
                }
            }
            return;
        }

        for (const [nonce, expiresAt] of this.nonceCache) {
            if (expiresAt <= now) {
                this.nonceCache.delete(nonce);
            }
        }

        if (this.nonceCache.size <= NONCE_MEMORY_LIMIT) {
            return;
        }

        // LRU: Map iteruje v pořadí vložení, takže nejstarší jsou na začátku.
        const excess = this.nonceCache.size - NONCE_MEMORY_LIMIT;
        let removed = 0;
        for (const nonce of this.nonceCache.keys()) {
            if (removed >= excess) {
                break;
            }
            this.nonceCache.delete(nonce);
            removed += 1;
        }

        log('warn', 'security_do.nonce_cache_evicted', {
            removed,
            size: this.nonceCache.size,
        });
    }

    /**
     * (Z1) Rate limit: mažou se JEN klíče, jejichž okno je celé za horizontem
     * -- ty už žádnou informaci nenesou. Plošný `clear()` z PoC by odpustil
     * i útočníkovi, který přetečení sám vyvolal.
     *
     * Kdyby ani to nestačilo (10k aktivních klíčů v jednom okně), padne LRU
     * podle nejstaršího requestu. To je vědomý kompromis: paměť DO je
     * konečná a odmítat legitimní provoz kvůli plné mapě je horší než
     * zapomenout nejstarší okna.
     */
    private pruneRateWindows(now: number, windowMs: number): void {
        const cutoff = now - windowMs;
        let removed = 0;

        for (const [key, timestamps] of this.rateWindows) {
            const last = timestamps.length === 0 ? 0 : (timestamps[timestamps.length - 1] as number);
            if (last <= cutoff) {
                this.rateWindows.delete(key);
                removed += 1;
            }
        }

        if (this.rateWindows.size > RATE_LIMIT_KEY_LIMIT) {
            const excess = this.rateWindows.size - RATE_LIMIT_KEY_LIMIT;
            let evicted = 0;
            for (const key of this.rateWindows.keys()) {
                if (evicted >= excess) {
                    break;
                }
                this.rateWindows.delete(key);
                evicted += 1;
            }
            removed += evicted;
        }

        log('warn', 'security_do.rate_windows_pruned', {
            removed,
            size: this.rateWindows.size,
        });
    }

    /**
     * (Z2) Naplánuje úklidový alarm, pokud žádný neběží.
     *
     * Selhání se NEPROPAGUJE do odpovědi: rezervace nonce už je zapsaná
     * a platná; nenaplánovaný alarm znamená jen to, že storage poroste
     * do dalšího zápisu. Shodit kvůli tomu `/redeem` na 503 by byla horší
     * chyba než odložený úklid.
     */
    private async ensureCleanupScheduled(now: number): Promise<void> {
        if (this.cleanupScheduled) {
            return;
        }
        try {
            const existing = await this.state.storage.getAlarm();
            if (existing === null) {
                await this.state.storage.setAlarm(now + CLEANUP_INTERVAL_MS);
            }
            this.cleanupScheduled = true;
        } catch (error) {
            log('warn', 'security_do.alarm_schedule_failed', {
                message: errorMessage(error),
            });
        }
    }
}

// ---------------------------------------------------------------------------
// Pomocné funkce
// ---------------------------------------------------------------------------

/**
 * Odpověď DO. Interní rozhraní, žádné CORS -- ven se nikdy nedostane,
 * volá ji jen Worker přes stub.
 */
function jsonBody(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
}

/**
 * Číslo z query s TVRDÝMI mezemi. Bez clampu by si volající mohl poslat
 * `limit=1000000` a rate limit vypnout -- což je sice interní volání, ale
 * limity mají být rozhodnuté tady, ne v query stringu.
 */
function clampInt(raw: string | null, min: number, max: number, fallback: number): number {
    if (raw === null) {
        return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, parsed));
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
