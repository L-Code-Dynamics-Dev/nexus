// Shoptet webhook -- PŘIJÍMACÍ STRANA (Fáze B, 7.9.2026).
//
// ============================================================================
// PROČ NE PŘÍMÁ REGISTRACE
// ============================================================================
// Shoptet dovolí JEN JEDNU URL NA EVENT. Na okfish.sk už `order:create` míří
// na `shoptet-vip-worker.hlancaric.workers.dev` -- registrace NEXUSu by ho
// PŘEPSALA a okfish by přestal dostávat objednávky. Tichý výpadek produkce:
// nic by nespadlo, jen by se přestaly synchronizovat ceny (§17.2 návrhu).
//
// Lucky: *"udělej co potřebuješ a tak ať to funguje tady i tam"* -> ŘETĚZENÍ.
// Okfish si webhook nechává, po svém zpracování payload PŘEPOŠLE sem.
//
//   Shoptet ──order:create──> okfish Worker ──ctx.waitUntil(forward)──> NEXUS
//                                  │                                     │
//                             (dispatch sync)                    (voucher issuance)
//
// ============================================================================
// DVĚ VRSTVY OVĚŘENÍ -- a proč nestačí jedna
// ============================================================================
// 1) HMAC-SHA1 nad původním tělem, klíčem `SHOPTET_WEBHOOK_SIGNING_KEY`.
//    Stejný podpis, jaký ověřuje okfish (`verifyShoptetSignature`,
//    index.ts:89). Dokazuje, že payload OPRAVDU pochází ze Shoptetu --
//    přeposlání ten důkaz neruší, protože podpis je nad tělem, ne nad spojením.
// 2) Sdílené tajemství mezi okfishem a NEXUSem (`X-Nexus-Forward-Token`).
//    Dokazuje, že to přeposlal NÁŠ Worker, ne kdokoli, kdo zachytil payload.
//
// Obě musí projít. Samotný HMAC by dovolil replay komukoli, kdo jednou uvidí
// platné tělo; samotný forward token by nedokázal původ dat.
//
// ============================================================================
// ČASOVÝ LIMIT
// ============================================================================
// Shoptet dává 4 s (§16). Okfish z nich už něco spotřeboval, než přeposlal --
// tenhle endpoint proto musí být RYCHLÝ: ověřit, zapsat, vrátit 200.
// Nic, co má vlastní síťový round-trip (PDF, e-mail, Shoptet API), sem nepatří.
//
// Odpovídá se 200 i na payload, který nás nezajímá. Nenulový status by
// u okfishe vypadal jako chyba přeposlání a mohl by spustit retry.

import { ApiError, jsonResponse, log } from '../http.js';
import type { Env } from '../types.js';
import {
    ShoptetApiClient,
    ShoptetApiError,
    sumOrderDiscountsMinor,
    type ShoptetOrder,
} from '../../../connectors/shoptet/ShoptetApiClient.js';

/** Hlavička s podpisem, jak ji posílá Shoptet (a okfish přeposílá beze změny). */
const SIGNATURE_HEADER = 'Shoptet-Webhook-Signature';
/** Sdílené tajemství okfish -> NEXUS. */
const FORWARD_TOKEN_HEADER = 'X-Nexus-Forward-Token';

/** Události, které voucher doména zpracovává. Ostatní se tiše potvrdí. */
const HANDLED_EVENTS: ReadonlySet<string> = new Set(['order:create', 'order:update']);

/**
 * Tvar payloadu -- POTVRZENO z oficiální dokumentace 7.9.2026
 * (developers.shoptet.com/api/documentation/webhooks/).
 *
 * Payload je ZÁMĚRNĚ MINIMÁLNÍ. Neobsahuje NIC o zákazníkovi ani o zboží:
 *
 *   { "eshopId": 767740,
 *     "event": "order:create",
 *     "eventCreated": "2026-09-07T15:13:39+0200",
 *     "eventInstance": "2026001620" }
 *
 * `eventInstance` je ČÍSLO OBJEDNÁVKY. Detaily se dotahují zvlášť přes
 * `GET /api/orders/{eventInstance}`.
 *
 * DVA DŮSLEDKY:
 * 1. Payload je z hlediska GDPR neškodný -- dá se logovat celý, nejsou
 *    v něm osobní údaje. Osobní data přijdou až s dotažením objednávky.
 * 2. Zpracování NUTNĚ potřebuje síťové volání na Shoptet API. Proto běží
 *    v `ctx.waitUntil()` po odeslání odpovědi, ne uvnitř 4s limitu.
 *
 * Pozn.: u `product:*` událostí posílá okfish `sendPayload: "full"`, tam
 * je tvar bohatší -- ale ty voucher doména nezpracovává.
 */
export interface ShoptetWebhookPayload {
    readonly event?: string;
    readonly eshopId?: number;
    /** Číslo objednávky, např. "2026001620". NE interní ID. */
    readonly eventInstance?: string | number;
    readonly eventCreated?: string;
}

export async function handleShoptetWebhook(
    request: Request,
    env: Env,
    ctx: { waitUntil(promise: Promise<unknown>): void },
): Promise<Response> {
    // Tělo se čte JAKO TEXT a podpis se ověřuje nad ním. Kdyby se nejdřív
    // parsoval JSON a podpis počítal ze `JSON.stringify()`, rozešly by se
    // bílé znaky a pořadí klíčů -- podpis by nikdy neseděl.
    const bodyText = await request.text();

    const forwardToken = env.NEXUS_FORWARD_TOKEN;
    if (forwardToken === undefined || forwardToken === '') {
        // Fail-closed: bez sdíleného tajemství endpoint nefunguje. Pustit
        // payload dál "protože token není nakonfigurovaný" by z něj udělalo
        // veřejné vrátka do voucher domény.
        log('error', 'webhook.forward_token_missing', { alert: true });
        throw new ApiError('MISSING_BINDING', 503, 'Webhook není nakonfigurován.');
    }

    if (!timingSafeCompare(request.headers.get(FORWARD_TOKEN_HEADER) ?? '', forwardToken)) {
        log('warn', 'webhook.forward_token_invalid', { alert: true });
        throw new ApiError('REJECT_SIGNATURE', 403, 'Neplatný forward token.');
    }

    const signingKey = env.SHOPTET_WEBHOOK_SIGNING_KEY;
    if (signingKey === undefined || signingKey === '') {
        log('error', 'webhook.signing_key_missing', { alert: true });
        throw new ApiError('MISSING_BINDING', 503, 'Webhook není nakonfigurován.');
    }

    const signature = request.headers.get(SIGNATURE_HEADER) ?? '';
    if (!(await verifyShoptetSignature(bodyText, signature, signingKey))) {
        log('warn', 'webhook.signature_invalid', { alert: true });
        throw new ApiError('REJECT_SIGNATURE', 403, 'Neplatný podpis.');
    }

    let payload: ShoptetWebhookPayload;
    try {
        payload = JSON.parse(bodyText) as ShoptetWebhookPayload;
    } catch {
        // Podepsané, ale nečitelné tělo. 200, protože retry by nepomohl --
        // Shoptet by poslal tentýž nečitelný payload znovu.
        log('error', 'webhook.malformed_body', { alert: true });
        return jsonResponse({ received: true, processed: false, reason: 'MALFORMED_BODY' }, 200);
    }

    const event = payload.event ?? 'unknown';

    if (!HANDLED_EVENTS.has(event)) {
        // Voucher se týká jen objednávek. `product:*` a `customer:*` chodí
        // taky (okfish je má registrované) a je správně je jen potvrdit.
        log('info', 'webhook.ignored_event', { event });
        return jsonResponse({ received: true, processed: false, reason: 'EVENT_NOT_HANDLED' }, 200);
    }

    log('info', 'webhook.accepted', {
        event,
        eshopId: payload.eshopId,
        eventInstance: payload.eventInstance,
    });

    // Zpracování AŽ PO odpovědi. Issuance sahá do D1 a to je sice rychlé,
    // ale okfish už část ze 4 s spotřeboval -- nechat si rezervu je levnější
    // než riskovat retry.
    ctx.waitUntil(
        processOrderEvent(payload, env).catch((error: unknown) => {
            log('error', 'webhook.processing_failed', {
                alert: true,
                event,
                eventInstance: payload.eventInstance,
                message: error instanceof Error ? error.message : String(error),
            });
        }),
    );

    return jsonResponse({ received: true, processed: true }, 200);
}

/**
 * Zpracování objednávky.
 *
 * Běží AŽ PO odeslání odpovědi (`ctx.waitUntil`), protože payload nese jen
 * číslo objednávky -- detaily se musí dotáhnout přes Shoptet API, a to je
 * síťové volání, které se do 4s limitu spolehlivě nevejde.
 *
 * TOK:
 *   1. z payloadu vzít `eventInstance` = číslo objednávky
 *   2. `GET /api/orders/{číslo}` -- načíst položky a e-mail
 *   3. zjistit, jestli objednávka obsahuje voucher produkt (N x 1 Kč)
 *   4. pokud ano, vystavit poukaz (idempotentně na sourceOrderId)
 *
 * DNES JE HOTOVÝ KROK 1. Kroky 2-4 čekají na `SHOPTET_API_TOKEN` v Env
 * a na potvrzení, který produktový kód je voucher (§1 návrhu -- produkt
 * za 1 Kč, ale jeho konkrétní kód v okfish katalogu zatím nemáme).
 *
 * Chybějící kroky VĚDOMĚ nedopisuju naslepo: uhádnout kód voucher produktu
 * by znamenalo, že se poukaz buď nikdy nevystaví, nebo se vystaví za
 * něco jiného.
 */
async function processOrderEvent(payload: ShoptetWebhookPayload, env: Env): Promise<void> {
    const orderNumber = payload.eventInstance;

    if (orderNumber === undefined || orderNumber === '') {
        log('error', 'webhook.order_event.missing_instance', {
            alert: true,
            event: payload.event,
        });
        return;
    }

    const orderCode = String(orderNumber);

    // Bez tokenu se objednávka nedotáhne. NENÍ to chyba requestu -- webhook
    // už odpověděl 200; je to chybějící konfigurace, kterou musí vidět
    // obsluha. Alert, ne tichý návrat.
    const apiToken = env.SHOPTET_API_TOKEN;
    if (apiToken === undefined || apiToken === '') {
        log('error', 'webhook.audit.token_missing', {
            alert: true,
            orderCode,
            hint: 'wrangler secret put SHOPTET_API_TOKEN',
        });
        return;
    }

    // §18.7 krok 3: dotáhnout objednávku. READ-ONLY -- klient je
    // konstruován s výchozím ReadOnlyGuard, takže do Shoptetu nic nezapíše.
    const client = new ShoptetApiClient(apiToken);

    let order: ShoptetOrder;
    try {
        order = await client.getOrder(orderCode);
    } catch (error) {
        const definite = error instanceof ShoptetApiError ? error.definiteFailure : false;
        // `definiteFailure: false` (timeout, 5xx, 429) znamená NEVÍME --
        // audit se musí zopakovat. Až bude tenhle tok pod ExecutionIntent,
        // skončí to ve stavu UNKNOWN a vyzvedne si to reconciliační smyčka.
        log(definite ? 'warn' : 'error', 'webhook.audit.order_fetch_failed', {
            alert: !definite,
            orderCode,
            definiteFailure: definite,
            retryNeeded: !definite,
            message: error instanceof Error ? error.message : String(error),
        });
        return;
    }

    // §18.7 krok 3: spočítat skutečně uplatněnou slevu.
    const discounts = sumOrderDiscountsMinor(order);

    // Nominál poukazu ještě neumíme spárovat -- k tomu je potřeba vědět,
    // KTERÝ poukaz se v objednávce uplatnil. Kód kupónu je v `order`, ale
    // jeho tvar není ověřený proti reálné odpovědi.
    //
    // VĚDOMĚ NEDOKONČENO: spárování a zápis burned_unclaimed_minor
    // (migrace 0004) přijdou, až bude k dispozici reálná odpověď
    // /api/orders. Do té doby se loguje, co se spočítat DALO -- a to je
    // zároveň materiál, podle kterého se ten tvar potvrdí.
    log('info', 'webhook.audit.discounts_read', {
        orderCode,
        eshopId: payload.eshopId,
        discountsRecognised: discounts.recognised,
        discountsMinor: discounts.recognised ? discounts.totalMinor : null,
        pending: 'voucher-match-not-wired',
    });
}

/**
 * HMAC-SHA1 ověření. Port z okfish `verifyShoptetSignature`
 * (index.ts:89) -- musí počítat BIT ZA BITEM stejně, jinak by NEXUS
 * odmítal payloady, které okfish přijal.
 *
 * SHA-1 je slabá funkce, ale volbu neurčujeme my -- Shoptet podepisuje
 * takhle. Zesílit to jde jen tím sdíleným forward tokenem, ne změnou algoritmu.
 */
async function verifyShoptetSignature(
    body: string,
    signatureHex: string,
    key: string,
): Promise<boolean> {
    if (signatureHex === '') return false;
    // Délka a formát PŘED dekódováním -- jinak by `parseInt` na nesmyslu
    // vyrobil pole nul a porovnávalo by se proti němu.
    if (!/^[0-9a-f]{40}$/i.test(signatureHex)) return false;

    try {
        const enc = new TextEncoder();
        const cryptoKey = await crypto.subtle.importKey(
            'raw',
            enc.encode(key),
            { name: 'HMAC', hash: 'SHA-1' },
            false,
            ['sign'],
        );
        const expected = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(body));
        const expectedHex = [...new Uint8Array(expected)]
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');

        return timingSafeCompare(expectedHex.toLowerCase(), signatureHex.toLowerCase());
    } catch {
        return false;
    }
}

/**
 * Porovnání v konstantním čase. `===` nad stringy skončí na prvním
 * rozdílném znaku a doba běhu tím prozradí, kolik znaků sedělo --
 * u podpisu i u sdíleného tajemství je to použitelné k uhádnutí po znacích.
 */
function timingSafeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i += 1) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}
