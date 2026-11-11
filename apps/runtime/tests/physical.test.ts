import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalBytes, validateSchema, type ExecutionSnapshotV1 } from '@veriq/contracts';
import { compileFiles, COMPILER_VERSION } from '@veriq/compiler';
import { actualDistribution } from '../../../packages/runner-sdk/tests/distribution.ts';
import { snapshot, asset, id } from '../../../packages/compiler/tests/helpers.ts';
import { DeviceStore, RuntimeClient } from '../src/enrollment.ts';
import { DeviceSession } from '../src/agent/credentials.ts';
import { AgentClient, type Claim } from '../src/agent/transport.ts';
import { ExecutionSupervisor } from '../src/execution/supervisor.ts';
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
test('actual approved generated TS runs with fresh browser/fixture/workdir and real restricted traces', { timeout: 180000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'veriq-t10-physical-'));
    const contents = new Map<string, Uint8Array>();
    const uploads = new Map<string, {
        bytes: Buffer;
        sha256: string;
        filename: string;
    }>();
    const events: Record<string, unknown>[] = [];
    const fixtures: string[] = [];
    const cookies: string[] = [];
    let run = 0, activation = false, loseActivation = false, serviceWorkerHits = 0, currentToken = 'a'.repeat(43), origin = '';
    const server = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req)
            chunks.push(chunk);
        const bytes = Buffer.concat(chunks);
        const path = req.url!.split('?')[0]!;
        const reply = (data: unknown, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data, requestId: 'test' })); };
        if (path.startsWith('/internal/')) {
            assert.equal(req.headers.authorization, `Bearer ${currentToken}`);
            if (path.endsWith('/rotate')) {
                currentToken = JSON.parse(bytes.toString()).replacementToken;
                reply({ runnerId: id(70), workspaceId: id(99), deviceToken: currentToken, expiresAt: '2027-01-01T00:00:00Z' });
                return;
            }
            if (path.includes('/content/')) {
                const value = contents.get(path.split('/').pop()!);
                assert(value);
                res.end(value);
                return;
            }
            if (path.endsWith('/activate')) {
                activation = true;
                if (loseActivation) {
                    req.socket.destroy();
                    return;
                }
                reply({ attemptId: id(80 + run), activated: true, fencingToken: 1 });
                return;
            }
            if (path.endsWith('/heartbeat')) {
                reply({ leaseExpiresAt: new Date(Date.now() + 60000).toISOString(), serverTime: new Date().toISOString(), leaseDurationMs: 60000, cancelRequested: false });
                return;
            }
            if (path.endsWith('/credentials/resolve')) {
                assert(activation);
                const value = JSON.parse(bytes.toString());
                reply({ secretRef: value.secretRef, versionId: value.versionId, value: { token: value.secretRef === 'fixture' ? 'fixture-token' : 'business-token' } });
                return;
            }
            if (path.endsWith('/events')) {
                const value = JSON.parse(bytes.toString());
                for (const e of value.events) {
                    assert.deepEqual(validateSchema('ExecutionEventV1', e), []);
                    events.push(e);
                }
                reply({ acceptedThrough: value.events.at(-1).sequence });
                return;
            }
            if (path.endsWith('/artifact-uploads')) {
                const value = JSON.parse(bytes.toString());
                const key = randomUUID();
                uploads.set(key, { bytes: Buffer.alloc(0), sha256: value.sha256, filename: value.filename });
                reply({ artifactId: key, uploadUrl: `/internal/uploads/${key}`, method: 'PUT', expiresAt: '2027-01-01T00:00:00Z' }, 201);
                return;
            }
            if (path.startsWith('/internal/uploads/')) {
                const upload = uploads.get(path.split('/').pop()!)!;
                upload.bytes = Buffer.concat([upload.bytes, bytes]);
                reply({ artifactId: path.split('/').pop(), receivedBytes: upload.bytes.length, complete: true });
                return;
            }
            if (path.endsWith('/finish')) {
                reply({ attemptId: id(80 + run), accepted: true, outcome: JSON.parse(bytes.toString()).outcome, manifestSha256: JSON.parse(bytes.toString()).manifestSha256 });
                return;
            }
            if (path.endsWith('/reconcile')) {
                reply({ attemptId: id(80 + run), capacityReleased: true, auditId: id(90) });
                return;
            }
            throw new Error('Unexpected control request ' + path);
        }
        assert(activation);
        assert.notEqual(req.headers.authorization, `Bearer ${currentToken}`);
        if (path === '/me') {
            reply(undefined);
            return;
        }
        if (path === '/identity') {
            res.end(JSON.stringify({ id: req.headers.authorization === 'Bearer fixture-token' ? 'fixture-service' : 'reader' }));
            return;
        }
        if (path === '/prepare') {
            const value = JSON.parse(bytes.toString());
            fixtures.push(value.idempotencyKey);
            res.end(JSON.stringify({ fixtureId: randomUUID(), namespace: value.namespace, variables: {}, cleanupToken: 'private-cleanup-token' }));
            return;
        }
        if (path === '/cleanup') {
            res.end(JSON.stringify({ status: 'CLEANED' }));
            return;
        }
        if (path === '/status') {
            res.end(JSON.stringify({ ok: run === 2 }));
            return;
        }
        if (path === '/sw.js') {
            serviceWorkerHits++;
            res.setHeader('Content-Type', 'application/javascript');
            res.end('self.addEventListener("fetch",()=>{});');
            return;
        }
        cookies.push(req.headers.cookie ?? '');
        res.setHeader('Set-Cookie', `attempt=${run}; Path=/`);
        res.setHeader('Content-Type', 'text/html');
        res.end('<div data-testid="name">Ready</div><script>navigator.serviceWorker.register("/sw.js").catch(()=>{});</script>');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    origin = `http://127.0.0.1:${address.port}`;
    let session: DeviceSession | undefined;
    try {
        const builder = join(root, 'build');
        await mkdir(builder);
        const before = process.cwd();
        let distribution: ReturnType<typeof actualDistribution>;
        try {
            process.chdir(resolve('../../packages/runner-sdk'));
            distribution = actualDistribution(builder);
        }
        finally {
            process.chdir(before);
        }
        const source = snapshot([{ id: 'open', action: 'goto', path: '/' }, { id: 'status', action: 'apiRequest', method: 'GET', path: '/status', observers: [{ id: 'response', method: 'GET', path: '/status', window: { mode: 'UNTIL_ACTION_SETTLED', quietMs: 0 } }], afterAssertions: [{ id: 'ready', type: 'responseField', source: 'response:response', pointer: '/ok', operator: 'equals', expected: true, severity: 'BLOCK', expectedSource: 'REQ-ready' }] }], [asset(3, 'FIXTURE', { schemaVersion: '1.0', prepare: { method: 'POST', path: '/prepare' }, query: { method: 'GET', path: '/query' }, cleanup: { method: 'POST', path: '/cleanup' }, inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, ttlSeconds: 60 })], { fixtureVersionId: id(3) });
        const output = compileFiles(source, distribution!);
        const release = join(root, 'release');
        await mkdir(join(release, 'engine'), { recursive: true });
        execFileSync('/usr/bin/tar', ['-czf', join(release, 'engine/compiler.tgz'), '-C', resolve('../../packages/compiler'), 'src', 'package.json']);
        const releaseFiles = { ...Object.fromEntries(Object.entries(output.files).filter(([p]) => p.startsWith('vendor/') || ['package.json', 'package-lock.json', 'dependencies.json'].includes(p))), 'engine/compiler.tgz': await readFile(join(release, 'engine/compiler.tgz')) };
        const entry = { engineVersion: '0.1.0', compilerVersion: COMPILER_VERSION, runnerSdkVersion: '0.1.0', dependencies: distribution!.dependencies, files: Object.entries(releaseFiles).map(([path, bytes]) => ({ path, sha256: hash(bytes), sizeBytes: bytes.length })) };
        await writeFile(join(release, 'inventory.json'), canonicalBytes({ schemaVersion: '1.0', engines: [entry] }));
        for (const [path, bytes] of Object.entries(releaseFiles)) {
            await mkdir(dirname(join(release, path)), { recursive: true });
            await writeFile(join(release, path), bytes);
        }
        await rm(builder, { recursive: true, force: true });
        const store = new DeviceStore(join(root, 'device'));
        await store.save({ server: origin, runnerId: id(70), workspaceId: id(99), deviceToken: currentToken, expiresAt: '2027-01-01T00:00:00Z' });
        session = new DeviceSession(store, new RuntimeClient(origin));
        await session.open();
        const supervisor = new ExecutionSupervisor({ root: join(root, 'agent'), client: new AgentClient(session), releaseDirectory: release, browserExecutable: '/usr/bin/chromium' });
        const results = [];
        let previous: Claim | undefined;
        for (run = 1; run <= 2; run++) {
            activation = false;
            const config = { kind: 'HTTP_BEARER' as const, identityPath: '/identity', identityPointer: '/id' };
            const execution: ExecutionSnapshotV1 = { schemaVersion: '1.0', workspaceId: id(99), runId: id(10), caseExecutionId: id(11), caseVersionId: id(1), assetSourceHash: source.sourceHash, environmentVersionId: id(12), environment: { schemaVersion: '1.0', baseURL: origin, apiBaseURL: origin, fixtureBaseURL: origin, allowedOrigins: [origin], locale: 'en', timezone: 'UTC', roles: [{ roleKey: 'reader', authAdapterVersionId: id(13), secretRef: 'business', secretVersionId: id(14), allowedIdentityIds: ['reader'] }], fixtureIdentity: { authAdapterVersionId: id(13), secretRef: 'fixture', secretVersionId: id(15), allowedIdentityIds: ['fixture-service'] } }, roleKey: 'reader', browser: 'chromium', variables: {}, secretVersions: [{ secretRef: 'business', versionId: id(14) }, { secretRef: 'fixture', versionId: id(15) }], namespace: `attempt-${run}`, attemptNo: run, authAdapters: [{ workspaceId: id(99), versionId: id(13), configuration: config, contentHash: hash(canonicalBytes(config)) }] };
            const put = (value: Uint8Array) => { const digest = hash(value); contents.set(digest, value); return digest; };
            const manifest = { schemaVersion: '1.0', workspaceId: id(99), jobId: id(60), snapshotSha256: put(canonicalBytes(source)), engineVersion: '0.1.0', kind: 'TEST', caseExecutionId: id(11), caseVersionId: id(1), compiledBundleSha256: put(canonicalBytes(output.bundle)), executionSnapshotSha256: put(canonicalBytes(execution)) };
            for (const bytes of Object.values(output.files))
                put(bytes);
            const manifestHash = put(canonicalBytes(manifest));
            const claim: Claim = { jobId: id(60), jobKind: 'TEST', attemptId: id(80 + run), leaseToken: 'test-lease-token', fencingToken: 1, expiresAt: new Date(Date.now() + 60000).toISOString(), serverTime: new Date().toISOString(), leaseDurationMs: 60000, activationRequired: true, snapshotUrl: `/internal/v1/workspaces/${id(99)}/attempts/${id(80 + run)}/content/${manifestHash}`, snapshotSha256: manifestHash };
            previous = claim;
            const result = await supervisor.runAttempt({ claim, requestStarted: performance.now(), responseReceived: performance.now() }, new AbortController().signal);
            results.push(result);
            if (!result.completion) {
                try { process.stderr.write('guardian: '+await readFile(join(root,'agent/processes',claim.attemptId+'.drained.json.error'),'utf8')); } catch {}
                for (const file of ['worker-failure.json', 'worker-result.json', 'tmp/playwright.json'])
                    try {
                        const diagnostic = await readFile(join(root, 'agent/work', claim.attemptId, file), 'utf8');
                        process.stderr.write(file + ': ' + diagnostic.slice(0, 16000) + '\n');
                    }
                    catch { }
            }
            assert(result.completion, `missing actual completion: ${JSON.stringify(result.stop)}`);
            assert.equal(result.stop.processStopped, true);
            assert(result.files.some(f => f.kind === 'TRACE' && f.file.sensitivity === 'CREDENTIAL_RESTRICTED' && f.file.sizeBytes > 0));
            assert.deepEqual(supervisor.processes.active(), []);
            await rm(join(root, 'agent/work', claim.attemptId), { recursive: true, force: true });
        }
        assert.equal(serviceWorkerHits, 0);
        loseActivation = true;
        const lost = { ...previous!, attemptId: id(84), serverTime: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() };
        const recovered = await supervisor.runAttempt({ claim: lost, requestStarted: performance.now(), responseReceived: performance.now() }, new AbortController().signal);
        assert.equal(recovered.completion, undefined);
        assert.equal(recovered.stop.processStopped, true);
        assert.equal(recovered.stop.reason, 'NETWORK_UNAVAILABLE');
        assert.equal(fixtures.length, 2);
        assert.deepEqual(supervisor.processes.active(), []);
        assert.equal(results[0]!.completion!.businessOutcome, 'FAILED');
        assert.equal(results[1]!.completion!.businessOutcome, 'PASSED');
        assert.equal(new Set(fixtures).size, 2);
        assert.deepEqual(cookies, ['', '']);
        assert(!JSON.stringify(events).includes('private-cleanup-token'));
        assert(!JSON.stringify(events).includes(currentToken));
        for (const upload of uploads.values())
            assert.equal(hash(upload.bytes), upload.sha256);
    }
    finally {
        await session?.close();
        server.closeAllConnections();
        server.close();
        await rm(root, { recursive: true, force: true });
    }
});
