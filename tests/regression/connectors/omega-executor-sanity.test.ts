// Sanity testy pro OmegaExecutor (connectors/omega/legacy/agent/
// OmegaExecutor.ts) -- NEOVĚŘENO proti reálnému Windows agentovi/
// AkciaOmega.bat (viz komentář v souboru). Tyto testy ověřují jen obecné
// child_process chování (timeout/kill, spawn failure, output cap,
// whitelist) proti mock Node skriptům -- ne skutečnou Omega/Pohoda
// integraci.
//
// Mock "executable" je spuštěn přes `process.execPath <script.js>` kvůli
// cross-platform (macOS dev stroj nemá .bat), ale basename validace se
// testuje samostatně proti řetězcům, ne přes skutečný spawn.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { OmegaExecutor } from '../../../connectors/omega/legacy/agent/OmegaExecutor.js';

// Timeout 20s pro celý describe (ne vitest default 5s): každý test tady
// spawnuje skutečný Node proces (mock AkciaOmega.bat) -- tj. plný boot
// interpreteru + pipe. Izolovaně je to rychlé (spawn ~70 ms, output cap
// ~115 ms na 2 MiB), ale pod plnou sadou (paralelní workery, Mac Mini 2014)
// stejné volání reálně trvá 1,5-6,2 s a náhodně přeteče přes 5s hranici.
// Ověřeno měřením s 60s limitem: execute() doběhne za 4184 ms se správným
// výsledkem (stdout 1049 B = 1024B cap + marker) -- NEJDE tedy o zaseknutý
// proces ani o díru v output capu, jen o CPU contention na pomalém stroji.
// Produkční kód (OmegaExecutor.ts) proto zůstal beze změny.
describe('OmegaExecutor — sanity (mock scripts, NOT real Windows agent)', { timeout: 20_000 }, () => {
    let tmpDir: string;
    let logPath: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-executor-test-'));
        logPath = path.join(tmpDir, 'log.txt');
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // Whitelist v OmegaExecutor kontroluje `path.basename() === 'AkciaOmega.bat'`
    // -- mock skripty se proto musí jmenovat přesně tak, i když jsou to ve
    // skutečnosti .js soubory spouštěné přes node interpreter.
    function akciaOmegaPath(): string {
        return path.join(tmpDir, 'AkciaOmega.bat');
    }

    it('rejects a non-whitelisted executable path (basename mismatch)', async () => {
        const executor = new OmegaExecutor(
            path.join(tmpDir, 'EvilAkciaOmega.bat'),
            logPath
        );
        await expect(executor.execute('payload.txt')).rejects.toThrow(/Security Violation/);
    });

    it('accepts exact basename match even with different directory', async () => {
        // Nemůžeme spustit skutečný .bat na macOS testovacím stroji -- ověřujeme
        // jen že whitelist kontrola PROJDE (nevyhodí Security Violation) a
        // spawn selže smysluplně (ENOENT/EACCES), ne že by proces uspěl.
        const executor = new OmegaExecutor(akciaOmegaPath(), logPath);
        const result = await executor.execute('payload.txt');
        expect(result.exitCode).toBeNull();
        expect(result.error).toMatch(/SPAWN_FAILED/);
    });

    it('reports SPAWN_FAILED (not an uncaught process crash) when executable does not exist', async () => {
        const executor = new OmegaExecutor(akciaOmegaPath(), logPath);
        const result = await executor.execute('payload.txt');
        expect(result.pid).toBe(-1);
        expect(result.exitCode).toBeNull();
        expect(result.error).toContain('SPAWN_FAILED');
        expect(result.logContent).toBeNull();
    });

    it('reads log file written by the process and reports exitCode 0 on success', async () => {
        // OmegaExecutor spawn-uje allowedExecutablePath přímo (shell:false), takže
        // mock musí být spustitelný sám o sobě. Na Windows je .bat nativně
        // spustitelný; zde simulujeme přes shebang + chmod, aby exec fungoval i
        // na macOS/Linux CI.
        const scriptContent = `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(logPath)}, 'OMEGA Import Log\\r\\nImported: 1\\r\\nErrors: 0\\r\\nDocument: DOC-123 SUCCESS\\r\\n', 'utf8');
process.exit(0);
`;
        fs.writeFileSync(akciaOmegaPath(), scriptContent, { mode: 0o755 });

        const executor = new OmegaExecutor(akciaOmegaPath(), logPath);
        const result = await executor.execute('payload.txt');
        expect(result.exitCode).toBe(0);
        expect(result.logContent).toContain('Document: DOC-123 SUCCESS');
        expect(result.error).toBeUndefined();
    });

    it('kills a hung process after timeoutMs and reports TIMEOUT_KILLED', async () => {
        const scriptContent = `
            setTimeout(() => process.exit(0), 30000); // simuluje zamrznutí (Pohoda dialog)
        `;
        fs.writeFileSync(akciaOmegaPath(), `#!/usr/bin/env node\n${scriptContent}`, { mode: 0o755 });

        const executor = new OmegaExecutor(akciaOmegaPath(), logPath, {
            timeoutMs: 200,
            killGracePeriodMs: 200,
        });

        const result = await executor.execute('payload.txt');
        expect(result.exitCode).toBeNull();
        expect(result.error).toBe('TIMEOUT_KILLED');
    }, 10_000);

    it('caps stdout at maxOutputBytes without crashing or hanging', async () => {
        const scriptContent = `
            process.stdout.write('X'.repeat(2 * 1024 * 1024));
            process.exit(0);
        `;
        fs.writeFileSync(akciaOmegaPath(), `#!/usr/bin/env node\n${scriptContent}`, { mode: 0o755 });

        const executor = new OmegaExecutor(akciaOmegaPath(), logPath, {
            maxOutputBytes: 1024,
        });

        const result = await executor.execute('payload.txt');
        expect(result.exitCode).toBe(0);
        expect(result.stdout.length).toBeLessThan(1024 + 200); // cap + truncation marker
        expect(result.stdout).toContain('TRUNCATED');
    });

    it('reports null logContent (not a throw) when the process never writes the log file', async () => {
        const scriptContent = `process.exit(0);`; // never writes logPath
        fs.writeFileSync(akciaOmegaPath(), `#!/usr/bin/env node\n${scriptContent}`, { mode: 0o755 });

        const executor = new OmegaExecutor(akciaOmegaPath(), logPath);
        const result = await executor.execute('payload.txt');
        expect(result.exitCode).toBe(0);
        expect(result.logContent).toBeNull();
    });

    it('reports non-zero exit code faithfully without throwing', async () => {
        const scriptContent = `process.exit(7);`;
        fs.writeFileSync(akciaOmegaPath(), `#!/usr/bin/env node\n${scriptContent}`, { mode: 0o755 });

        const executor = new OmegaExecutor(akciaOmegaPath(), logPath);
        const result = await executor.execute('payload.txt');
        expect(result.exitCode).toBe(7);
    });

    it('is safe to call sequentially — no shared mutable state leaks between executions', async () => {
        const scriptContent = `process.exit(0);`;
        fs.writeFileSync(akciaOmegaPath(), `#!/usr/bin/env node\n${scriptContent}`, { mode: 0o755 });

        const executor = new OmegaExecutor(akciaOmegaPath(), logPath);
        const first = await executor.execute('payload1.txt');
        const second = await executor.execute('payload2.txt');
        expect(first.exitCode).toBe(0);
        expect(second.exitCode).toBe(0);
        expect(first.pid).not.toBe(second.pid);
    });
});
