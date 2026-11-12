import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ProcessSupervisor } from '../src/execution/processes.ts';
import { monitorStorage } from '../src/execution/storage.ts';
test('over-quota unfinished Chromium download terminates the real process group', async () => {
    const root = await mkdtemp(join(tmpdir(), 'veriq-t10-quota-'));
    const downloads = join(root, 'downloads');
    await mkdir(downloads);
    let finished = false;
    let closed = false;
    const server = createServer((req, res) => {
        if (req.url === '/') {
            res.setHeader('Content-Type', 'text/html');
            res.end('<a href="/large">Download</a>');
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="large.bin"' });
        const interval = setInterval(() => res.write(Buffer.alloc(128 * 1024)), 10);
        res.on('close', () => { clearInterval(interval); closed = true; });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    const processes = new ProcessSupervisor(join(root, 'journal'));
    let monitor: {
        close(): void;
    } | undefined;
    try {
        const child = await processes.start('quota', { executable: process.execPath, cwd: resolve('.'), args: ['--input-type=module', '-e', `import {chromium} from '@playwright/test';const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox'],downloadsPath:${JSON.stringify(downloads)}});const page=await browser.newPage({serviceWorkers:'block'});await page.goto('http://127.0.0.1:${address.port}/');await page.click('a');console.log('download-active');await new Promise(()=>{});`], env: { XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), TMPDIR: root } });
        await child.firstLine();
        let settle!: (reason: string) => void;
        const stopped = new Promise<string>(resolve => { settle = resolve; });
        monitor = monitorStorage(downloads, 256 * 1024, async (reason) => { const receipt = await processes.terminateAttempt('quota', reason); assert.equal(receipt.processStopped, true); settle(reason); });
        assert.equal(await Promise.race([stopped, new Promise<string>((_, reject) => setTimeout(() => reject(new Error('QUOTA_NOT_ENFORCED')), 10000).unref())]), 'ATTEMPT_STORAGE_LIMIT');
        finished = true;
        assert.deepEqual(processes.active(), []);
        assert.equal(closed, true);
    }
    finally {
        monitor?.close();
        await processes.terminateAttempt('quota', 'TEST_FINALLY');
        server.closeAllConnections();
        server.close();
        await rm(root, { recursive: true, force: true });
    }
    assert.equal(finished, true);
});
