// IntentReconciliation -- uzavření řetězu Execution vrstvy (P1).
//
// ŘETĚZ Z Reconciliation.ts:
//   SOURCE -> DECISION -> EXPECTED -> EXECUTION -> ACTUAL -> RECONCILIATION
//                          Intent      Executor              TENHLE SOUBOR
//
// K ČEMU TO JE:
//   `IntentExecutor` umí říct "nevím, jestli se zápis provedl" (UNKNOWN).
//   To je poctivé, ale samo o sobě k ničemu -- nejistota musí někdo
//   rozřešit, jinak zůstane v datech navždy. Tenhle modul je ten někdo.
//
//   Vstupem je fronta z `ExecutionIntentStore.findRequiringReconciliation()`:
//     - UNKNOWN                      -> nevíme, co se stalo
//     - EXECUTED s LOG_INFERRED      -> "úspěch" odvozený regexem z logu
//                                       (Omega .bat agent) -- není to fakt
//
// PROČ SE RECONCILIUJE I "ÚSPĚCH":
//   Protože u Omegy úspěch znamená "v logu byl řetězec, který vypadal jako
//   potvrzení". To není totéž co potvrzení. Kdyby se LOG_INFERRED bral jako
//   hotová věc, tichá selhání by se nikdy nenašla.
//
// CO TENHLE MODUL NEDĚLÁ:
//   - NEČTE vnější systémy sám -- dostane funkci, která skutečný stav načte.
//     Testovatelné bez sítě, nezávislé na konkrétním konektoru.
//   - NEOPRAVUJE rozdíly. Rozhodnutí "co s tím" patří doméně: u ceny je to
//     přepsat, u faktury vystavit dobropis, u kreditu kompenzovat. Modul
//     jen KLASIFIKUJE, co se stalo.
//   - NERETRYUJE. Reconciliace je zjišťování, ne oprava.

import type {
    ExecutionIntent,
    ExecutionIntentState,
} from './ExecutionIntent.js';
import { requiresReconciliation } from './ExecutionIntent.js';

/**
 * Jak dopadlo ověření jednoho Intentu proti skutečnému stavu.
 *
 * Záměrně JINÝ výčet než `ReconciliationOutcome` v
 * `core/canonical/reconciliation/Reconciliation.ts`: ten porovnává datové
 * položky (MATCHED/DIFF/FAILED). Tady se porovnává ZÁMĚR proti skutečnosti,
 * a nejdůležitější hodnoty -- `EXECUTED_UNCONFIRMED` a `LOST` -- v tom
 * výčtu nemají obdobu.
 */
export type IntentReconciliationVerdict =
    /**
     * Skutečný stav odpovídá `expectedState`. Zápis proběhl.
     * Intent se překlopí na EXECUTED (i když byl UNKNOWN).
     */
    | 'CONFIRMED'
    /**
     * Skutečný stav odpovídá tomu, co bylo PŘED zápisem -- zápis
     * prokazatelně neproběhl. Intent -> FAILED, retry je bezpečný.
     */
    | 'NOT_EXECUTED'
    /**
     * Skutečný stav neodpovídá ani očekávanému, ani původnímu. Něco se
     * stalo, ale ne to, co jsme chtěli.
     *
     * NEJNEBEZPEČNĚJŠÍ VÝSLEDEK: automatická oprava tady NESMÍ proběhnout.
     * Buď zasáhl někdo jiný (ruční editace v administraci, jiný systém),
     * nebo se zápis provedl částečně (INC-016). Obojí vyžaduje člověka.
     */
    | 'DIVERGED'
    /**
     * Cílový záznam ve vnějším systému neexistuje. U zápisu, který ho měl
     * vytvořit, znamená NOT_EXECUTED; u zápisu, který měl upravit existující,
     * znamená, že ho někdo smazal.
     */
    | 'TARGET_MISSING'
    /**
     * Skutečný stav se nepodařilo přečíst -- vnější systém je nedostupný.
     * Nejistota TRVÁ, Intent zůstává, kde byl. Není to selhání reconciliace,
     * jen se opakuje později.
     */
    | 'UNVERIFIABLE';

export interface IntentReconciliationResult<TActual = unknown> {
    readonly intentId: string;
    readonly verdict: IntentReconciliationVerdict;
    /** Do jakého stavu se má Intent překlopit. `undefined` = beze změny. */
    readonly nextState?: ExecutionIntentState;
    readonly actualState?: TActual;
    readonly detail: string;
    /**
     * `true` = vyžaduje lidské oko. Nastavuje se u DIVERGED a u zmizelého
     * cíle -- tedy tam, kde by automatika mohla napáchat škodu.
     */
    readonly needsManualReview: boolean;
}

/**
 * Porovnání očekávaného a skutečného stavu.
 *
 * Doména si ho dodá sama, protože jen ona ví, co je "shoda": u ceny
 * exaktní rovnost haléřů, u textu možná normalizace bílých znaků, u částky
 * s plovoucí desetinnou čárkou tolerance (viz `classifyDrift` v
 * `core/reconciliation/GenericReconciliation.ts`).
 *
 * Core to NESMÍ rozhodovat za ni -- jinak by tu skončil
 * `if (domain === 'pricing')`.
 */
export type StateComparator<TExpected, TActual> = (
    expected: TExpected,
    actual: TActual,
) => boolean;

/** Čtení skutečného stavu z vnějšího systému. */
export type ActualStateReader<TActual> = (
    intent: ExecutionIntent,
) => Promise<{ found: true; state: TActual } | { found: false }>;

/**
 * Ověří jeden Intent proti skutečnému stavu.
 *
 * `stateBeforeWrite` je volitelný: když ho doména zná, umí modul odlišit
 * `NOT_EXECUTED` (skutečnost == stav před zápisem, tedy se nic nestalo) od
 * `DIVERGED` (skutečnost je něco třetího). Bez něj se obojí slévá do
 * `DIVERGED` a jde na ruční kontrolu -- fail-closed, ale otravnější.
 */
export async function reconcileIntent<TExpected, TActual>(
    intent: ExecutionIntent<unknown, TExpected>,
    readActual: ActualStateReader<TActual>,
    matches: StateComparator<TExpected, TActual>,
    stateBeforeWrite?: TExpected,
): Promise<IntentReconciliationResult<TActual>> {
    let read: { found: true; state: TActual } | { found: false };
    try {
        read = await readActual(intent);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return {
            intentId: intent.id,
            verdict: 'UNVERIFIABLE',
            // Stav se NEMĚNÍ. Nedostupnost vnějšího systému není důkaz
            // o ničem -- Intent zůstane ve frontě a zkusí se později.
            detail: `Skutečný stav se nepodařilo přečíst: ${reason}`,
            needsManualReview: false,
        };
    }

    if (!read.found) {
        return {
            intentId: intent.id,
            verdict: 'TARGET_MISSING',
            detail:
                `Cíl ${intent.targetRef} ve vnějším systému (${intent.connectorType}) neexistuje. ` +
                `Buď zápis neproběhl, nebo záznam někdo smazal -- rozhodnout musí člověk.`,
            needsManualReview: true,
        };
    }

    const actual = read.state;

    if (matches(intent.expectedState, actual)) {
        return {
            intentId: intent.id,
            verdict: 'CONFIRMED',
            // I když byl Intent UNKNOWN, teď je jisté, že se zápis provedl.
            // Tohle je ten mechanismus, kvůli kterému UNKNOWN není terminální.
            nextState: 'EXECUTED',
            actualState: actual,
            detail: 'Skutečný stav odpovídá očekávanému -- zápis proběhl.',
            needsManualReview: false,
        };
    }

    if (stateBeforeWrite !== undefined && matches(stateBeforeWrite, actual)) {
        return {
            intentId: intent.id,
            verdict: 'NOT_EXECUTED',
            nextState: 'FAILED',
            actualState: actual,
            detail: 'Skutečný stav odpovídá stavu před zápisem -- zápis neproběhl, retry je bezpečný.',
            needsManualReview: false,
        };
    }

    return {
        intentId: intent.id,
        verdict: 'DIVERGED',
        // Stav se VĚDOMĚ nemění: nevíme, jestli to je náš částečný zápis,
        // nebo cizí zásah. Automatická oprava by mohla přepsat něco, co
        // tam někdo dal schválně.
        actualState: actual,
        detail:
            `Skutečný stav neodpovídá očekávanému ani stavu před zápisem. ` +
            `Buď zasáhl někdo jiný, nebo se zápis provedl částečně (INC-016). ` +
            `Automatická oprava se NEPROVÁDÍ.`,
        needsManualReview: true,
    };
}

/** Souhrn jednoho běhu reconciliační smyčky. */
export interface ReconciliationRunSummary {
    readonly processed: number;
    readonly confirmed: number;
    readonly notExecuted: number;
    readonly diverged: number;
    readonly targetMissing: number;
    readonly unverifiable: number;
    /** Kolik položek vyžaduje člověka. Nenulová hodnota = alert. */
    readonly needsManualReview: number;
    readonly results: readonly IntentReconciliationResult[];
}

/**
 * Projde frontu nejistot a ověří ji.
 *
 * ERROR ISOLATION (master rule, potvrzeno napříč auditem): chyba jedné
 * položky NESMÍ shodit celý běh. 10 000 Intentů, 2 neověřitelné -> běh
 * dokončí a nahlásí, nikdy "1 chyba -> STOP". `reconcileIntent` proto
 * výjimky polyká do `UNVERIFIABLE` a smyčka jede dál.
 *
 * Modul frontu jen ZPRACUJE -- načtení (`findRequiringReconciliation`)
 * i zápis výsledků (`recordOutcome`) dělá volající, který má store.
 */
export async function reconcileBatch<TExpected, TActual>(
    intents: readonly ExecutionIntent<unknown, TExpected>[],
    readActual: ActualStateReader<TActual>,
    matches: StateComparator<TExpected, TActual>,
    stateBeforeWrite?: (intent: ExecutionIntent<unknown, TExpected>) => TExpected | undefined,
): Promise<ReconciliationRunSummary> {
    const results: IntentReconciliationResult[] = [];

    for (const intent of intents) {
        // Pojistka proti chybnému vstupu: kdyby volající poslal Intent,
        // který reconciliaci nepotřebuje, ověřovat ho je zbytečné volání
        // na vnější systém.
        if (!requiresReconciliation(intent)) {
            continue;
        }

        const before = stateBeforeWrite?.(intent);
        results.push(
            (await reconcileIntent(
                intent,
                readActual,
                matches,
                before,
            )) as IntentReconciliationResult,
        );
    }

    const count = (v: IntentReconciliationVerdict): number =>
        results.filter((r) => r.verdict === v).length;

    return {
        processed: results.length,
        confirmed: count('CONFIRMED'),
        notExecuted: count('NOT_EXECUTED'),
        diverged: count('DIVERGED'),
        targetMissing: count('TARGET_MISSING'),
        unverifiable: count('UNVERIFIABLE'),
        needsManualReview: results.filter((r) => r.needsManualReview).length,
        results,
    };
}
