import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalStore } from '../src/offline/store.ts';
import { ProcessSupervisor } from '../src/execution/processes.ts';
import type { OfflineResultV1 } from '@veriq/contracts';
export function initialResult(): OfflineResultV1 {
    const ws = randomUUID();
    return { schemaVersion: '1.0', workspaceId: ws, bundleId: randomUUID(), localRunId: randomUUID(), deviceId: randomUUID(), source: 'OFFLINE_IMPORT', trustStatus: 'USER_REGISTERED', dirty: false, revocationStatus: 'UNKNOWN', manifestSha256: 'a'.repeat(64), startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), outcome: 'INCOMPLETE', actualEnvironment: { schemaVersion: '1.0', baseURL: 'https://business.test', apiBaseURL: 'https://business.test', allowedOrigins: ['https://business.test'], locale: 'en', timezone: 'UTC', roles: [{ roleKey: 'reader', authAdapterVersionId: randomUUID(), secretRef: 'reader', secretVersionId: randomUUID() }] }, attempts: [{ attemptId: randomUUID(), caseVersionId: randomUUID(), attemptNo: 1, outcome: 'INCOMPLETE', cleanupStatus: 'PENDING', lastSequence: 0, events: [], artifacts: [] }] };
}
function child(script: string, dir: string) {
    const process = spawn(globalThis.process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, dir], { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = createInterface({ input: process.stdout })[Symbol.asyncIterator]();
    let errors = '';
    process.stderr.on('data', b => errors += b);
    return { process, go() { process.stdin.write('x'); }, async line() { const row = await lines.next(); assert(!row.done, errors); return JSON.parse(row.value) as Record<string, unknown>; } };
}
const common = `import {readSync} from 'node:fs';import {LocalStore} from './src/offline/store.ts';const root=process.argv[1];process.stdin._handle.setBlocking(true);const gate=()=>readSync(0,Buffer.alloc(1),0,1,null);const say=x=>console.log(JSON.stringify(x));`;
for (const winner of ['host', 'recovery'])
    test(`recovery observation versus real process launch: ${winner} wins`, { timeout: 30000 }, async () => {
        const root = await mkdtemp(join(tmpdir(), 'vq-race-')), result = initialResult(), attemptId = result.attempts[0]!.attemptId;
        const store = await LocalStore.open(root);
        store.reserve(result.workspaceId, result.localRunId, attemptId, result);
        const recovering = child(common + `import {recoverOffline} from './src/offline/run.ts';const active=LocalStore.prototype.active;let once=true;LocalStore.prototype.active=function(){const owner=active.call(this);if(once){once=false;say({observed:owner.state});gate();}return owner;};try{say({done:await recoverOffline(root)});}catch(e){say({error:e.message});}`, root);
        const host = child(common + `import {ProcessSupervisor} from './src/execution/processes.ts';import {join} from 'node:path';const store=await LocalStore.open(root);let owner=store.active();say({ready:true});gate();try{owner=store.spawning(owner.runId,owner.attemptId,owner)??{...owner,state:'SPAWNING'};}catch(e){say({denied:e.message});store.close();process.exit(0);}const supervisor=new ProcessSupervisor(join(root,'processes'));const worker=await supervisor.start(owner.attemptId,{executable:process.execPath,args:['-e',"console.log('LIVE');setInterval(()=>{},1000)"],cwd:root});await worker.firstLine();say({live:worker.pid});gate();const stop=await supervisor.terminateAttempt(owner.attemptId,'TEST_STOP');try{store.stopped(owner.runId,stop,owner);}catch{}store.close();say({stopped:stop.processStopped});`, root);
        try {
            assert.equal((await recovering.line()).observed, 'ALLOCATED');
            assert.equal((await host.line()).ready, true);
            if (winner === 'host') {
                host.go();
                const live = await host.line();
                assert.equal(typeof live.live, 'number');
                recovering.go();
                const recovered = await recovering.line();
                assert.equal(recovered.error, undefined);
                const owner = store.active();
                if (!owner) {
                    const receipt = recovered.done as {
                        processStopped: boolean;
                        reason: string;
                    };
                    assert.equal(receipt.processStopped, true);
                    assert.notEqual(receipt.reason, 'NO_PROCESS_SPAWNED', 'stale ALLOCATED observation freed a live native worker');
                    const proof = await new ProcessSupervisor(join(root, 'processes')).terminateAttempt(attemptId, 'VERIFY');
                    assert.equal(proof.processStopped, true);
                }
                else
                    assert.throws(() => store.reserve(result.workspaceId, randomUUID(), randomUUID()), /LOCAL_CAPACITY_HELD/);
                host.go();
                assert.equal((await host.line()).stopped, true);
            }
            else {
                recovering.go();
                const recovered = await recovering.line();
                assert.equal(recovered.error, undefined);
                assert.equal((recovered.done as {
                    reason: string;
                }).reason, 'NO_PROCESS_SPAWNED');
                store.reserve(result.workspaceId, randomUUID(), randomUUID());
                host.go();
                assert.equal((await host.line()).denied, 'LOCAL_OWNERSHIP_LOST');
            }
        }
        finally {
            recovering.process.kill('SIGKILL');
            host.process.kill('SIGKILL');
            await new ProcessSupervisor(join(root, 'processes')).terminateAttempt(attemptId, 'TEST_CLEANUP');
            store.close();
            await rm(root, { recursive: true, force: true });
        }
    });
test('ownership handoff commits the next attempt checkpoint before abrupt host death', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vq-handoff-')), result = initialResult();
    const store = await LocalStore.open(root);
    try {
        store.reserve(result.workspaceId, result.localRunId, result.attempts[0]!.attemptId, result);
        const owner = store.active()!;
        store.stopped(result.localRunId, { attemptId: owner.attemptId, processStopped: true, reason: 'NO_PROCESS_SPAWNED', stoppedAt: new Date().toISOString() }, owner);
        const host = child(common + `const store=await LocalStore.open(root);const owner=store.active();const result=store.result(owner.workspaceId,owner.runId);const next={...result.attempts[0],attemptId:'11111111-2222-4333-8444-555555555555',attemptNo:2};result.attempts.push(next);store.nextAttempt(owner.runId,next.attemptId,owner,result);say({handoff:true});gate();`, root);
        try {
            assert.equal((await host.line()).handoff, true);
            host.process.kill('SIGKILL');
            await new Promise<void>(r => host.process.once('exit', () => r()));
            const reopened = await LocalStore.open(root);
            const owned = reopened.active()!;
            assert(reopened.result(owned.workspaceId, owned.runId).attempts.some(a => a.attemptId === owned.attemptId), 'ownership names an attempt absent from the durable report');
            reopened.close();
        }
        finally {
            host.process.kill('SIGKILL');
        }
    }
    finally {
        store.close();
        await rm(root, { recursive: true, force: true });
    }
});
test('ambiguous legacy upload retains history and an actionable pending error without executing again', async () => {
    const { createServer } = await import('node:http');
    const { uploadOffline } = await import('../src/offline/upload.ts');
    const root = await mkdtemp(join(tmpdir(), 'vq-legacy-')), result = initialResult();
    let requests = 0;
    const server = createServer((req, res) => { requests++; req.resume(); res.writeHead(422, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: 'OFFLINE_VARIANT_FACTS_REQUIRED', message: 'Legacy result has ambiguous variants' })); });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    try {
        const store = await LocalStore.open(root);
        let owner = store.reserve(result.workspaceId, result.localRunId, result.attempts[0]!.attemptId, result);
        owner = store.stopped(result.localRunId, { attemptId: owner.attemptId, processStopped: true, reason: 'NO_PROCESS_SPAWNED', stoppedAt: new Date().toISOString() }, owner);
        store.finish(result, owner);
        store.close();
        await assert.rejects(uploadOffline(root, result.localRunId, { server: `http://127.0.0.1:${(server.address() as {
                port: number;
            }).port}`, workspaceId: result.workspaceId, deviceToken: 'synthetic-device-token' }), /OFFLINE_VARIANT_FACTS_REQUIRED/);
        const reopened = await LocalStore.open(root);
        assert.deepEqual(reopened.result(result.workspaceId, result.localRunId), result);
        assert.equal(reopened.history(result.workspaceId)[0]!.uploadState, 'PENDING');
        assert.equal(reopened.history(result.workspaceId)[0]!.uploadError, 'OFFLINE_VARIANT_FACTS_REQUIRED');
        assert.equal(reopened.active(), undefined);
        reopened.close();
        assert.equal(requests, 1);
    }
    finally {
        await new Promise<void>(r => server.close(() => r()));
        await rm(root, { recursive: true, force: true });
    }
});
