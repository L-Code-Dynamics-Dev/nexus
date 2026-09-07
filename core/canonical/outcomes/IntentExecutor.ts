// IntentExecutor -- most mezi ExecutionIntent a Connector vrstvou (P1,
// rozhodnutí Lucky 2026-09-07 bod 23).
//
// PROBLÉM, KTERÝ ŘEŠÍ:
//   `connectors/Connector.ts` má `WritableConnector.write()`, které vrací
//   `{ externalReference?: string; error?: string }`. Ten tvar NEUMÍ
//   VYJÁDŘIT NEJISTOTU: buď je tam reference (úspěch), nebo error (chyba).
//   Třetí možnost -- "nevíme, jestli se zápis provedl" -- se do něj vejde
//   jedině jako error, což je ve svém důsledku lež.
//
//   U Omegy je přitom nejistota BĚŽNÝ STAV, ne výjimka: `.bat` agent nemá
//   strojovou odpověď, úspěch se odvozuje regexem z logu, a při timeoutu
//   nebo zamčeném souboru se prostě neví (viz ERP-Generic-Layer.md).
//   Když se to zamaskuje jako `error`, volající to vyhodnotí jako "nezapsalo
//   se" a zavolá retry. A protože Omega -- na rozdíl od Pohody -- NEDEDUPUJE,
//   vznikne DUPLICITNÍ FAKTURA.
//
//   Tenhle modul proto překládá výsledek konektoru na `ExecutionAttemptResult`,
//   kde je `UNKNOWN` plnohodnotný stav odlišený na úrovni typu.
//
// CO TENHLE MODUL NEDĚLÁ:
//   - NEVOLÁ konektory sám. Dostane funkci, která zápis provede -- takže je
//     testovatelný bez sítě a bez znalosti konkrétního konektoru.
//   - NEPERZISTUJE Intenty. To je věc storage vrstvy (viz OPEN QUESTION 1
//     v ExecutionIntent.ts). Modul jen vrací, JAK se má stav změnit.
//   - NERETRYUJE. Rozhodnutí o retry patří volajícímu, který zná kontext
//     (kolikátý pokus, jak je operace drahá, jestli je systém idempotentní).
//     Modul jen ŘEKNE, jestli je retry bezpečný -- viz `isRetrySafe`.

import type {
    ExecutionIntent,
    ExecutionIntentState,
    ExecutionAttemptResult,
    ExecutionConfirmationQuality,
} from './ExecutionIntent.js';
import { canTransitionIntent } from './ExecutionIntent.js';

/**
 * Surová odpověď zápisové cesty, ve tvaru, jaký dnes vrací
 * `WritableConnector.write()`.
 */
export interface RawWriteResult {
    readonly externalReference?: string;
    readonly error?: string;
}

/**
 * Jak se má surová odpověď interpretovat. Konektor MUSÍ dodat, protože
 * jen on ví, co jeho `error` znamená -- a to se mezi systémy zásadně liší.
 *
 * Bez téhle deklarace by interpretace skončila u hádání z textu chyby, což
 * je přesně ten druh křehkosti, kvůli které vznikl `LOG_INFERRED`.
 */
export interface ConnectorSemantics {
    /**
     * Jak kvalitní je potvrzení úspěchu.
     *
     * `SYSTEM_CONFIRMED` -- Pohoda mServer vrátí `responsePack`, D1 vrátí
     *   `meta.changes`. Fakt, ne odhad.
     * `LOG_INFERRED` -- Omega `.bat` agent: úspěch se čte regexem z logu.
     *   Reconciliace je POVINNÁ i při "úspěchu".
     */
    readonly confirmationQuality: 'SYSTEM_CONFIRMED' | 'LOG_INFERRED';

    /**
     * Rozhodne, jestli chyba znamená prokazatelné neprovedení (`FAILED`),
     * nebo nejistotu (`UNKNOWN`).
     *
     * Vodítko: validační chyba, 4xx, odmítnutý vstup = FAILED (nic se
     * nezapsalo). Timeout, přerušené spojení, zabitý proces, prázdná
     * odpověď = UNKNOWN (nevíme).
     *
     * KDYŽ SI KONEKTOR NENÍ JISTÝ, MÁ VRÁTIT `false`. Fail-closed směrem
     * k nejistotě je bezpečnější: UNKNOWN vede na reconciliaci, kdežto
     * chybné FAILED vede na retry a možný dvojí zápis.
     */
    isDefiniteFailure(error: string): boolean;

    /**
     * Umí cílový systém idempotenci? Pohoda ano (server-side dedup),
     * Omega NE. Ovlivňuje to, jestli je retry po `FAILED` bezpečný sám
     * o sobě, nebo jen díky tomu, že se prokazatelně nic nezapsalo.
     */
    readonly supportsIdempotency: boolean;
}

/**
 * Přeloží surovou odpověď konektoru na typovaný výsledek pokusu.
 *
 * `actualState` je stav, který konektor po zápisu přečetl -- proti němu
 * reconciliace porovná `intent.expectedState`. Když ho konektor nedodá
 * (a většina zápisových cest ho nedodá), zůstává `undefined` a
 * reconciliace si stav musí načíst sama.
 */
export function interpretWriteResult<TActual = unknown>(
    raw: RawWriteResult,
    semantics: ConnectorSemantics,
    actualState?: TActual,
): ExecutionAttemptResult<TActual> {
    // Chyba má přednost před referencí: konektor, který vrátí obojí,
    // hlásí částečný úspěch -- a ten se NESMÍ číst jako úspěch.
    // Přesně tenhle případ je INC-016: Shoptet vrátí 200 OK, ale
    // jednotlivé položky uvnitř neuspějí.
    if (raw.error !== undefined && raw.error !== '') {
        if (semantics.isDefiniteFailure(raw.error)) {
            return {
                outcome: 'FAILED',
                // Prokazatelné neprovedení -> retry je bezpečný bez ohledu
                // na to, jestli systém umí idempotenci.
                retryable: true,
                reason: raw.error,
            };
        }

        return {
            outcome: 'UNKNOWN',
            reason: raw.error,
            ...(raw.externalReference !== undefined
                ? { executionReference: raw.externalReference }
                : {}),
        };
    }

    // Žádná chyba, ale ani reference: konektor mlčí. To NENÍ úspěch --
    // je to nejistota. `LOG_INFERRED` konektory (Omega) tenhle stav
    // produkují, když log neobsahuje ani úspěch, ani chybu.
    if (raw.externalReference === undefined && semantics.confirmationQuality === 'LOG_INFERRED') {
        return {
            outcome: 'UNKNOWN',
            reason: 'Konektor nevrátil referenci ani chybu -- výsledek zápisu není známý.',
        };
    }

    return {
        outcome: 'EXECUTED',
        confirmationQuality: semantics.confirmationQuality,
        actualState: actualState as TActual,
        ...(raw.externalReference !== undefined
            ? { executionReference: raw.externalReference }
            : {}),
    };
}

/**
 * Do jakého stavu má Intent přejít podle výsledku pokusu.
 *
 * Čistá funkce -- nemutuje, jen mapuje. Perzistenci a samotný přechod
 * (včetně ověření `canTransitionIntent`) dělá volající.
 */
export function nextIntentState(result: ExecutionAttemptResult): ExecutionIntentState {
    switch (result.outcome) {
        case 'EXECUTED':
            return 'EXECUTED';
        case 'FAILED':
            return 'FAILED';
        case 'UNKNOWN':
            return 'UNKNOWN';
    }
}

/**
 * Je retry bezpečný?
 *
 * TOHLE JE NEJDŮLEŽITĚJŠÍ FUNKCE MODULU. Špatná odpověď znamená
 * duplicitní fakturu nebo dvojí odečet kreditu.
 *
 * Pravidla:
 *   - `FAILED` s `retryable: true` -> ANO. Prokazatelně se nic nezapsalo.
 *   - `FAILED` s `retryable: false` -> NE. Trvalá chyba (neplatný vstup),
 *     retry ji nezmění.
 *   - `UNKNOWN` -> ANO **JEN** když cílový systém umí idempotenci.
 *     U Omegy (nededuplikuje) je slepý retry z UNKNOWN přímá cesta
 *     k duplicitnímu dokladu. Jedinou správnou reakcí je reconciliace.
 *   - `EXECUTED` -> NE, hotovo.
 */
export function isRetrySafe(
    result: ExecutionAttemptResult,
    semantics: ConnectorSemantics,
): boolean {
    switch (result.outcome) {
        case 'EXECUTED':
            return false;
        case 'FAILED':
            return result.retryable;
        case 'UNKNOWN':
            return semantics.supportsIdempotency;
    }
}

/** Výsledek jednoho pokusu o provedení Intentu. */
export interface IntentExecutionOutcome<TActual = unknown> {
    readonly result: ExecutionAttemptResult<TActual>;
    readonly nextState: ExecutionIntentState;
    /** `true` = volající SMÍ zkusit znovu. Neznamená, že má. */
    readonly retrySafe: boolean;
    readonly confirmationQuality?: ExecutionConfirmationQuality;
}

/**
 * Provede jeden pokus o vykonání Intentu.
 *
 * `performWrite` je funkce, která zápis skutečně udělá -- typicky
 * `connector.write(payload)`. Modul ji jen zavolá a interpretuje výsledek,
 * takže se dá testovat bez sítě.
 *
 * POŘADÍ, KTERÉ VOLAJÍCÍ MUSÍ DODRŽET:
 *   1. Přepnout Intent na `EXECUTING` a PERZISTOVAT.
 *   2. Teprve pak zavolat tuhle funkci.
 * Bez kroku 1 se po pádu procesu neví, jestli se zápis stihl provést --
 * a jsme zpátky u nejistoty, kterou tenhle modul má odstranit.
 *
 * Výjimka z `performWrite` se NEPOLYKÁ do `FAILED`. Vyhozená výjimka je
 * neznámý stav -- síť mohla spadnout po odeslání požadavku, ale před
 * přijetím odpovědi. Proto `UNKNOWN`.
 */
export async function executeIntent<TPayload, TExpected, TActual = unknown>(
    intent: ExecutionIntent<TPayload, TExpected>,
    semantics: ConnectorSemantics,
    performWrite: (payload: TPayload) => Promise<RawWriteResult>,
    readActualState?: () => Promise<TActual>,
): Promise<IntentExecutionOutcome<TActual>> {
    if (!canTransitionIntent(intent.state, 'EXECUTING')) {
        throw new Error(
            `ExecutionIntent ${intent.id}: přechod ${intent.state} -> EXECUTING není dovolený. ` +
                `Intent v terminálním nebo neočekávaném stavu se nesmí provádět znovu.`,
        );
    }

    let raw: RawWriteResult;
    try {
        raw = await performWrite(intent.payload);
    } catch (error) {
        // Výjimka != prokazatelné selhání. Request mohl odejít a odpověď
        // se ztratit -- to je UNKNOWN, ne FAILED.
        const reason = error instanceof Error ? error.message : String(error);
        const unknownResult: ExecutionAttemptResult<TActual> = {
            outcome: 'UNKNOWN',
            reason: `Zápis vyhodil výjimku, stav vnějšího systému není známý: ${reason}`,
        };
        return {
            result: unknownResult,
            nextState: 'UNKNOWN',
            retrySafe: isRetrySafe(unknownResult, semantics),
        };
    }

    // Skutečný stav se čte JEN při úspěchu. Po UNKNOWN by ho reconciliace
    // stejně musela ověřit znovu a čtení tady by jen zamlžilo, kdy přesně
    // se stav pozoroval.
    let actualState: TActual | undefined;
    if (readActualState !== undefined && raw.error === undefined) {
        try {
            actualState = await readActualState();
        } catch {
            // Nepodařilo se přečíst stav -- zápis tím ale zpochybněný není.
            // Reconciliace si ho načte později.
            actualState = undefined;
        }
    }

    const result = interpretWriteResult<TActual>(raw, semantics, actualState);

    return {
        result,
        nextState: nextIntentState(result),
        retrySafe: isRetrySafe(result, semantics),
        ...(result.outcome === 'EXECUTED'
            ? { confirmationQuality: result.confirmationQuality }
            : {}),
    };
}
