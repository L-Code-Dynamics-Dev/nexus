// ReadOnlyGuard -- konstrukční zámek proti zápisu do ŽIVÉHO Shoptetu.
//
// KONTEXT (Lucky, 2026-09-07): token, se kterým se pracuje, je
// **produkční API token okfish.sk**. Ne sandbox, ne test. Každé zápisové
// volání by se okamžitě projevilo na e-shopu, který právě prodává.
//
// Lucky doslova: *"nic nesmíš zapsat na živý web"*.
//
// PROČ TŘÍDA A NE JEN PRAVIDLO V HLAVĚ:
//   Slib "budu dělat jen GET" drží přesně do chvíle, než někdo (já, agent,
//   budoucí vývojář) napíše `method: 'PATCH'` a nevšimne si toho. Zámek musí
//   být v kódu, aby zápis SELHAL, ne aby se na něj jen zapomnělo.
//
//   Stejný princip jako `assertNoShoptetToken()` v shadow harness: ten tvrdě
//   padá, když token vůbec najde v prostředí. Tady je to obráceně -- token
//   povolený je, ale jen na čtení.
//
// FAIL-CLOSED: neznámá metoda se bere jako zápis. Kdyby Shoptet zavedl něco
// nového, propustit to "protože to není v seznamu" by bylo přesně to selhání,
// kterému se tenhle soubor vyhýbá.

/** HTTP metody, které nic nemění. Cokoli mimo tenhle seznam je zápis. */
const READ_ONLY_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export class ShoptetWriteBlockedError extends Error {
    constructor(method: string, url: string) {
        super(
            `ZÁPIS DO ŽIVÉHO SHOPTETU ZABLOKOVÁN: ${method} ${url}\n` +
                `Token je produkční (okfish.sk). Read-only režim je výchozí a vypíná se ` +
                `jen explicitně -- viz connectors/shoptet/ReadOnlyGuard.ts.\n` +
                `Pokud zápis opravdu potřebuješ, musí to být VĚDOMÉ rozhodnutí ` +
                `s dry-run diffem a schválením, ne obejití téhle kontroly.`,
        );
        this.name = 'ShoptetWriteBlockedError';
    }
}

export interface ShoptetRequestPlan {
    readonly method: string;
    readonly url: string;
    readonly body?: unknown;
}

/**
 * Režim klienta. `read-only` je JEDINÝ výchozí -- konstruktor klienta ho
 * nesmí odvozovat z prostředí ani z konfigurace, jinak by stačila překlep
 * v env proměnné a zámek by zmizel.
 */
export type ShoptetAccessMode =
    | { readonly mode: 'read-only' }
    | {
          readonly mode: 'write-enabled';
          /**
           * Povinné zdůvodnění. Není to dekorace: nutí autora napsat, PROČ
           * zápis potřebuje, a to zdůvodnění skončí v logu a v code review.
           * Prázdný string je odmítnutý.
           */
          readonly justification: string;
          /**
           * Potvrzení, že proti tomuhle konkrétnímu cíli má zápis proběhnout.
           * Musí to být přesná doména, ne wildcard -- zabrání to tomu, aby
           * povolení pro sandbox omylem platilo i pro produkci.
           */
          readonly allowedHost: string;
      };

export const READ_ONLY: ShoptetAccessMode = { mode: 'read-only' };

/**
 * Ověří, že plánovaný požadavek smí odejít. Volá se PŘED každým `fetch`.
 *
 * Hází, místo aby vracela boolean: návratovou hodnotu jde ignorovat,
 * výjimku ne.
 */
export function assertRequestAllowed(
    plan: ShoptetRequestPlan,
    access: ShoptetAccessMode,
): void {
    const method = plan.method.toUpperCase();

    // Čtení projde vždy, bez ohledu na režim.
    if (READ_ONLY_METHODS.has(method)) return;

    if (access.mode === 'read-only') {
        throw new ShoptetWriteBlockedError(method, plan.url);
    }

    if (access.justification.trim() === '') {
        throw new ShoptetWriteBlockedError(
            method,
            `${plan.url} (write-enabled bez zdůvodnění -- justification nesmí být prázdné)`,
        );
    }

    // Host musí sedět přesně. Povolení pro jeden cíl nesmí platit pro jiný.
    let host: string;
    try {
        host = new URL(plan.url).host;
    } catch {
        throw new ShoptetWriteBlockedError(method, `${plan.url} (neplatná URL)`);
    }

    if (host !== access.allowedHost) {
        throw new ShoptetWriteBlockedError(
            method,
            `${plan.url} (zápis povolen jen pro "${access.allowedHost}", ne pro "${host}")`,
        );
    }
}

/**
 * Popis požadavku pro dry-run výpis. Když se zápis zablokuje, tohle je to,
 * co by se bylo odeslalo -- aby šlo zkontrolovat payload bez rizika.
 *
 * Tělo se ZKRACUJE: cenový PATCH nad tisíci produkty by jinak zaplavil log
 * a to podstatné by se v něm ztratilo.
 */
export function describeRequest(plan: ShoptetRequestPlan, maxBodyChars = 2000): string {
    const lines = [`${plan.method.toUpperCase()} ${plan.url}`];

    if (plan.body !== undefined) {
        let serialized: string;
        try {
            serialized = JSON.stringify(plan.body, null, 2);
        } catch {
            serialized = '<tělo nejde serializovat do JSON>';
        }
        if (serialized.length > maxBodyChars) {
            serialized = `${serialized.slice(0, maxBodyChars)}\n… (zkráceno, celkem ${serialized.length} znaků)`;
        }
        lines.push(serialized);
    }

    return lines.join('\n');
}
