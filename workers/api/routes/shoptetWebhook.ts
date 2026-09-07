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

/** Hlavička s podpisem, jak ji posílá Shoptet (a okfish přeposílá beze změny). */
const SIGNATURE_HEADER = 'Shoptet-Webhook-Signature';
/** Sdílené tajemství okfish -> NEXUS. */
const FORWARD_TOKEN_HEADER = 'X-Nexus-Forward-Token';

/** Události, které voucher doména zpracovává. Ostatní se tiše potvrdí. */
const HANDLED_EVENTS: ReadonlySet<string> = new Set(['order:create', 'order:update']);

export interface ShoptetWebhookPayload {
    readonly event?: string;
    readonly eshopId?: number;
    readonly eventInstance?: string | number;
    readonly eventCreated?: string;
    readonly data?: Record<string, unknown>;
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
 * Zpracování objednávky. Dnes jen loguje -- napojení na issuance přijde,
 * až bude rozhodnuté přepojení na straně okfishe (§17.2).
 *
 * VĚDOMĚ NEDOKONČENO: dopsat sem volání issuance dřív, než je jasné, jak se
 * payload dostane až sem, by znamenalo psát proti nepotvrzenému tvaru dat.
 */
async function processOrderEvent(payload: ShoptetWebhookPayload, _env: Env): Promise<void> {
    log('info', 'webhook.order_event', {
        event: payload.event,
        eventInstance: payload.eventInstance,
        // TODO(Fáze B): napojit na issuance -- načíst objednávku přes
        // /api/orders/{code}, zjistit, jestli obsahuje voucher produkt
        // (N x 1 Kč), a vystavit poukaz. Blokuje rozhodnutí o přepojení.
        pending: 'issuance-not-wired',
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
