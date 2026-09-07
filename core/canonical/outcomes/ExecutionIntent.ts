// ExecutionIntent -- P1 vrstva mezi doménovým rozhodnutím a konektorem
// (rozhodnutí Lucky 2026-09-07, bod 23 architektonického návrhu).
//
// PROČ VZNIKÁ:
//   `core/canonical/reconciliation/Reconciliation.ts` má v hlavičce řetěz
//     SOURCE -> DECISION -> EXPECTED -> EXECUTION -> ACTUAL -> RECONCILIATION
//   Z toho v repu doteď existovaly jen KONCE: `Decision` (rules/Decision.ts)
//   a `ReconciliationItemResult` s poli `expected`/`actual`. Prostředek --
//   ono `EXPECTED`, tedy "co konkrétně se má stát ve vnějším systému" --
//   typ neměl. Domény si ho proto vyráběly ad hoc a pokaždé jinak:
//
//     voucher   -> HOLD při nesouladu částky se řeší uvnitř route handleru
//     omega     -> LOG_INFERRED vs SYSTEM_CONFIRMED řeší konektor sám
//     pricing   -> PATCH do Shoptetu se skládá až v GitHub Actions skriptu
//
//   Jsou to tři instance TÉHOŽ vzoru (rozhodnutí -> zamýšlený zápis ->
//   skutečný stav -> porovnání), které dnes žijí jako tři oddělené
//   mini-systémy. Sjednotit je nejde bez společného typu pro ten prostředek.
//
// CO TO NENÍ:
//   - NENÍ to Decision. Decision říká "cena má být 199 Kč, protože tier ZR20".
//     Intent říká "PATCH /api/products/123/pricelist s tělem {...}".
//     Jedno rozhodnutí může vyprodukovat žádný, jeden nebo víc Intentů.
//   - NENÍ to Connector volání. Intent je DATA, ne akce -- dá se uložit,
//     přehrát, porovnat, schválit člověkem, zahodit. Právě proto, že je to
//     jen popis, může existovat dry-run: vygeneruj Intenty a NEPROVÁDĚJ je
//     (master rule "dry-run first" tím dostává typový základ, ne konvenci).
//   - NENÍ to transakce ani append-only historie. Ta je až `actual` výsledek
//     provedení.
//
// KLÍČOVÁ VLASTNOST -- `expectedState`:
//   Intent nese, jaký stav MÁ nastat po provedení. Bez toho je reconciliace
//   odsouzená porovnávat "co jsme poslali" proti "co tam je", což u částečně
//   úspěšných zápisů (INC-016: Shoptet vrátí 200 OK, ale per-item neuspěje)
//   nestačí. S `expectedState` se porovnává ZÁMĚR proti SKUTEČNOSTI.

import type { CanonicalEntity, EntityId } from '../entities/base.js';

/**
 * Životní cyklus Intentu. Fail-closed: nedeklarovaný přechod je zakázaný
 * (stejný princip jako `core/state-machine/StateMachine.ts`).
 *
 * PLANNED:   Intent vznikl z Decision, ještě se neprováděl. V dry-run
 *            režimu končí život tady -- to je celý smysl dry-runu.
 * APPROVED:  schválen k provedení. Mezistav existuje kvůli operacím, kde
 *            zápis vyžaduje lidské oko (hromadná změna cen, storno kreditu).
 *            Automatické toky jdou z PLANNED rovnou na EXECUTING.
 * EXECUTING: konektor pracuje. Stav MUSÍ být perzistovaný PŘED voláním
 *            vnějšího systému -- jinak po pádu procesu nevíme, jestli se
 *            zápis stihl provést (voucher §6.2 okno mezi UPDATE a INSERT
 *            je přesně tenhle problém v malém).
 * EXECUTED:  vnější systém potvrdil provedení.
 * FAILED:    provedení selhalo prokazatelně (chyba, kterou vnější systém
 *            vrátil). Retry je možný -- vzniká NOVÝ Intent, tenhle zůstane
 *            jako historie.
 * UNKNOWN:   NEJDŮLEŽITĚJŠÍ STAV CELÉHO MODELU. Nevíme, jestli se zápis
 *            provedl -- timeout, spadlé spojení, nejednoznačná odpověď.
 *            Legacy Omega agent tenhle stav produkuje běžně (úspěch se
 *            odvozuje regexem z logu). Slepý retry z UNKNOWN je cesta
 *            k duplicitní faktuře; jedinou správnou reakcí je reconciliace
 *            proti skutečnému stavu, ne opakování.
 * SUPERSEDED: Intent byl nahrazen novějším dřív, než se provedl (cena se
 *            mezitím změnila znovu). Ne chyba, ne úspěch.
 * ABANDONED: vědomě zahozen (dry-run, zamítnuté schválení).
 */
export type ExecutionIntentState =
    | 'PLANNED'
    | 'APPROVED'
    | 'EXECUTING'
    | 'EXECUTED'
    | 'FAILED'
    | 'UNKNOWN'
    | 'SUPERSEDED'
    | 'ABANDONED';

/**
 * Dovolené přechody. Terminální jsou EXECUTED / SUPERSEDED / ABANDONED.
 *
 * FAILED a UNKNOWN terminální VĚDOMĚ NEJSOU:
 *   - FAILED -> EXECUTING: retry téhož Intentu (ne nového) je legitimní
 *     u chyb, kde je jisté, že se nic nezapsalo (validační chyba, 4xx).
 *   - UNKNOWN -> EXECUTED / FAILED: reconciliace zjistí, jak to dopadlo,
 *     a stav se DOROVNÁ podle skutečnosti. To je ten mechanismus, kvůli
 *     kterému UNKNOWN vůbec existuje -- kdyby byl terminální, nejistota
 *     by se nikdy nerozřešila a zůstala by v datech navždy.
 */
export const EXECUTION_INTENT_TRANSITIONS: Record<
    ExecutionIntentState,
    readonly ExecutionIntentState[]
> = {
    PLANNED: ['APPROVED', 'EXECUTING', 'SUPERSEDED', 'ABANDONED'],
    APPROVED: ['EXECUTING', 'SUPERSEDED', 'ABANDONED'],
    EXECUTING: ['EXECUTED', 'FAILED', 'UNKNOWN'],
    FAILED: ['EXECUTING', 'ABANDONED'],
    UNKNOWN: ['EXECUTED', 'FAILED', 'ABANDONED'],
    EXECUTED: [],
    SUPERSEDED: [],
    ABANDONED: [],
};

export const EXECUTION_INTENT_TERMINAL_STATES: readonly ExecutionIntentState[] = [
    'EXECUTED',
    'SUPERSEDED',
    'ABANDONED',
];

/**
 * Jak jistě víme, že se provedení povedlo.
 *
 * Zavedeno kvůli reálné nesouměřitelnosti konektorů (viz
 * docs/design-proposals/ERP-Generic-Layer.md): Pohoda mServer vrátí
 * `responsePack` jako FAKT, kdežto Omega nemá strojovou odpověď vůbec --
 * úspěch se odvozuje regexem z logu `.bat` agenta.
 *
 * Kdyby obojí hlásilo prostě `EXECUTED`, tvářili bychom se, že víme něco,
 * co nevíme. Reconciliace se pak podle téhle hodnoty rozhoduje, jestli
 * musí stav ověřit proti vnějšímu systému, nebo může věřit potvrzení.
 */
export type ExecutionConfirmationQuality =
    /** Vnější systém potvrdil strojově čitelnou odpovědí. */
    | 'SYSTEM_CONFIRMED'
    /** Úspěch odvozen z logu / textového výstupu. Reconciliace POVINNÁ. */
    | 'LOG_INFERRED'
    /** Nepotvrzeno -- timeout, přerušené spojení. Vede na UNKNOWN. */
    | 'UNCONFIRMED';

/**
 * ExecutionIntent -- zamýšlený zápis do vnějšího systému.
 *
 * `TPayload` je tvar zápisu specifický pro konektor (Shoptet PATCH tělo,
 * Pohoda XML, D1 parametry). Core ho NEINTERPRETUJE -- jinak by v core
 * skončil `if (connectorType === 'shoptet')`, což CANONICAL-MODEL-CONTRACT
 * §15 zakazuje.
 *
 * `TExpected` je tvar stavu, který má po provedení nastat. Reconciliace ho
 * porovnává s `actual` načteným z vnějšího systému.
 */
export interface ExecutionIntent<TPayload = unknown, TExpected = unknown>
    extends CanonicalEntity {
    /**
     * Rozhodnutí, ze kterého Intent vzešel (`Decision.id`). Povinné --
     * zápis do cizího systému bez dohledatelného důvodu je přesně to, co
     * má tahle vrstva znemožnit. Odpovídá na "proč se tohle stalo?".
     */
    readonly decisionId: EntityId;

    /**
     * Doména, která Intent vytvořila (`pricing`, `voucher`, `omega`...).
     * String, ne enum -- doména se přidává bez zásahu do core.
     */
    readonly domain: string;

    /**
     * Cílový konektor (`shoptet`, `pohoda`, `omega`, `d1`...). Stejný
     * prostor hodnot jako `ExternalIdentity.connectorType` v base.ts.
     */
    readonly connectorType: string;

    /**
     * Co se má provést (`UPDATE_PRICE`, `REDEEM_CREDIT`, `ISSUE_DOCUMENT`).
     * Slovník si drží doména, ne core.
     */
    readonly operation: string;

    /**
     * Entita, které se zápis týká -- umožňuje najít všechny Intenty na
     * jeden produkt / objednávku / poukaz.
     */
    readonly targetRef: string;

    /** Tvar zápisu pro konektor. Core ho nečte. */
    readonly payload: TPayload;

    /**
     * Stav, který MÁ po provedení nastat. Tohle je to `EXPECTED` z řetězu
     * v Reconciliation.ts -- bez něj reconciliace porovnává jen "co jsme
     * poslali" proti "co tam je", což u částečných úspěchů nestačí
     * (INC-016: Shoptet vrátí 200 OK, ale jednotlivé položky neuspějí).
     */
    readonly expectedState: TExpected;

    readonly state: ExecutionIntentState;

    /**
     * Idempotency klíč pro vnější systém. Odvozený od `(domain, operation,
     * targetRef, decisionId)`, ne náhodný -- retry musí vyrobit TENTÝŽ klíč,
     * jinak idempotence nefunguje.
     *
     * POZOR: ne každý cílový systém idempotenci umí. Pohoda dedupuje
     * server-side, Omega VŮBEC (ERP-Generic-Layer.md) -- tam je klíč jen
     * pro naši evidenci a ochranu musí zajistit něco jiného.
     */
    readonly idempotencyKey: string;

    /**
     * Kolikátý pokus. Retry NEVYRÁBÍ nový Intent (ztratila by se historie),
     * jen inkrementuje tohle a vrací stav na EXECUTING.
     */
    readonly attempt: number;

    /** Vyplněno až po provedení. */
    readonly confirmationQuality?: ExecutionConfirmationQuality;

    /**
     * Odkaz na to, co vnější systém vrátil (id logu, dokumentu, response).
     * NE kopie odpovědi -- ta patří do auditu, sem jen reference.
     */
    readonly executionReference?: string;

    /** Čitelný důvod u FAILED / UNKNOWN. */
    readonly failureReason?: string;
}

/**
 * Výsledek pokusu o provedení, jak ho vrací konektor.
 *
 * Diskriminovaný union schválně: `UNKNOWN` se od `FAILED` MUSÍ dát odlišit
 * na úrovni typu, ne až čtením `failureReason`. Volající, který obojí
 * splácne do "nepovedlo se", napíše slepý retry -- a to je u Omegy cesta
 * k duplicitní faktuře.
 */
export type ExecutionAttemptResult<TActual = unknown> =
    | {
          readonly outcome: 'EXECUTED';
          readonly confirmationQuality: 'SYSTEM_CONFIRMED' | 'LOG_INFERRED';
          readonly actualState: TActual;
          readonly executionReference?: string;
      }
    | {
          readonly outcome: 'FAILED';
          /** Prokazatelně se nic nezapsalo -- retry je bezpečný. */
          readonly retryable: boolean;
          readonly reason: string;
      }
    | {
          readonly outcome: 'UNKNOWN';
          /**
           * Nevíme, jestli se zápis provedl. NIKDY neretryovat naslepo --
           * jedinou správnou reakcí je reconciliace proti skutečnému stavu.
           */
          readonly reason: string;
          readonly executionReference?: string;
      };

/**
 * Ověří, jestli je přechod dovolený. Fail-closed -- co není v
 * `EXECUTION_INTENT_TRANSITIONS`, je zakázané.
 */
export function canTransitionIntent(
    from: ExecutionIntentState,
    to: ExecutionIntentState,
): boolean {
    return EXECUTION_INTENT_TRANSITIONS[from].includes(to);
}

/** Je stav terminální (žádný další přechod)? */
export function isTerminalIntentState(state: ExecutionIntentState): boolean {
    return EXECUTION_INTENT_TERMINAL_STATES.includes(state);
}

/**
 * Vyžaduje tenhle Intent reconciliaci proti vnějšímu systému?
 *
 * `true` pro UNKNOWN (nevíme, co se stalo) i pro EXECUTED s
 * `LOG_INFERRED` (potvrzení je odvozené z textu, ne fakt). Právě proto
 * `confirmationQuality` existuje -- bez ní by se druhý případ tvářil jako
 * hotová věc.
 */
export function requiresReconciliation(
    intent: Pick<ExecutionIntent, 'state' | 'confirmationQuality'>,
): boolean {
    if (intent.state === 'UNKNOWN') return true;
    if (intent.state === 'EXECUTED' && intent.confirmationQuality === 'LOG_INFERRED') return true;
    return false;
}

/**
 * ROZHODNUTO (Lucky 2026-09-07, P1 Execution vrstva). Zbývající OPEN
 * QUESTIONS -- vědomě neuzavřené, patří k prvnímu skutečnému použití:
 *
 * 1. KDE SE INTENTY PERZISTUJÍ. D1 tabulka `execution_intents`? Per doménu?
 *    Zatím jen typ; první doména, která Intenty použije, si vynutí schéma.
 *    Bez perzistence nefunguje `EXECUTING` před voláním vnějšího systému
 *    (viz komentář u stavu), takže tohle je první, co bude potřeba.
 * 2. KDO ROZHODUJE O `APPROVED`. Mezistav je zaveden, ale schvalovací
 *    mechanismus (kdo, kde, jak) není. Do prvního použití u hromadných
 *    cenových změn to nechávám otevřené.
 * 3. DÁVKY. `ReconciliationBatchResult` v Reconciliation.ts počítá s batchi
 *    a error isolation ("10 000 položek, 2 FAILED -> COMPLETE_WITH_ERRORS").
 *    Intent je zatím JEDNOTLIVÝ. Vazba Intent -> batch chybí; nejspíš
 *    `batchId?: EntityId`, ale nechci to zavádět dřív, než bude jasné,
 *    jestli batch je entita, nebo jen korelační id.
 * 4. SUPERSEDED se dnes nemá kdo nastavit -- vyžaduje detekci, že na tentýž
 *    `targetRef` vznikl novější Intent. Patří do perzistenční vrstvy (1).
 */
