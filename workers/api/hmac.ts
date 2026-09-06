// HMAC token pro voucher redemption -- Worker vrstva, Fáze B
// (docs/design-proposals/Digital-Voucher.md §6.2, ROZHODNUTO Lucky 2026-09-06).
//
// PŘEVZATO Z PRODUKČNĚ OVĚŘENÉHO VZORU: ~/shoptet-cart-bypass-poc/src/lib/hmac.js
// (18/18 security regresí včetně parallel replay testu). Nepřepisuje se
// znovu od nuly -- mění se jen to, co je tady doloženě jiné nebo lepší:
//
//   1. Kanonický string je voucherový, ne shipping:
//      `voucherId:amountMinor:cartFingerprint:timestamp:nonce`
//      (PoC měl `productId:priceId:amount:currency:distanceKm:timestamp:nonce`).
//   2. `amountMinor` je INTEGER V HALÉŘÍCH, ne float. Stejný důvod jako
//      v migraci 0001: podpis nad `"800.1"` vs `"800.10000000000002"` je
//      jiný podpis. Float v kanonickém stringu = náhodně selhávající
//      verifikace na penězích. Kanonizace čísla je proto povinná (§ níže).
//   3. Formát podpisu se validuje regexem `/^[0-9a-f]{64}$/` PŘED dekódováním
//      (PoC kontroloval jen `length !== 64`, takže "ZZ..." o 64 znacích prošlo
//      do `parseInt`, který vrátil NaN a z něj `Uint8Array` s nulami).
//   4. Porovnání bufferů přes `crypto.subtle.timingSafeEqual`.
//
// ============================================================================
// ZLEPŠENÍ #4 -- timingSafeEqual a proč délku ověřujeme PŘEDEM
// ============================================================================
// `crypto.subtle.timingSafeEqual(a, b)` HODÍ VÝJIMKU, když se délky liší --
// nevrací false. Kdyby se výjimka jen odchytila a vrátilo `false`, vznikne
// přesně ten timing side-channel, kvůli kterému se funkce používá: útočník
// rozliší "špatná délka" (rychlý throw) od "správná délka, špatný obsah"
// (plné porovnání). Proto:
//
//   délka + abeceda se ověří regexem  ->  teprve pak dekódování  ->
//   -> teprve pak timingSafeEqual nad dvěma buffery ZARUČENĚ stejné délky.
//
// Regex `/^[0-9a-f]{64}$/` je konstantní-délková podmínka nad vstupem od
// útočníka; ta žádný tajný materiál neprozrazuje (délka očekávaného podpisu
// je veřejná -- HMAC-SHA256 má vždy 32 bajtů).
//
// PROČ VŮBEC MANUÁLNÍ POROVNÁNÍ, KDYŽ EXISTUJE `crypto.subtle.verify`:
// `verify()` je v workerd implementované konstantně vůči času a je to
// primární cesta (`verifyVoucherToken` ho používá). `timingSafeEqualHex`
// je exportovaný pro místa, kde se porovnávají DVA VYPOČÍTANÉ podpisy
// (např. porovnání tokenu proti znovu-podepsanému payloadu v testech nebo
// při rotaci klíče), kde `verify()` použít nejde.

const encoder = new TextEncoder();

/** HMAC-SHA256 = 32 bajtů = 64 hex znaků. Konstanta, ne magické číslo. */
const SIGNATURE_HEX_LENGTH = 64;

/** Lowercase hex, přesná délka. Ověřuje se PŘED dekódováním -- viz hlavička. */
const SIGNATURE_HEX_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Payload podepisovaný pro čerpání voucheru (§6.2: "HMAC nad
 * (voucher_id, applicable_amount, cart_fingerprint, expires_at)").
 *
 * ODCHYLKA OD §6.2 -- `timestamp` + `nonce` MÍSTO `expires_at`:
 * PoC používá `timestamp` (okamžik vydání) a TTL se vyhodnocuje na serveru
 * z `CONFIG.MAX_AGE_SEC`, ne z hodnoty v tokenu. To je bezpečnější varianta
 * téhož: kdyby si platnost nesl token sám, znamenala by změna TTL nutnost
 * revalidovat všechny vydané tokeny, a útočník by viděl serverovou politiku.
 * `nonce` v PoC není v §6.2 zmíněný, ale je NUTNÝ -- bez něj jsou dva
 * tokeny pro stejný košík a stejnou vteřinu bitově identické a replay
 * protection nemá co zamknout.
 */
export interface VoucherTokenPayload {
    /** `CreditVoucher.id`, tedy kód poukazu `NEXUS-XXXX-XXXX-RRRR` (§4). */
    readonly voucherId: string;
    /**
     * Čerpatelná částka v HALÉŘÍCH (celé číslo). Nikdy float -- viz bod 2
     * v hlavičce a ODCHYLKA v migrations/0001_credit_voucher.sql.
     */
    readonly amountMinor: number;
    /**
     * Otisk košíku, nad kterým byla částka spočítána (§6.2: "Přehrání
     * starého tokenu -> odchytí expires_at v tokenu + cart_fingerprint").
     * Změní-li zákazník košík, otisk nesedí a token je pro nový košík
     * neplatný.
     */
    readonly cartFingerprint: string;
    /** Unix seconds okamžiku vydání. TTL vyhodnocuje server, ne token. */
    readonly timestamp: number;
    /** Náhodný jednorázový identifikátor -- nosič replay protection. */
    readonly nonce: string;
}

/**
 * Kanonický string. Pořadí polí je SOUČÁST KONTRAKTU -- jakákoliv změna
 * pořadí, oddělovače nebo formátu čísla zneplatní všechny vydané tokeny.
 *
 * Oddělovač `:` je převzatý z PoC. Bezpečný je proto, že žádné z polí `:`
 * obsahovat nesmí -- to VYNUCUJE `assertCanonicalizable()` níže, aby
 * nešlo posunout hranici mezi poli (`voucherId="A:1", amount=0` vs.
 * `voucherId="A", amount=1:0`). PoC tuhle kontrolu neměl; jeho pole byla
 * číselná nebo z konfigurace, tady je `voucherId` i `cartFingerprint`
 * ovlivnitelný vstupem.
 */
export function buildVoucherCanonicalString(payload: VoucherTokenPayload): string {
    assertCanonicalizable(payload);
    return [
        payload.voucherId,
        canonicalAmountMinor(payload.amountMinor),
        payload.cartFingerprint,
        canonicalInteger(payload.timestamp, 'timestamp'),
        payload.nonce,
    ].join(':');
}

/** Chyba kanonizace -- vstup nelze jednoznačně podepsat. Fail-closed. */
export class CanonicalizationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CanonicalizationError';
    }
}

/**
 * Částka MUSÍ být bezpečný nezáporný integer. `Number.isSafeInteger`
 * odmítne `800.5`, `NaN`, `Infinity` i hodnoty nad 2^53 -- všechny by se
 * do stringu serializovaly způsobem, na kterém se podepisující a
 * ověřující strana můžou rozejít.
 */
function canonicalAmountMinor(amountMinor: number): string {
    if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
        throw new CanonicalizationError(
            `amountMinor musí být nezáporný safe integer v haléřích, dostal "${String(amountMinor)}"`,
        );
    }
    return String(amountMinor);
}

function canonicalInteger(value: number, field: string): string {
    if (!Number.isSafeInteger(value)) {
        throw new CanonicalizationError(`${field} musí být safe integer, dostal "${String(value)}"`);
    }
    return String(value);
}

/**
 * Textová pole nesmí obsahovat oddělovač ani být prázdná -- jinak není
 * rozklad kanonického stringu jednoznačný (viz komentář u
 * `buildVoucherCanonicalString`).
 */
function assertCanonicalizable(payload: VoucherTokenPayload): void {
    const textFields: ReadonlyArray<readonly [string, unknown]> = [
        ['voucherId', payload.voucherId],
        ['cartFingerprint', payload.cartFingerprint],
        ['nonce', payload.nonce],
    ];

    for (const [field, raw] of textFields) {
        if (typeof raw !== 'string' || raw.length === 0) {
            throw new CanonicalizationError(`${field} musí být neprázdný string`);
        }
        if (raw.includes(':')) {
            throw new CanonicalizationError(
                `${field} nesmí obsahovat oddělovač ":" (nejednoznačná kanonizace)`,
            );
        }
    }
}

/**
 * Import HMAC klíče. Tajemství se NIKDY neloguje ani nevrací.
 *
 * `extractable = false` (jako v PoC): klíč nejde z `CryptoKey` dostat zpět,
 * takže se nemůže omylem propsat do logu ani do odpovědi.
 */
async function importHmacKey(secret: string): Promise<CryptoKey> {
    if (typeof secret !== 'string' || secret.length === 0) {
        // Fail-closed. U platidla nikdy nepokračovat s prázdným klíčem --
        // podepsalo by se konstantním tajemstvím, které zná každý.
        throw new CanonicalizationError('HMAC_SECRET chybí nebo je prázdný');
    }
    return crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign', 'verify'],
    );
}

function toHex(buffer: ArrayBuffer): string {
    return Array.from(new Uint8Array(buffer))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * Dekóduje 64 hex znaků na 32 bajtů. Volá se AŽ po ověření regexem --
 * proto tady žádná tolerance k nevalidnímu vstupu není potřeba a
 * `parseInt` nemůže vrátit NaN (na rozdíl od PoC).
 */
function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i += 1) {
        bytes[i] = Number.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

/** Ověří, že podpis má tvar lowercase hex správné délky. Bez dekódování. */
export function isWellFormedSignature(signatureHex: unknown): signatureHex is string {
    return (
        typeof signatureHex === 'string' &&
        signatureHex.length === SIGNATURE_HEX_LENGTH &&
        SIGNATURE_HEX_PATTERN.test(signatureHex)
    );
}

/** Podepíše payload. Vrací lowercase hex (64 znaků). */
export async function signVoucherToken(
    payload: VoucherTokenPayload,
    secret: string,
): Promise<string> {
    const message = buildVoucherCanonicalString(payload);
    const key = await importHmacKey(secret);
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
    return toHex(signature);
}

/**
 * Ověří podpis. Vrací `false` u JAKÉHOKOLIV problému -- nevalidní formát,
 * nekanonizovatelný payload, chyba crypto vrstvy. Nikdy nevyhazuje, aby
 * volající nemohl omylem nechat výjimku propadnout jako "neověřeno, ale
 * pokračujeme".
 *
 * Používá `crypto.subtle.verify`, který je v workerd konstantní vůči času.
 */
export async function verifyVoucherToken(
    payload: VoucherTokenPayload,
    signatureHex: unknown,
    secret: string,
): Promise<boolean> {
    // 1. Formát PŘED dekódováním (zlepšení #3 oproti PoC).
    if (!isWellFormedSignature(signatureHex)) {
        return false;
    }

    try {
        // 2. Kanonizace může vyhodit -- nevalidní payload = neplatný podpis.
        const message = buildVoucherCanonicalString(payload);
        const key = await importHmacKey(secret);
        return await crypto.subtle.verify(
            'HMAC',
            key,
            hexToBytes(signatureHex) as unknown as BufferSource,
            encoder.encode(message),
        );
    } catch {
        return false;
    }
}

/**
 * Konstantně-časové porovnání dvou hex podpisů.
 *
 * ZLEPŠENÍ #4 oproti PoC (který buffery neporovnával vůbec a spoléhal jen
 * na `verify`). Délka se ověří regexem PŘEDEM, protože `timingSafeEqual`
 * při rozdílné délce HÁZÍ -- viz rozbor v hlavičce souboru. Po regexu mají
 * oba buffery zaručeně 32 bajtů, takže se do throw větve nedá dostat
 * vstupem od útočníka.
 */
export function timingSafeEqualHex(a: unknown, b: unknown): boolean {
    if (!isWellFormedSignature(a) || !isWellFormedSignature(b)) {
        return false;
    }

    const left = hexToBytes(a);
    const right = hexToBytes(b);

    // Runtime bez `timingSafeEqual` (starší compat date, testovací prostředí):
    // fallback je vlastní konstantně-časové XOR porovnání, NE `===` na
    // stringech. Tichý pád zpátky na krátké porovnání by zlepšení #4 zrušil.
    const subtle = crypto.subtle as SubtleCrypto & {
        timingSafeEqual?: (x: ArrayBufferView, y: ArrayBufferView) => boolean;
    };

    if (typeof subtle.timingSafeEqual === 'function') {
        return subtle.timingSafeEqual(left, right);
    }

    let diff = 0;
    for (let i = 0; i < left.length; i += 1) {
        // Non-null assert je bezpečný: obě pole mají 32 prvků (regex výše).
        diff |= left[i]! ^ right[i]!;
    }
    return diff === 0;
}

/** Náhodný 128bitový nonce jako hex. 1:1 z PoC (`generateNonce`). */
export function generateNonce(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * Otisk košíku pro `cartFingerprint`. Stabilní vůči pořadí položek --
 * jinak by přeskládání košíku vypadalo jako jiný košík a token by přestal
 * platit bez důvodu.
 *
 * NENÍ to bezpečnostní hash proti kolizím v tom smyslu, že by musel být
 * tajný -- útočník zná svůj vlastní košík. Slouží k SVÁZÁNÍ tokenu
 * s konkrétním obsahem košíku, aby nešel přehrát na jiný.
 */
export async function computeCartFingerprint(
    lines: ReadonlyArray<{ readonly sku: string; readonly quantity: number; readonly unitPriceMinor: number }>,
): Promise<string> {
    const canonical = lines
        .map((line) => `${line.sku} ${line.quantity} ${line.unitPriceMinor}`)
        .sort()
        .join('');

    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(canonical));
    return toHex(digest);
}

/**
 * Vyhodnocení stáří tokenu. VZOR Z PoC (`handleVerify` krok 4):
 *
 *     if (age < -60 || age > CONFIG.MAX_AGE_SEC) -> REJECT_EXPIRED
 *
 * Záporná tolerance `-60` je ochrana proti TOKENU Z BUDOUCNOSTI: bez ní by
 * token s `timestamp` posunutým dopředu měl `age` záporné, prošel by
 * podmínkou `age > MAX_AGE` a platil by libovolně dlouho. 60 s je rozptyl
 * hodin mezi edge lokalitami, ne benevolence.
 */
export function isTimestampFresh(
    timestamp: number,
    nowSeconds: number,
    maxAgeSeconds: number,
    clockSkewToleranceSeconds = 60,
): boolean {
    if (!Number.isSafeInteger(timestamp) || !Number.isSafeInteger(nowSeconds)) {
        return false;
    }
    const age = nowSeconds - timestamp;
    return age >= -clockSkewToleranceSeconds && age <= maxAgeSeconds;
}
