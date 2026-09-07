// forwardToNexus -- PŘEPOSLÁNÍ Shoptet webhooku z okfish Workeru do NEXUSu.
//
// ============================================================================
// TENHLE SOUBOR NEPATŘÍ DO NEXUSU -- JE URČENÝ KE ZKOPÍROVÁNÍ DO OKFISHE
// ============================================================================
// Leží v `docs/okfish-integration/`, ne ve `workers/`, schválně: je to kód
// pro CIZÍ repozitář (`okfish-pricing-engine`, `cloudflare-worker/src/`).
// NEXUS ho nekompiluje ani nepouští.
//
// Nasazuje ho Lucky, ne agent -- je to zásah do živého Workeru, který právě
// obsluhuje produkční e-shop.
//
// ============================================================================
// PROČ VŮBEC
// ============================================================================
// Shoptet dovolí JEN JEDNU URL NA EVENT. Na okfish.sk už `order:create` míří
// na `shoptet-vip-worker.hlancaric.workers.dev`. Registrovat NEXUS přímo by
// ten webhook PŘEPSALO a okfish by přestal dostávat objednávky -- tichý
// výpadek, který by se poznal až podle nesynchronizovaných cen.
//
// Řešení: okfish si webhook nechává a payload přepošle dál.
//
//   Shoptet ──order:create──> okfish Worker ──> (jeho práce: GitHub dispatch)
//                                   └─ ctx.waitUntil(forwardToNexus(...)) ──> NEXUS
//
// ============================================================================
// ZÁRUKY, KTERÉ TAHLE FUNKCE DRŽÍ
// ============================================================================
// 1. NIKDY nehodí. Objednávka okfishe se nesmí rozbít kvůli tomu, že je
//    NEXUS dole. Všechny chyby se polykají a jen logují.
// 2. NIKDY nemění payload. Přeposílá PŘESNĚ to tělo, které přišlo ze
//    Shoptetu -- protože HMAC podpis je počítaný nad ním. Kdyby se
//    přeparsovalo přes JSON.parse/stringify, rozešly by se bílé znaky
//    a pořadí klíčů a NEXUS by podpis odmítl.
// 3. NIKDY nezaloguje token ani podpis.
// 4. Má tvrdý timeout -- `ctx.waitUntil` sice běží po odpovědi, ale
//    zaseknuté spojení by drželo isolate naživu zbytečně dlouho.
// 5. Neřeší idempotenci. Řeší ji NEXUS: issuance je idempotentní na
//    `(tenantId, sourceOrderId)` přes `uq_vouchers_source_order`, takže
//    dvojí přeposlání nevystaví dva poukazy.
//
// ============================================================================
// JAK TO NASADIT
// ============================================================================
// 1. Zkopírovat tenhle soubor do `cloudflare-worker/src/forward-to-nexus.ts`
// 2. V `index.ts` do webhook handleru, ZA stávající `triggerGithubSync`:
//
//      ctx.waitUntil(forwardToNexus(bodyText, request.headers, env));
//
//    Pořadí je závazné: NEXUS forward jde AŽ ZA okfish prací. Kdyby byl
//    první a zasekl se, zdržel by dispatch.
//
// 3. Nastavit dva secrets:
//      wrangler secret put NEXUS_WEBHOOK_URL     # https://.../api/webhooks/shoptet
//      wrangler secret put NEXUS_FORWARD_TOKEN   # tentýž řetězec jako v NEXUSu
//
//    Dokud nejsou nastavené, funkce tiše nic nedělá -- takže se dá nasadit
//    dřív, než NEXUS běží, a zapnout až potom.

/** Env rozšíření, které si okfish Worker musí doplnit do svého typu. */
export interface NexusForwardEnv {
    /** Plná URL NEXUS endpointu. Chybí-li, forward se přeskočí. */
    readonly NEXUS_WEBHOOK_URL?: string;
    /** Sdílené tajemství. Chybí-li, forward se přeskočí. */
    readonly NEXUS_FORWARD_TOKEN?: string;
}

/** Hlavičky, které se přeposílají beze změny. Nic jiného NEXUS nepotřebuje. */
const FORWARDED_HEADERS = ['Shoptet-Webhook-Signature'] as const;

/**
 * Timeout. Musí být kratší než doba, po kterou je rozumné držet isolate
 * po odeslání odpovědi. 3 s je kompromis: pokryje běžnou latenci i pomalý
 * cold start NEXUS Workeru, ale nedrží spojení donekonečna.
 */
const FORWARD_TIMEOUT_MS = 3000;

/**
 * Přepošle webhook do NEXUSu.
 *
 * @param rawBody  PŘESNĚ to tělo, které přišlo ze Shoptetu (`await request.text()`).
 *                 NE přeparsovaný objekt -- viz záruka 2 v hlavičce.
 * @param headers  Původní hlavičky requestu (kvůli podpisu).
 * @param env      Worker env se dvěma secrets výše.
 *
 * Nikdy nehodí. Vrací `true`, když NEXUS potvrdil přijetí, jinak `false`.
 * Návratovou hodnotu je bezpečné ignorovat -- je jen pro testy.
 */
export async function forwardToNexus(
    rawBody: string,
    headers: Headers,
    env: NexusForwardEnv,
): Promise<boolean> {
    const url = env.NEXUS_WEBHOOK_URL;
    const token = env.NEXUS_FORWARD_TOKEN;

    // Nenakonfigurováno = vypnuto. Vědomě TICHÉ: umožňuje to nasadit kód
    // dřív, než NEXUS existuje, a zapnout ho pouhým nastavením secrets.
    // Kdyby to logovalo chybu, zaplavilo by to log okfishe při každé
    // objednávce, dokud by se to nezapnulo.
    if (!url || !token) return false;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);

    try {
        const outgoing = new Headers({
            'Content-Type': 'application/json',
            // Token jde v hlavičce, ne v URL -- URL by skončila v access
            // logu Cloudflare i v případném redirectu.
            'X-Nexus-Forward-Token': token,
        });

        for (const name of FORWARDED_HEADERS) {
            const value = headers.get(name);
            if (value !== null) outgoing.set(name, value);
        }

        const response = await fetch(url, {
            method: 'POST',
            headers: outgoing,
            // rawBody, ne JSON.stringify(parsed) -- podpis je nad tímhle.
            body: rawBody,
            signal: controller.signal,
            // Redirect by mohl token poslat na cizí host.
            redirect: 'error',
        });

        if (!response.ok) {
            // Jen status, žádné tělo -- odpověď by mohla obsahovat detaily,
            // které do logu okfishe nepatří.
            console.warn(`[nexus-forward] NEXUS vrátil ${response.status}`);
            return false;
        }

        return true;
    } catch (error) {
        // Sem spadne timeout, DNS chyba, výpadek NEXUSu i zakázaný redirect.
        // Objednávka okfishe tím NENÍ dotčená -- to je celý smysl záruky 1.
        const reason =
            error instanceof Error
                ? error.name === 'AbortError'
                    ? `timeout po ${FORWARD_TIMEOUT_MS} ms`
                    : error.message
                : String(error);
        console.warn(`[nexus-forward] přeposlání selhalo: ${reason}`);
        return false;
    } finally {
        clearTimeout(timer);
    }
}
