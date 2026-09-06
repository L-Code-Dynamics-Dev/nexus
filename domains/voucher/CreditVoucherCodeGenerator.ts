// CreditVoucherCodeGenerator -- doména `domains/voucher/`, Fáze A "Voucher Core"
// (docs/design-proposals/Digital-Voucher.md §4, ROZHODNUTO Lucky 2026-09-06).
//
// Generátor a validátor kódu poukazu ve formátu `NEXUS-XXXX-XXXX-RRRR`.
//
// ============================================================================
// PROČ TO NENÍ `Rule` (a nesmí být)
// ============================================================================
// `core/canonical/rules/Rule.ts` požaduje DETERMINISTICKOU čistou funkci:
// stejný vstup -> stejný výstup, žádné skryté side effects. Generátor kódu je
// z definice pravý opak -- jeho jedinou hodnotou je NEPŘEDVÍDATELNOST. Kdyby
// se z něj udělala Rule, buď by porušil kontrakt Rule (skrytý `crypto`
// uvnitř `evaluate()`), nebo by přestal být bezpečný (deterministický kód
// poukazu jde odvodit).
//
// ŘEŠENÍ: zdroj náhody je PARAMETR (`RandomBytesSource`), ne import. Tím je
// funkce testovatelná (test dodá deterministický zdroj a ověří mapování bajtů
// na abecedu), a zároveň v produkci nikdy nesahá po ničem jiném než po
// `crypto.getRandomValues`. Stejná úvaha jako u `issuedAt`/`now` ve
// `CreditVoucherStore` -- čas i entropie jsou VSTUP, nikdy systémové volání
// schované uvnitř domény.
//
// `Math.random` SE NEPOUŽIJE NIKDY. Je to seedovaný PRNG (xorshift128+
// ve V8), jehož vnitřní stav lze z několika výstupů zrekonstruovat a všechny
// další hodnoty dopočítat. Kód poukazu je PLATIDLO -- predikovatelný
// generátor by znamenal, že kdo zná pár vydaných kódů, vygeneruje si další.
//
// ============================================================================
// ABECEDA A ENTROPIE (§4)
// ============================================================================
// Kód se OPISUJE Z PAPÍRU (PDF poukaz, Fáze C), takže abeceda vynechává
// zaměnitelné znaky: `0`/`O` a `1`/`I`/`L`. Zbývá 8 číslic (2-9) + 22 písmen
// = 30 znaků. Čísla, která z toho plynou:
//
//   4 znaky  = 30^4 = 810 000                 -- §4: "na platidlo MÁLO"
//   8 znaků  = 30^8 = 656 100 000 000 (~6,6x10^11)  <- ROZHODNUTO
//
// §4 to zdůvodňuje výslovně: 4 znaky z Josova příkladu `NEXUS-A8F9-2026` jsou
// uhodnutelné hrubou silou, proto se kód rozšířil na 8 znaků ve dvou
// skupinách. Entropie ale NENÍ jediná obrana -- §4 k ní přidává rate limit na
// `/validate` a audit neúspěšných pokusů. Tenhle soubor pokrývá jen tu první.
//
// ============================================================================
// ROK V KÓDU
// ============================================================================
// `RRRR` je ROK EXPIRACE, ne rok vydání (§4: "RRRR je rok expirace"). Je to
// čitelnost pro zákazníka i pro podporu, NE bezpečnostní ani business prvek:
// autoritativní platnost drží `vouchers.expires_at` v D1 (§8) a vyhodnocuje
// se v SQL WHERE klauzuli čerpacího UPDATE. Rok v kódu se při čerpání
// NEKONTROLUJE -- kdyby se kontroloval, vznikla by druhá, rozejitelná pravda
// o expiraci.
//
// ============================================================================
// HRANICE
// ============================================================================
// §12: voucher je platební vrstva ZA hotovým součtem košíku. Tenhle soubor
// neimportuje NIC -- ani z `domains/pricing/`, ani odjinud. Je to čistá
// textová/entropická vrstva bez závislostí.

/**
 * Abeceda bez zaměnitelných znaků. §4 předepisuje 30 znaků a jmenovitě
 * vylučuje `0`/`O` a `1`/`I`/`L`. Tady je to dotažené na 30 přesně:
 *
 *   číslice 2-9        =  8 znaků  (0 a 1 vypuštěny)
 *   písmena A-Z        = 26 znaků
 *     minus O, I, L    = 23        (§4 jmenovitě)
 *     minus U          = 22        (viz níže)
 *   ------------------------------
 *   celkem               30 znaků  -> 30^8 = ~6,6x10^11 (přesně číslo z §4)
 *
 * `U` navíc: bez něj vychází 31 znaků, což by číslo z §4 posunulo. Vypouští
 * se právě `U`, protože rukou psané `U` a `V` jsou nejčastější zbývající
 * záměna při opisu z papíru -- stejný důvod jako u zbytku seznamu, ne
 * arbitrární škrt. (Crockford Base32 vypouští `U` z téhož důvodu.)
 *
 * Pořadí je součástí kontraktu jen pro testy s deterministickým zdrojem --
 * pro bezpečnost je nepodstatné, protože výběr je uniformní (viz
 * `pickIndexUniform`).
 *
 * Velikost 30 je zároveň důvod, proč je odmítnutí modulo biasu nutné: 256
 * není dělitelné 30, takže naivní `byte % 30` by prvních 16 znaků abecedy
 * favorizovalo. U platidla se to neignoruje.
 */
export const VOUCHER_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Prefix je fixní (§4) -- odlišuje NEXUS poukaz od Shoptet kupónu na první pohled. */
export const VOUCHER_CODE_PREFIX = 'NEXUS';

/** Délka jedné skupiny. Dvě skupiny po 4 = 8 znaků entropie (§4). */
export const VOUCHER_CODE_GROUP_LENGTH = 4;

/** Počet skupin. §4: `NEXUS-XXXX-XXXX-RRRR`. */
export const VOUCHER_CODE_GROUP_COUNT = 2;

/** Celkový počet náhodných znaků. 8 -> ~6,6x10^11 kombinací. */
export const VOUCHER_CODE_ENTROPY_CHARS = VOUCHER_CODE_GROUP_LENGTH * VOUCHER_CODE_GROUP_COUNT;

/**
 * Validační regex formátu -- `NEXUS-XXXX-XXXX-RRRR`.
 *
 * Sestavuje se z abecedy, ne psaný ručně: ručně psaná znaková třída by se
 * při jakékoli úpravě abecedy tiše rozešla s generátorem a validace by
 * odmítala kódy, které sama vydala.
 *
 * Rok je `\d{4}` bez horní meze -- validuje se TVAR, ne platnost. Platnost
 * je v D1 (`expires_at`, §8), tady by byla druhá pravda.
 */
export const VOUCHER_CODE_PATTERN = new RegExp(
    `^${VOUCHER_CODE_PREFIX}-` +
        Array.from({ length: VOUCHER_CODE_GROUP_COUNT })
            .map(() => `[${VOUCHER_CODE_ALPHABET}]{${VOUCHER_CODE_GROUP_LENGTH}}`)
            .join('-') +
        '-\\d{4}$',
);

/**
 * Zdroj kryptografické náhody. PARAMETR, ne import -- viz hlavička.
 *
 * Kontrakt implementace: naplní CELÉ předané pole nepředvídatelnými bajty.
 * Přesně sémantika `crypto.getRandomValues`. Testovací dvojník smí být
 * deterministický, produkční NIKDY.
 */
export type RandomBytesSource = (out: Uint8Array) => void;

/**
 * Produkční zdroj náhody -- Web Crypto, dostupný ve workerd i v Node >= 19
 * jako globální `crypto`.
 *
 * Fail-closed: chybí-li `crypto.getRandomValues`, funkce HODÍ. Fallback na
 * `Math.random` by byl tichý downgrade platidla na predikovatelný generátor,
 * což je horší než neschopnost poukaz vystavit.
 */
export const webCryptoRandomBytes: RandomBytesSource = (out: Uint8Array): void => {
    const source = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } })
        .crypto;
    if (source === undefined || typeof source.getRandomValues !== 'function') {
        throw new VoucherCodeGenerationError(
            'crypto.getRandomValues není v tomto runtime dostupné -- kód poukazu nelze bezpečně vygenerovat',
        );
    }
    source.getRandomValues(out);
};

/** Generování kódu selhalo. Fail-closed: nikdy se nevrací "skoro náhodný" kód. */
export class VoucherCodeGenerationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'VoucherCodeGenerationError';
    }
}

export interface GenerateVoucherCodeInput {
    /**
     * Rok expirace pro `RRRR` část (§4). VSTUP, ne `new Date().getFullYear()`
     * uvnitř -- volající ho odvozuje z `expiresAt`, které si počítá z tenant
     * konfigurace (§8/§11). Dvě nezávislá čtení hodin by se mohla rozejít
     * o půlnoci silvestra.
     */
    readonly expiryYear: number;
    /** Zdroj entropie. Default je Web Crypto; testy dodají svůj. */
    readonly randomBytes?: RandomBytesSource;
}

/**
 * Vygeneruje kód poukazu `NEXUS-XXXX-XXXX-RRRR` (§4).
 *
 * SAMOSTATNÁ FUNKCE, ne metoda Rule -- viz hlavička souboru. Nemá stav,
 * nesahá na hodiny ani na D1 a jedinou nedeterministickou věc bere jako
 * parametr.
 *
 * NEOVĚŘUJE UNIKÁTNOST. Kolizi (PRIMARY KEY violation) řeší až zapisující
 * vrstva retry smyčkou -- tady by kontrola vyžadovala I/O a udělala by
 * z čisté funkce nečistou. Při 6,6x10^11 kombinacích je kolize prakticky
 * nemožná, ale "prakticky nemožná" není u platidla totéž co "ošetřená".
 */
export function generateVoucherCode(input: GenerateVoucherCodeInput): string {
    const year = assertExpiryYear(input.expiryYear);
    const randomBytes = input.randomBytes ?? webCryptoRandomBytes;

    const chars = new Array<string>(VOUCHER_CODE_ENTROPY_CHARS);
    for (let i = 0; i < VOUCHER_CODE_ENTROPY_CHARS; i += 1) {
        chars[i] = VOUCHER_CODE_ALPHABET[pickIndexUniform(VOUCHER_CODE_ALPHABET.length, randomBytes)]!;
    }

    const groups: string[] = [];
    for (let g = 0; g < VOUCHER_CODE_GROUP_COUNT; g += 1) {
        groups.push(
            chars.slice(g * VOUCHER_CODE_GROUP_LENGTH, (g + 1) * VOUCHER_CODE_GROUP_LENGTH).join(''),
        );
    }

    const code = `${VOUCHER_CODE_PREFIX}-${groups.join('-')}-${String(year).padStart(4, '0')}`;

    // Pojistka proti tichému rozejití generátoru a validátoru. Kdyby se
    // někdy změnila abeceda nebo skupiny jen na jednom místě, spadne to
    // TADY při emisi -- ne až u zákazníka, kterému `/validate` odmítne
    // kód, jaký mu NEXUS sám vytiskl na papír.
    if (!isValidVoucherCodeFormat(code)) {
        throw new VoucherCodeGenerationError(
            'Vygenerovaný kód neprošel vlastní validací formátu -- generátor a validátor se rozešly',
        );
    }

    return code;
}

/**
 * Uniformní výběr indexu z `size` možností pomocí REJECTION SAMPLING.
 *
 * PROČ NE `byte % size`: 256 není násobkem 30, takže by prvních 16 znaků
 * abecedy padalo s pravděpodobností 9/256 a zbylých 14 jen 8/256. To je
 * modulo bias -- ubírá reálnou entropii a dělá kódy o něco uhodnutelnější,
 * než tvrdí výpočet v §4. Zahodit "přebývající" bajty stojí v průměru méně
 * než 7 % volání navíc a bias odstraní úplně.
 *
 * Bajty se tahají po jednom záměrně: dávkování by bylo rychlejší, ale kód
 * generujeme jednou za objednávku, ne v horké smyčce. Čitelnost vyhrává.
 */
function pickIndexUniform(size: number, randomBytes: RandomBytesSource): number {
    // Největší násobek `size`, který se vejde do 256. Bajty >= limit se zahazují.
    const limit = Math.floor(256 / size) * size;
    const buffer = new Uint8Array(1);

    // Konečný počet pokusů: nekonečná smyčka by při rozbitém zdroji náhody
    // (např. konstantně vracejícím 255) zablokovala Worker místo selhání.
    for (let attempt = 0; attempt < MAX_SAMPLING_ATTEMPTS; attempt += 1) {
        randomBytes(buffer);
        const byte = buffer[0];
        if (byte === undefined) {
            throw new VoucherCodeGenerationError('Zdroj náhody nenaplnil buffer');
        }
        if (byte < limit) {
            return byte % size;
        }
    }

    throw new VoucherCodeGenerationError(
        `Zdroj náhody nevrátil použitelný bajt po ${MAX_SAMPLING_ATTEMPTS} pokusech -- pravděpodobně není náhodný`,
    );
}

/**
 * Strop rejection samplingu. Pravděpodobnost, že korektní zdroj náhody
 * neuspěje 64x za sebou, je (16/256)^64 ~ 10^-77 -- tedy nikdy. Strop je
 * obrana proti ROZBITÉMU zdroji, ne proti smůle.
 */
const MAX_SAMPLING_ATTEMPTS = 64;

/**
 * Rok expirace musí být čtyřciferný. Užší kontrola (např. "nesmí být
 * v minulosti") sem NEPATŘÍ -- generátor neví nic o tenant konfiguraci
 * délky platnosti (§11) a druhá pravda o expiraci vedle `expires_at` je
 * přesně to, čemu se vyhýbáme (viz hlavička).
 */
function assertExpiryYear(year: unknown): number {
    if (!Number.isSafeInteger(year) || (year as number) < 1000 || (year as number) > 9999) {
        throw new VoucherCodeGenerationError(
            `expiryYear musí být čtyřciferný rok, dostal "${String(year)}"`,
        );
    }
    return year as number;
}

/**
 * Validace FORMÁTU kódu -- pro `/validate` endpoint (§6.1) i pro issuance.
 *
 * PROČ SE VALIDUJE FORMÁT PŘED DOTAZEM DO D1:
 *   1. Šetří D1 dotazy při hrubé síle -- nevalidní tvar se do databáze
 *      nedostane vůbec (D1 je single-threaded, každý ušetřený dotaz se počítá).
 *   2. Odpověď na nevalidní formát musí být NEROZLIŠITELNÁ od "neexistuje",
 *      jinak z ní jde odvodit, které kódy jsou "skoro správné". Volající to
 *      musí zajistit -- tahle funkce jen říká `true`/`false`.
 *
 * Vstup je `unknown` schválně: přichází z query stringu / JSON těla, tedy
 * zvenčí. Type guard je bezpečnější než `string` v signatuře a přetypování
 * u volajícího.
 */
export function isValidVoucherCodeFormat(code: unknown): code is string {
    return typeof code === 'string' && VOUCHER_CODE_PATTERN.test(code);
}

/**
 * Normalizace kódu OPSANÉHO Z PAPÍRU, než se pustí do validace.
 *
 * Zákazník kód přepisuje ručně (§9: PDF s kódem), takže sem realisticky
 * dorazí malá písmena, mezery místo pomlček nebo obojí. Odmítat to jako
 * "neplatný kód" je zbytečná frustrace u něčeho, co drží v ruce.
 *
 * CO SE ZÁMĚRNĚ NEDĚLÁ: žádné "opravy" zaměnitelných znaků (`0`->`O`,
 * `1`->`I`). Vypadá to vstřícně, ale abeceda ty znaky NEOBSAHUJE právě proto,
 * aby k záměně nedošlo -- a tichá substituce by z jednoho opsaného kódu
 * udělala JINÝ platný kód, tedy cizí poukaz. U platidla se nehádá.
 */
export function normalizeVoucherCode(raw: unknown): string {
    if (typeof raw !== 'string') {
        return '';
    }
    return raw.trim().toUpperCase().replace(/[\s_]+/g, '-');
}
