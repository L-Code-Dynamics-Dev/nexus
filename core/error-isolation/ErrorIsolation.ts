// Error Isolation framework -- core/error-isolation/, Fáze 0
// (docs/MIGRATION_PLAN.md řádek 21). Sjednocuje batch-processing per-item
// izolaci, kterou dnes řeší dvě nezávislá místa jinak:
//
//   core/validation/errorIsolation.ts -- VÁZÁNO na Validation Framework
//     5-stage model (StageError/StageStatus z core/validation/types.ts),
//     jen jedna agregační funkce (aggregateStageStatus). Nepokrývá obecný
//     "zpracuj N položek, izoluj chyby, pokračuj" vzor -- je to úzce
//     specifické pro to, jak Validation Framework hlásí stage-level status.
//
//   Pricing Engine PricelistWriter.processDiff()
//     (~/okfish-pricing-engine/cloudflare-worker/src/shoptet-api/
//     pricelist-writer.ts:29-208) -- NEJZRALEJŠÍ implementace v celém
//     portfoliu, produkčně ověřená přes několik incidentů (INC-010,
//     2026-08-14/15 VAGNER/77764 nálezy). Klíčové věci, co tenhle soubor
//     přebírá jako obecný princip:
//       - batch se dělí na CHUNKS, jeden chunk selhat nesmí zastavit
//         zpracování dalších chunků (:199-203, catch kolem celého chunku,
//         loop pokračuje)
//       - úspěch položky se NESMÍ odvodit jen z absence chyby na úrovni
//         chunku (`processed > 0` bug zmíněný v komentáři :39-46) --
//         každá položka musí být PROKAZATELNĚ úspěšná (post-write
//         verifikace, ne jen "HTTP nevrátilo chybu")
//       - položky, co selžou VERIFIKACI (ne jen zápis), jsou jiná
//         kategorie než položky, co selžou SAMOTNÝM zápisem -- Shoptet
//         umí vrátit HTTP 200 a přesto nic nezapsat (:137-153,
//         "tiše no-op" bug) -- proto `verificationFailures` je oddělené
//         pole od `errors`
//
// core/validation/errorIsolation.ts NENÍ nahrazeno ani editováno -- zůstává
// jako je, protože je svázané s StageResult<T> kontraktem, který tenhle
// obecnější framework nezná a nemusí znát. Vztah je: OBECNÝ
// (core/error-isolation) -> KONKRÉTNÍ POUŽITÍ (core/validation pro
// 5-stage), ne dědičnost ani reexport. Až se Validation Framework nebo
// jiná doména (SafeOrder, Availability) bude chtít napojit na tenhle
// framework, udělá to explicitně, ne automaticky.

/**
 * Výsledek zpracování JEDNÉ položky v batchi. `TItem` je vstupní typ
 * položky (např. PricelistDiff), `TSuccess` je to, co znamená "prokazatelně
 * úspěšné" (např. verifikovaná nová cena) -- nestačí "operace neselhala",
 * volající musí explicitně rozhodnout, co "úspěch" znamená pro danou
 * doménu (post-write verifikace, ne jen absence výjimky).
 */
export type ItemOutcome<TItem, TSuccess> =
    | { readonly kind: 'SUCCESS'; readonly item: TItem; readonly result: TSuccess }
    | { readonly kind: 'FAILURE'; readonly item: TItem; readonly reason: string; readonly errorClass: ErrorClass }
    /**
     * Oddělená kategorie od FAILURE -- položka byla ODESLÁNA bez chyby
     * (write samotný neselhal), ale následná verifikace zjistila, že
     * výsledek neodpovídá očekávání (PricelistWriter "tiše no-op" bug,
     * :137-153). Volající MUSÍ tohle rozlišovat od FAILURE, protože
     * příčina i náprava jsou jiné (write bug vs. verifikace/race condition
     * na cílovém systému).
     */
    | { readonly kind: 'VERIFICATION_FAILURE'; readonly item: TItem; readonly expected: string; readonly actual: string | null };

export type ErrorClass = 'RETRYABLE' | 'NON_RETRYABLE' | 'MANUAL_REQUIRED';

/**
 * Souhrn zpracování celého batche -- rozděluje položky do tří přihrádek
 * (successes/failures/verificationFailures), NIKDY nesloučí "prošlo bez
 * chyby" s "prokazatelně úspěšné". `totalCount` musí vždy odpovídat součtu
 * všech tří polí (invariant ověřený v runBatchWithIsolation).
 */
export interface BatchIsolationResult<TItem, TSuccess> {
    readonly totalCount: number;
    readonly successes: ReadonlyArray<{ item: TItem; result: TSuccess }>;
    readonly failures: ReadonlyArray<{ item: TItem; reason: string; errorClass: ErrorClass }>;
    readonly verificationFailures: ReadonlyArray<{ item: TItem; expected: string; actual: string | null }>;
}

/**
 * Zpracuje batch položek s per-item izolací -- selhání JEDNÉ položky (nebo
 * jednoho chunku, pokud `chunkSize` je zadané) nezastaví zpracování zbytku.
 * `processItem` je volající zodpovědnost: musí vracet `ItemOutcome`, ne
 * throwovat -- pokud přesto throwne (neočekávaná chyba mimo doménovou
 * logiku), je to zachyceno a položka skončí jako FAILURE s errorClass
 * `NON_RETRYABLE`, ať jedna neošetřená výjimka nezboří celý batch (stejný
 * princip jako PricelistWriter :199-203 catch kolem chunku).
 *
 * Čistá async funkce bez vlastního I/O -- `processItem` může dělat I/O,
 * framework sám nezná síť/DB/storage.
 */
export async function runBatchWithIsolation<TItem, TSuccess>(
    items: readonly TItem[],
    processItem: (item: TItem) => Promise<ItemOutcome<TItem, TSuccess>>,
    options?: { chunkSize?: number }
): Promise<BatchIsolationResult<TItem, TSuccess>> {
    const successes: Array<{ item: TItem; result: TSuccess }> = [];
    const failures: Array<{ item: TItem; reason: string; errorClass: ErrorClass }> = [];
    const verificationFailures: Array<{ item: TItem; expected: string; actual: string | null }> = [];

    const chunkSize = options?.chunkSize ?? (items.length || 1);
    for (let offset = 0; offset < items.length; offset += chunkSize) {
        const chunk = items.slice(offset, offset + chunkSize);

        for (const item of chunk) {
            let outcome: ItemOutcome<TItem, TSuccess>;
            try {
                outcome = await processItem(item);
            } catch (err) {
                // Neočekávaná výjimka mimo doménovou logiku -- izolovaná na
                // jednu položku, ne propagovaná ven (viz komentář výše).
                outcome = {
                    kind: 'FAILURE',
                    item,
                    reason: err instanceof Error ? err.message : String(err),
                    errorClass: 'NON_RETRYABLE',
                };
            }

            switch (outcome.kind) {
                case 'SUCCESS':
                    successes.push({ item: outcome.item, result: outcome.result });
                    break;
                case 'FAILURE':
                    failures.push({ item: outcome.item, reason: outcome.reason, errorClass: outcome.errorClass });
                    break;
                case 'VERIFICATION_FAILURE':
                    verificationFailures.push({ item: outcome.item, expected: outcome.expected, actual: outcome.actual });
                    break;
            }
        }
    }

    return {
        totalCount: items.length,
        successes,
        failures,
        verificationFailures,
    };
}
