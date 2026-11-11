import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
process.title = 'veriq_runner';
const invocation = JSON.parse(await readFile(process.argv[2], 'utf8'));
await new Promise(resolve => process.once('message', message => { if (message?.type === 'START')
    resolve(); }));
async function command(executable, args, timeout) {
    await new Promise((resolve, reject) => {
        const child = spawn(executable, args, { cwd: invocation.work, env: process.env, stdio: 'ignore' });
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('WORKER_COMMAND_TIMEOUT')); }, timeout);
        child.once('error', () => { clearTimeout(timer); reject(new Error('WORKER_COMMAND_FAILED')); });
        child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('WORKER_COMMAND_FAILED')); });
    });
}
let stage = "INSTALL_FAILED";
try {
    await command(invocation.npm, ['ci', '--offline', '--ignore-scripts', '--audit=false', '--fund=false', '--update-notifier=false', '--cache', join(invocation.tmp, 'npm-cache')], 45000);
    stage = 'COMPILER_EXTRACTION_FAILED';
    await mkdir(join(invocation.work, 'engine/compiler'), { recursive: true });
    // This archive was matched to the operator's fixed release inventory before activation.
    await command('/usr/bin/tar', ['-xzf', 'engine/compiler.tgz', '--no-same-owner', '--no-same-permissions', '-C', 'engine/compiler'], 15000);
    stage = 'COMPILER_PROCESS_FAILED';
    await command(process.execPath, ['--import', invocation.tsx, join(invocation.work, 'compile-entry.mjs')], 45000);
    const result = JSON.parse(await readFile(join(invocation.work, 'worker-result.json'), 'utf8'));
    if (result.kind === 'READY') {
        if (invocation.kind === 'TEST') {
            stage = 'PLAYWRIGHT_PROCESS_FAILED';
            await command(process.execPath, [join(invocation.work, 'node_modules/@playwright/test/cli.js'), 'test', '--config', join(invocation.work, 'playwright.config.mjs')], 240000).catch(() => { });
        }
        else {
            const { cleanupFixture } = await import(new URL('./node_modules/@veriq/runner-sdk/src/index.js', `file://${invocation.work}/`));
            const { contact } = await import(new URL('./provider.mjs', `file://${invocation.work}/`));
            const subject = JSON.parse(await readFile(join(invocation.work, 'subject.json'), 'utf8'));
            await cleanupFixture({ fixture: subject.fixture, context: { execution: subject, signal: AbortSignal.timeout(30000), credentials: { resolve: reference => contact({ type: 'credential', reference }) } } });
            await writeFile(join(invocation.work, 'worker-result.json'), JSON.stringify({ kind: 'CLEANUP', businessOutcome: 'PASSED', cleanupStatus: 'SUCCEEDED' }), { mode: 0o600 });
        }
    }
}
catch {
    await writeFile(join(invocation.work, "worker-failure.json"), JSON.stringify({ failureCode: stage }), { mode: 0o600 });
    // Raw third-party call logs may contain credentials; only stable codes cross this boundary.
    if (invocation.kind === 'CLEANUP')
        await writeFile(join(invocation.work, 'worker-result.json'), JSON.stringify({ kind: 'CLEANUP', businessOutcome: 'ERROR', cleanupStatus: 'FAILED' }), { mode: 0o600 });
    else
        process.exitCode = 1;
}
finally {
    process.disconnect?.();
}
