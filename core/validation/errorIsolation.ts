// Error Isolation -- HARD REQUIREMENT (§7 zadání). Chyba jedné položky
// nesmí automaticky zastavit celý batch. Aplikuje se napříč všemi 5 stages.

import type { StageError, StageStatus } from './types.js';

/**
 * Agreguje per-record chyby na stage-level status. NIKDY nevrací FAILED
 * jen kvůli přítomnosti chyb -- FAILED je vyhrazeno pro systémovou chybu
 * (celá stage neproběhla, ne že X z N recordů selhalo).
 */
export function aggregateStageStatus(processedCount: number, errors: StageError[]): StageStatus {
    if (processedCount === 0) return 'SKIPPED';
    if (errors.length === 0) return 'SUCCESS';
    if (errors.length < processedCount) return 'PARTIAL_SUCCESS';
    return 'FAILED'; // všechny records selhaly
}
