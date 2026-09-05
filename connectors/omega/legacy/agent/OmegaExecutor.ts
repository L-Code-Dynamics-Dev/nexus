// OmegaExecutor -- reálná implementace nahrazující simulaci z
// ~/omega-bridge/src/agent/omega/OmegaExecutor.ts (viz MIGRATION_PLAN.md:
// "OmegaExecutor.ts je simulace -- reálné child_process.spawn na Windows
// agentovi je nová práce, ne migrace"). NEW BUILD, ne 1:1 port.
//
// NEOVĚŘENO PROTI REÁLNÉMU WINDOWS AGENTOVI (2026-09-05) -- žádný reálný
// stroj s AkciaOmega.bat nebyl při psaní k dispozici. Testováno jen proti
// mock spustitelným souborům (echo/timeout skripty v tests/). Než tohle
// poběží ostře poprvé, MUSÍ se ověřit na skutečném Windows agentovi --
// zejména: skutečný formát stdout/log souboru z AkciaOmega.bat, skutečná
// cesta k .bat, chování při zamčeném/používaném Pohoda souboru.
//
// THREAT MODEL (L-Code pravidlo -- custom bypass/limity musí mít popsaný
// failure mode a kdo ho odchytí):
//   1. Proces zamrzne (Pohoda dialog čeká na input, síťový mount nedostupný)
//      -> `timeoutMs` kill (SIGTERM, pak SIGKILL po killGracePeriodMs) ->
//      exitCode: null, error: 'TIMEOUT_KILLED' -> Gate 5 (`OmegaPostImport
//      ValidationGate`) vidí executorResult bez exitCode===0 ->
//      TARGET_RESULT_UNKNOWN (NENÍ COMPLETED, karanténa řeší dál).
//   2. .bat neexistuje / není spustitelný -> spawn 'error' event, nezachyceno
//      by shodilo celý Node proces -> zachyceno explicitně, vrací
//      exitCode: null, error: 'SPAWN_FAILED'.
//   3. Log soubor nikdy nevznikne (crash před zápisem) -> logContent: null,
//      navazující OmegaImportLogParser už řeší jako 'LOG_MISSING'.
//   4. Whitelist bypass (např. "EvilAkciaOmega.bat" projde starým
//      `.endsWith()`) -> zpřísněno na přesnou shodu basename
//      (`path.basename() === 'AkciaOmega.bat'`), ne jen suffix.
//   5. Runaway stdout/stderr (nekonečný log) -> capped na maxOutputBytes,
//      dál se zahazuje (proces neblokuje, jen se nezaznamená celý výstup).
//   6. Souběžné spuštění stejného jobu dvakrát (retry race) -> MIMO SCOPE
//      TÉTO TŘÍDY -- řeší AgentWorker/DeliveryJob úroveň (idempotency
//      klíč), OmegaExecutor je bezstavový, neví o jiných bězích.
//
// Gate 5 (OmegaPostImportValidationGate) je navrženo tak, že cokoliv jiného
// než čistý exitCode===0 + validní log vede k TARGET_RESULT_UNKNOWN nebo
// QUARANTINED -- OmegaExecutor proto NEMUSÍ sám garantovat úspěch, jen
// věrně reportovat, co se skutečně stalo, a nikdy tiše nelhat o výsledku.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ExecutorResult {
    pid: number;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    startTime: Date;
    endTime: Date;
    durationMs: number;
    logContent: string | null;
    error?: string;
}

export interface OmegaExecutorOptions {
    /** Kolik ms čekat na dokončení procesu, než se pošle SIGTERM. Default 60s. */
    timeoutMs?: number;
    /** Kolik ms čekat po SIGTERM, než se pošle SIGKILL (proces ignoruje TERM). Default 5s. */
    killGracePeriodMs?: number;
    /** Cap na zaznamenaný stdout/stderr, aby runaway proces nezahltil paměť. Default 1 MiB. */
    maxOutputBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_KILL_GRACE_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const ALLOWED_EXECUTABLE_BASENAME = 'AkciaOmega.bat';

export class OmegaExecutor {
    private readonly timeoutMs: number;
    private readonly killGracePeriodMs: number;
    private readonly maxOutputBytes: number;

    constructor(
        private readonly allowedExecutablePath: string,
        private readonly logFilePath: string,
        options: OmegaExecutorOptions = {}
    ) {
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.killGracePeriodMs = options.killGracePeriodMs ?? DEFAULT_KILL_GRACE_MS;
        this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    }

    public async execute(payloadPath: string): Promise<ExecutorResult> {
        const startTime = new Date();

        // Přesná shoda basename, ne jen suffix -- "EvilAkciaOmega.bat" by
        // starým `.endsWith('AkciaOmega.bat')` prošlo, tímhle ne.
        if (path.basename(this.allowedExecutablePath) !== ALLOWED_EXECUTABLE_BASENAME) {
            throw new Error(`Security Violation: Executable not allowed (expected basename "${ALLOWED_EXECUTABLE_BASENAME}")`);
        }

        return new Promise<ExecutorResult>((resolve) => {
            let stdout = '';
            let stderr = '';
            let stdoutTruncated = false;
            let stderrTruncated = false;
            let settled = false;
            let killTimer: ReturnType<typeof setTimeout> | undefined;
            let termSent = false;

            const finalize = (exitCode: number | null, error?: string) => {
                if (settled) return;
                settled = true;
                if (killTimer) clearTimeout(killTimer);

                const endTime = new Date();
                let logContent: string | null = null;
                try {
                    if (fs.existsSync(this.logFilePath)) {
                        logContent = fs.readFileSync(this.logFilePath, 'utf8');
                    }
                } catch {
                    // Log soubor nečitelný (permissions, zamčeno jiným procesem) --
                    // logContent zůstává null, navazující parser to řeší jako LOG_MISSING.
                }

                resolve({
                    pid: child.pid ?? -1,
                    exitCode,
                    stdout,
                    stderr,
                    startTime,
                    endTime,
                    durationMs: endTime.getTime() - startTime.getTime(),
                    logContent,
                    ...(error ? { error } : {}),
                });
            };

            let child: ReturnType<typeof spawn>;
            try {
                child = spawn(this.allowedExecutablePath, [payloadPath], {
                    windowsHide: true,
                    shell: false,
                });
            } catch (e: any) {
                finalize(null, `SPAWN_FAILED: ${e.message}`);
                return;
            }

            const timeoutTimer = setTimeout(() => {
                if (settled) return;
                termSent = true;
                child.kill('SIGTERM');
                killTimer = setTimeout(() => {
                    if (settled) return;
                    child.kill('SIGKILL');
                }, this.killGracePeriodMs);
            }, this.timeoutMs);

            child.on('error', (e) => {
                clearTimeout(timeoutTimer);
                finalize(null, `SPAWN_FAILED: ${e.message}`);
            });

            child.stdout?.on('data', (chunk: Buffer) => {
                if (stdout.length >= this.maxOutputBytes) {
                    stdoutTruncated = true;
                    return;
                }
                stdout += chunk.toString('utf8');
                if (stdout.length > this.maxOutputBytes) {
                    stdout = stdout.slice(0, this.maxOutputBytes);
                    stdoutTruncated = true;
                }
            });

            child.stderr?.on('data', (chunk: Buffer) => {
                if (stderr.length >= this.maxOutputBytes) {
                    stderrTruncated = true;
                    return;
                }
                stderr += chunk.toString('utf8');
                if (stderr.length > this.maxOutputBytes) {
                    stderr = stderr.slice(0, this.maxOutputBytes);
                    stderrTruncated = true;
                }
            });

            child.on('close', (code) => {
                clearTimeout(timeoutTimer);
                if (stdoutTruncated) stdout += '\n[...OUTPUT TRUNCATED...]';
                if (stderrTruncated) stderr += '\n[...OUTPUT TRUNCATED...]';
                if (termSent && code === null) {
                    finalize(null, 'TIMEOUT_KILLED');
                } else {
                    finalize(code);
                }
            });
        });
    }
}
