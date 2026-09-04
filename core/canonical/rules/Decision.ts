// Decision -- NENÍ Rule (viz CANONICAL-MODEL-CONTRACT.md, Jan's sign-off
// oprava #2). Rule říká "podle vstupů vychází toto rozhodnutí" (čistá
// funkce). Decision je AUDITOVATELNÝ, perzistovaný VÝSLEDEK té evaluace.
//
// Musí odpovědět zpětně na otázky typu:
//   "Proč systém nastavil tomuto produktu tuto cenu?"
//   "Proč SafeOrder objednávku označil jako rizikovou?"

import type { CanonicalEntity } from '../entities/base.js';

export interface Decision<TResult = unknown> extends CanonicalEntity {
    readonly ruleId: string;
    readonly ruleVersion: string;
    /** Reference na vstup, ne nutně celá kopie -- ale musí být dohledatelný. */
    readonly inputReference: string;
    readonly result: TResult;
    readonly reason: string;
    /**
     * Deterministický otisk (hash inputu + ruleVersion) -- umožňuje ověřit
     * ex-post, že stejný vstup + stejná verze pravidla dávají stejný
     * výsledek (Rule determinism requirement, viz Rule.ts).
     */
    readonly fingerprint: string;
}
