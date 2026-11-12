import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
test('local execution ownership survives reopen and unknown stop never frees the single context', async () => {
    const { LocalStore } = await import('../src/offline/store.ts');
    const directory = await mkdtemp(join(tmpdir(), 'veriq-local-store-'));
    try {
        const first = await LocalStore.open(directory);
        const workspaceId = randomUUID(), runId = randomUUID(), attemptId = randomUUID();
        first.reserve(workspaceId, runId, attemptId);
        first.spawning(runId, attemptId, first.active()!);
        first.close();
        const reopened = await LocalStore.open(directory);
        assert.equal(reopened.active()?.attemptId, attemptId);
        assert.throws(() => reopened.reserve(workspaceId, randomUUID(), randomUUID()), /LOCAL_CAPACITY_HELD/);
        reopened.stopped(runId, { attemptId, processStopped: false, reason: 'UNKNOWN_PROCESS', stoppedAt: new Date().toISOString() }, reopened.active()!);
        assert.equal(reopened.active()?.state, 'QUARANTINED');
        assert.throws(() => reopened.reserve(workspaceId, randomUUID(), randomUUID()), /LOCAL_CAPACITY_HELD/);
        reopened.close();
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
});
test('local event mapping uses canonical attempt sequence without cloud transport', async () => {
    const { sdkFact, executionEvent } = await import('../src/execution/events.ts');
    const fact = sdkFact({ type: 'STEP_STARTED', stepId: 'open' });
    assert.deepEqual(fact, { type: 'STEP_STARTED', stepId: 'open', payload: {} });
    const attemptId = randomUUID();
    assert.equal(executionEvent(attemptId, 2, fact).sequence, 2);
    assert.throws(() => executionEvent(attemptId, 0, fact), /INVALID_EXECUTION_EVENT/);
});
test('initial local report commits atomically with ownership before any child is spawned', async () => {
    const { LocalStore } = await import('../src/offline/store.ts');
    const dir = await mkdtemp(join(tmpdir(), 'veriq-local-checkpoint-'));
    try {
        const store = await LocalStore.open(dir), runId = randomUUID(), ws = randomUUID(), attemptId = randomUUID();
        const checkpoint: import('@veriq/contracts').OfflineResultV1 = { schemaVersion: '1.0', workspaceId: ws, bundleId: randomUUID(), localRunId: runId, deviceId: randomUUID(), source: 'OFFLINE_IMPORT', trustStatus: 'USER_REGISTERED', dirty: false, revocationStatus: 'UNKNOWN', manifestSha256: 'a'.repeat(64), startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), outcome: 'INCOMPLETE', actualEnvironment: { schemaVersion: '1.0', baseURL: 'https://business.test', apiBaseURL: 'https://business.test', allowedOrigins: ['https://business.test'], locale: 'en', timezone: 'UTC', roles: [{ roleKey: 'reader', authAdapterVersionId: randomUUID(), secretRef: 'reader', secretVersionId: randomUUID() }] }, attempts: [{ attemptId, caseVersionId: randomUUID(), attemptNo: 1, outcome: 'INCOMPLETE', cleanupStatus: 'PENDING', lastSequence: 0, events: [], artifacts: [] }] };
        store.reserve(ws, runId, attemptId, checkpoint);
        store.close();
        const reopened = await LocalStore.open(dir);
        assert.equal(reopened.result(ws, runId).outcome, 'INCOMPLETE');
        reopened.close();
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
test('offline CLI exposes execute, cancel, history, report and explicit upload without credentials in argv', () => {
    const { status, stdout } = requireSpawn(['--help']);
    assert.equal(status, 0);
    assert.match(stdout, /run/);
    assert.match(stdout, /results/);
    const results = requireSpawn(['results', '--help']);
    assert.match(results.stdout, /history/);
    assert.match(results.stdout, /report/);
    assert.match(results.stdout, /upload/);
    assert.match(results.stdout, /cancel/);
});
function requireSpawn(args: string[]) { return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { encoding: 'utf8' }); }
test('two OS processes compete for one durable local context', async () => {
    const { LocalStore } = await import('../src/offline/store.ts');
    const { spawn } = await import('node:child_process');
    const dir = await mkdtemp(join(tmpdir(), 'veriq-local-race-'));
    try {
        const initialized = await LocalStore.open(dir);
        initialized.close();
        const script = `import {LocalStore} from './src/offline/store.ts';import {randomUUID} from 'node:crypto';const store=await LocalStore.open(process.argv[1]);try{store.reserve(randomUUID(),randomUUID(),randomUUID());console.log('ACQUIRED');}catch(e){console.log(e.message);}finally{store.close();}`;
        const compete = () => new Promise<string>((resolve, reject) => { const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, dir], { stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; child.stdout.on('data', b => output += b); child.once('error', reject); child.once('exit', status => status === 0 ? resolve(output.trim()) : reject(new Error('STORE_CHILD_FAILED'))); });
        assert.deepEqual((await Promise.all([compete(), compete()])).sort(), ['ACQUIRED', 'LOCAL_CAPACITY_HELD']);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
