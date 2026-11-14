/**
 * 本文件编排 Claimed Attempt 的激活、编译、派生子进程与证据收集：崩溃恢复后对账停机：租约耗尽时必须排空进程树。
 */

import { mkdtemp, mkdir, readFile, writeFile, copyFile, readdir, rm, rename } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalBytes, validateSchema, type JobManifestV1, type CompletionManifestV1, type CompiledAssetBundle, type ExecutionSnapshotV1, type EvidenceFileEntryV1, type CleanupStatus } from '@veriq/contracts';
import type { CaseResult } from '@veriq/runner-sdk';
import { RuntimeError } from '../enrollment.ts';
import { leaseDeadline } from '../lease.ts';
import { AgentClient, type Claim } from '../agent/transport.ts';
import { Heartbeat } from '../agent/heartbeat.ts';
import { ProcessSupervisor, type StopReceipt, type OwnedProcess } from './processes.ts';
import { EventBuffer } from './events.ts';
import { AttemptBroker } from './broker.ts';
import { monitorStorage } from './storage.ts';
import { loadRelease, sha256 } from './release.ts';
import { developmentExecutionPaths, containedPath, type ExecutionPaths } from './paths.ts';
import { offlineWorkerEnvironment } from '../offline/worker-environment.ts';
import { privateDirectory, readPrivate, updatePrivate } from '../offline/config.ts';
/**
 * 公开接口 ClaimedAttempt 绑定一次认领结果与收发单调时刻：供 leaseDeadline 换算与 runAttempt 使用。
 */
export interface ClaimedAttempt {
    claimRequestId?: string;
    claim: Claim;
    requestStarted: number;
    responseReceived: number;
}
/**
 * 公开接口 LocalEvidence 描述本机证据文件条目：含契约 FileEntry、证据种类与本地路径：上传前不离开 Attempt 工作区。
 */
export interface LocalEvidence {
    file: EvidenceFileEntryV1;
    kind: 'TRACE' | 'DOWNLOAD' | 'LOG' | 'SOURCE' | 'MANIFEST' | 'HTML' | 'JUNIT' | 'SCREENSHOT';
    localPath: string;
}
/**
 * 公开接口 AttemptResult 汇总一次 Attempt 的完成清单、停机回执以及本机证据文件列表（AttemptResult）。
 */
export interface AttemptResult {
    completion?: CompletionManifestV1;
    stop: StopReceipt;
    files: LocalEvidence[];
}
/**
 * 公开接口 SupervisorOptions 配置监督器根目录、AgentClient、发行目录、浏览器可执行文件与存储上限。
 */
export interface SupervisorOptions {
    root: string;
    client: AgentClient;
    releaseDirectory: string;
    browserExecutable: string;
    storageLimit?: number;
    /** 独立安装入口提供已验证的角色与辅助模块物理路径，缺省只适用于现有源码开发调用；业务 Job 不可覆盖这个宿主设置，Runner 子进程继续继承自身固定 Node 的 execPath。 */
    execution?: ExecutionPaths;
}
interface AttemptJournal {
    claimRequestId?: string;
    claim: Claim;
    state: 'ALLOCATED' | 'ACTIVATING' | 'ACTIVATED' | 'SPAWNING' | 'RUNNING' | 'STOPPED';
    work: string;
}
const json = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T;
/**
 * 公开类 ExecutionSupervisor 驱动单次 Attempt 全生命周期：含激活、编译装配、进程监护、事件上报与恢复对账。
 */
export class ExecutionSupervisor {
    readonly processes: ProcessSupervisor;
    constructor(private options: SupervisorOptions) { this.processes = new ProcessSupervisor(join(options.root, 'processes'), 500, options.execution?.guardianExecutable); }
    private async journal(value: AttemptJournal) {
        const directory = join(this.options.root, 'attempts');
        /** Windows 恢复日志与设备配置共享持有父目录的原子发布，避免旧 Node rename 再次按路径解析；日志提交失败不授权业务启动，提交不确定性直接传给既有恢复与隔离流程。 */
        if (process.platform === 'win32') {
            await updatePrivate(directory, `${value.claim.attemptId}.json`, () => value);
            return;
        }
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const path = join(directory, `${value.claim.attemptId}.json`), temporary = `${path}.${randomUUID()}`;
        await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx', flush: true });
        await rename(temporary, path);
    }
    /**
     * 公开方法 terminateAttempt 委托 ProcessSupervisor 执行停机：在恢复路径上对未排空进程隔离容量。
     */
    terminateAttempt(id: string, reason: string) { return this.processes.terminateAttempt(id, reason); }
    /**
     * 公开方法 recover 扫描 attempts 日志并终止残留进程：向控制面对账后返回带 claimRequestId 的停机回执列表。
     */
    async recover(): Promise<(StopReceipt & {claimRequestId?: string})[]> {
        const directory = join(this.options.root, 'attempts');
        if (process.platform === 'win32') await privateDirectory(directory);
        else await mkdir(directory, { recursive: true, mode: 0o700 });
        const receipts: (StopReceipt & {claimRequestId?: string})[] = [];
        for (const name of await readdir(directory)) {
            if (!name.endsWith('.json'))
                continue;
            const record = process.platform === 'win32'
                ? await readPrivate<AttemptJournal>(directory, name)
                : await json<AttemptJournal>(join(directory, name));
            const stop = ['ALLOCATED', 'ACTIVATING', 'ACTIVATED'].includes(record.state)
                ? { attemptId: record.claim.attemptId, processStopped: true, reason: 'NO_PROCESS_SPAWNED', stoppedAt: new Date().toISOString() }
                : await this.terminateAttempt(record.claim.attemptId, 'AGENT_RECOVERY');
            await this.reconcile(record.claim, stop, 'PENDING');
            receipts.push({...stop, ...(record.claimRequestId ? {claimRequestId: record.claimRequestId} : {})});
        }
        return receipts;
    }
    private reconcile(claim: Claim, stop: StopReceipt, cleanupStatus: CleanupStatus) { return this.options.client.request(`/internal/v1/attempts/${claim.attemptId}/reconcile`, 'POST', { fencingToken: claim.fencingToken, processStopped: stop.processStopped, cleanupStatus, stoppedAt: stop.stoppedAt }); }
    /**
     * 公开方法 runAttempt 在租约预算内激活并执行一次 Claim：心跳、存储监控与 fencing 贯穿全程：完成后上传证据并提交 CompletionManifest。
     */
    async runAttempt(assignment: ClaimedAttempt, signal: AbortSignal): Promise<AttemptResult> {
        const { claim } = assignment;
        leaseDeadline({ ...claim, leaseExpiresAt: claim.expiresAt }, assignment.requestStarted, assignment.responseReceived);
        if (process.platform !== 'linux')
            throw new Error('UNSUPPORTED_PROCESS_PLATFORM');
        const executionPaths = this.options.execution ?? developmentExecutionPaths();
        const work = join(this.options.root, 'work', claim.attemptId);
        await mkdir(work, { recursive: true, mode: 0o700 });
        const tmp = await mkdtemp(join(tmpdir(), 'veriq-a-')); // Chromium AF_UNIX paths must fit108 bytes.
        const record: AttemptJournal = { claim, state: 'ALLOCATED', work, ...(assignment.claimRequestId ? {claimRequestId: assignment.claimRequestId} : {}) };
        await this.journal(record);
        const client = this.options.client, events = new EventBuffer(claim, client), controller = new AbortController();
        let reason: string | undefined, child: OwnedProcess | undefined, broker: AttemptBroker | undefined, monitor: ReturnType<typeof monitorStorage> | undefined;
        let stop: StopReceipt | undefined, caseResult: CaseResult | undefined, manifest: JobManifestV1 | undefined;
        const files: LocalEvidence[] = [];
        const stopRequest = (why: string) => { reason ??= why; controller.abort(); };
        const aborted = () => stopRequest('USER_CANCELLED');
        signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted)
            aborted();
        const heartbeat = new Heartbeat(client, claim, assignment.requestStarted, assignment.responseReceived, stopRequest);
        heartbeat.start();
        let flushTimer: ReturnType<typeof setInterval> | undefined;
        const content = (hash: string) => `/internal/v1/workspaces/${manifest!.workspaceId}/attempts/${claim.attemptId}/content/${hash}`;
        const write = async (path: string, bytes: Uint8Array) => { if (path.startsWith('/') || path.split('/').some(p => !p || p === '.' || p === '..') || path.includes('\\'))
            throw new Error('UNSAFE_FILE_PATH'); await mkdir(dirname(join(work, path)), { recursive: true, mode: 0o700 }); await writeFile(join(work, path), bytes, { mode: 0o600, flag: 'wx' }); };
        let total = 0;
        const download = async (hash: string) => { const bytes = await client.download(content(hash), hash, claim, controller.signal); total += bytes.length; if (total > 128 * 1024 * 1024)
            throw new Error('CLOSURE_LIMIT'); return bytes; };
        try {
            const raw = await client.download(claim.snapshotUrl, claim.snapshotSha256, claim, controller.signal);
            manifest = JSON.parse(Buffer.from(raw).toString()) as JobManifestV1;
            if (validateSchema('JobManifestV1', manifest).length || manifest.jobId !== claim.jobId || manifest.kind !== claim.jobKind)
                throw new Error('ASSIGNMENT_MISMATCH');
            const release = await loadRelease(this.options.releaseDirectory, manifest.engineVersion);
            const subject = await download(manifest.snapshotSha256);
            await write('subject.json', subject);
            let execution: ExecutionSnapshotV1 | undefined, bundle: CompiledAssetBundle | undefined;
            if (manifest.kind === 'TEST') {
                execution = JSON.parse(Buffer.from(await download(manifest.executionSnapshotSha256)).toString()) as ExecutionSnapshotV1;
                if (validateSchema('ExecutionSnapshotV1', execution).length || execution.workspaceId !== manifest.workspaceId || execution.caseExecutionId !== manifest.caseExecutionId || execution.caseVersionId !== manifest.caseVersionId)
                    throw new Error('EXECUTION_BINDING_MISMATCH');
                await write('execution.json', canonicalBytes(execution));
                const descriptor = await download(manifest.compiledBundleSha256);
                bundle = JSON.parse(Buffer.from(descriptor).toString()) as CompiledAssetBundle;
                if (validateSchema('CompiledAssetBundle', bundle).length)
                    throw new Error('INVALID_COMPILED_BUNDLE');
                await write('bundle.json', descriptor);
                for (const file of bundle.files) {
                    const bytes = await download(file.sha256);
                    if (bytes.length !== file.sizeBytes)
                        throw new Error('CONTENT_SIZE_MISMATCH');
                    await write(file.path, bytes);
                }
                for (const [path, bytes] of Object.entries(release.files)) {
                    if (path === 'engine/compiler.tgz') {
                        await write(path, bytes);
                        continue;
                    }
                    if (sha256(await readFile(join(work, path))) !== sha256(bytes))
                        throw new Error('UNAPPROVED_ENGINE_BYTES');
                }
            }
            else {
                for (const [path, bytes] of Object.entries(release.files))
                    await write(path, bytes);
                if (manifest.kind === 'VALIDATE')
                    await write('source/asset-snapshot.json', subject);
            }
            const frozen = execution ?? JSON.parse(Buffer.from(subject).toString());
            if (frozen.workspaceId !== manifest.workspaceId)
                throw new Error('WORKSPACE_MISMATCH');
            if (manifest.kind === 'CLEANUP') {
                const identity = frozen.environment?.fixtureIdentity;
                if (frozen.namespace !== manifest.namespace || frozen.fixtureVersionId !== manifest.fixtureVersionId || !identity || !frozen.caseExecutionId || ![1, 2].includes(frozen.attemptNo) || frozen.secretVersions?.length !== 1 || frozen.secretVersions[0].secretRef !== identity.secretRef || frozen.secretVersions[0].versionId !== identity.secretVersionId)
                    throw new Error('INVALID_CLEANUP_SUBJECT');
            }
            broker = new AttemptBroker(join(tmp, 'control.sock'), async (message) => {
                if (message.type === 'credential') {
                    if (controller.signal.aborted)
                        throw new Error('ATTEMPT_STOPPING');
                    const reference = message.reference as {
                        workspaceId: string;
                        secretRef: string;
                        versionId: string;
                    };
                    if (reference.workspaceId !== manifest!.workspaceId || !frozen.secretVersions?.some((s: {
                        secretRef: string;
                        versionId: string;
                    }) => s.secretRef === reference.secretRef && s.versionId === reference.versionId))
                        throw new Error('SECRET_NOT_FROZEN');
                    // Credential resolution uses proof headers, never forwards device authorization to a business origin.
                    return this.resolveCredential(claim, reference, controller.signal);
                }
                if (message.type === 'status')
                    return { cancelled: controller.signal.aborted };
                if (message.type === 'event') {
                    const event = message.event as Parameters<EventBuffer['sdk']>[0];
                    await events.sdk(event);
                    if (event.type === 'CASE_FINISHED')
                        caseResult = event.result;
                    return {};
                }
                if (message.type === 'restricted') {
                    const evidence = message.evidence as {
                        kind: 'DOWNLOAD';
                        path: string;
                        sensitivity: 'CREDENTIAL_RESTRICTED';
                    };
                    if (evidence.kind !== 'DOWNLOAD' || evidence.sensitivity !== 'CREDENTIAL_RESTRICTED' || !containedPath(tmp, resolve(evidence.path)))
                        throw new Error('UNSAFE_EVIDENCE');
                    const bytes = await readFile(evidence.path);
                    const name = `download-${files.length}.bin`;
                    await writeFile(join(work, name), bytes, { mode: 0o600, flag: 'wx' });
                    files.push({ kind: 'DOWNLOAD', localPath: join(work, name), file: { path: name, sha256: sha256(bytes), sizeBytes: bytes.length, sensitivity: 'CREDENTIAL_RESTRICTED' } });
                    return {};
                }
                throw new Error('INVALID_IPC_OPERATION');
            });
            await broker.open();
            const invocation = { kind: manifest.kind, work, tmp, socket: broker.path, nonce: broker.nonce, downloads: join(tmp, 'downloads'), downloadLimit: 16 * 1024 * 1024, npmCli: executionPaths.npmCli, tsx: executionPaths.tsx };
            await mkdir(invocation.downloads, { mode: 0o700 });
            await write('invocation.json', canonicalBytes(invocation));
            await write('release.json', canonicalBytes(release.entry));
            for (const file of ['provider.mjs', 'compile-entry.mjs'])
                await copyFile(file === 'provider.mjs' ? executionPaths.providerEntry : executionPaths.compileEntry, join(work, file));
            if (bundle && execution) {
                const entry = bundle.entrypoints.find(e => e.caseVersionId === execution!.caseVersionId);
                if (!entry)
                    throw new Error('MISSING_CASE_ENTRYPOINT');
                const config = { testDir: './cases', testMatch: entry.path.split('/').pop(), workers: 1, retries: 0, reporter: [['json', { outputFile: join(tmp, 'playwright.json') }], ['junit', { outputFile: join(tmp, 'junit.xml') }], ['html', { outputFolder: join(tmp, 'html'), open: 'never' }]], outputDir: join(tmp, 'test-results'), use: { browserName: execution.browser, locale: execution.environment.locale, timezoneId: execution.environment.timezone, serviceWorkers: 'block', trace: 'on', launchOptions: { executablePath: this.options.browserExecutable, args: ['--no-sandbox'], downloadsPath: invocation.downloads } } };
                await write('playwright.config.mjs', Buffer.from(`export default ${JSON.stringify(config)};`));
            }
            if (controller.signal.aborted)
                throw new Error('ATTEMPT_STOPPING');
            record.state = 'ACTIVATING';
            await this.journal(record);
            await client.request(`/internal/v1/attempts/${claim.attemptId}/activate`, 'POST', { leaseToken: claim.leaseToken, fencingToken: claim.fencingToken }, controller.signal);
            record.state = 'ACTIVATED';
            await this.journal(record);
            heartbeat.activated();
            if (controller.signal.aborted)
                throw new Error('ATTEMPT_STOPPING');
            events.append({ type: 'ATTEMPT_STARTED', payload: { engineVersion: manifest.engineVersion, sourceHash: manifest.kind === 'VALIDATE' ? manifest.sourceHash : execution?.assetSourceHash ?? manifest.snapshotSha256 } });
            flushTimer = setInterval(() => void events.flush().catch(() => stopRequest('EVENT_UPLOAD_FAILED')), 250);
            monitor = monitorStorage(tmp, this.options.storageLimit ?? 64 * 1024 * 1024, async (why) => { stopRequest(why); if (child)
                await this.terminateAttempt(claim.attemptId, why); });
            record.state = 'SPAWNING';
            await this.journal(record);
            child = await this.processes.start(claim.attemptId, { executable: executionPaths.runnerExecutable, args: [executionPaths.workerEntry, join(work, 'invocation.json')], cwd: work, env: offlineWorkerEnvironment(tmp, join(work, 'provider.mjs'), true, process.env, { runnerExecutable: executionPaths.runnerExecutable }) });
            record.state = 'RUNNING';
            await this.journal(record);
            if (controller.signal.aborted)
                throw new Error('ATTEMPT_STOPPING');
            child.send({ type: 'START' });
            const cancelled = new Promise<void>(resolve => { if (controller.signal.aborted)
                resolve();
            else
                controller.signal.addEventListener('abort', () => resolve(), { once: true }); });
            await Promise.race([child.exited, cancelled]);
            if (controller.signal.aborted)
                await Promise.race([child.exited, delay(Math.max(0, Math.min(30000, heartbeat.remaining() - 1000)), undefined, { ref: false })]);
            stop = await this.terminateAttempt(claim.attemptId, reason ?? 'COMPLETED');
            if (!stop.processStopped)
                throw new Error('PROCESS_STOP_UNCONFIRMED');
            record.state = 'STOPPED';
            await this.journal(record);
            monitor.close();
            const workerResult = await json<{
                kind: string;
                businessOutcome: 'PASSED' | 'ERROR';
                cleanupStatus: CleanupStatus;
                failureCode?: string;
                diagnostics?: { code: string; path: string; pathStatus: "EXACT" | "REDACTED"; message: string }[];
            }>(join(work, 'worker-result.json'));
            const cleanupStatus = manifest.kind === 'TEST' ? caseResult?.cleanupStatus ?? 'PENDING' : workerResult.cleanupStatus;
            if (manifest.kind === 'TEST' && !caseResult)
                throw new Error('MISSING_CASE_RESULT');
            if (manifest.kind !== 'TEST') {
                events.append({ type: 'CLEANUP_RESULT', payload: { cleanupStatus } });
                events.append({ type: 'ATTEMPT_FINISHED', payload: { outcome: workerResult.businessOutcome, cleanupStatus } });
            }
            const add = async (path: string, kind: LocalEvidence['kind'], name = path, sensitivity: EvidenceFileEntryV1['sensitivity'] = 'REDACTED') => { const bytes = await readFile(join(work, path)); files.push({ kind, localPath: join(work, path), file: { path: name, sha256: sha256(bytes), sizeBytes: bytes.length, sensitivity } }); };
            if (manifest.kind === 'TEST') {
                for (const [relative, name, kind] of [['junit.xml', 'junit.xml', 'JUNIT'], ['html/index.html', 'report.html', 'HTML'], ['screenshot.png', 'screenshot.png', 'SCREENSHOT']] as const) {
                    try { await copyFile(join(tmp, relative), join(work, name)); }
                    catch (error) {
                        // Cancellation may close the page before this optional capture.
                        // Missing required Trace still fails the canonical evidence check.
                        if (kind === 'SCREENSHOT' && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
                        throw error;
                    }
                    await add(name, kind, name, 'CREDENTIAL_RESTRICTED');
                }
                const traces: string[] = [];
                const visit = async (path: string): Promise<void> => { for (const entry of await readdir(path, { withFileTypes: true })) {
                    const full = join(path, entry.name);
                    if (entry.isDirectory())
                        await visit(full);
                    else if (entry.name === 'trace.zip')
                        traces.push(full);
                } };
                await visit(tmp);
                for (const path of traces) {
                    const name = `trace-${files.length}.zip`;
                    await copyFile(path, join(work, name));
                    await add(name, 'TRACE', name, 'CREDENTIAL_RESTRICTED');
                }
            }
            if (manifest.kind === 'VALIDATE') {
                const output = workerResult.businessOutcome === 'PASSED' ? await json<CompiledAssetBundle>(join(work, 'bundle.json')) : undefined;
                for (const file of output?.files ?? release.entry.files)
                    await add(file.path, 'SOURCE');
                if (output) {
                    if (!files.some(f => f.file.path === 'engine/compiler.tgz'))
                        await add('engine/compiler.tgz', 'SOURCE');
                    await add('bundle.json', 'MANIFEST');
                }
                else
                    await add('compiler.log', 'LOG');
            }
            for (const file of files) {
                const artifactId = await this.upload(claim, file);
                events.append({ type: 'ARTIFACT_CREATED', payload: { artifactId, file: file.file, kind: file.kind } });
            }
            const evidence = files.map(f => f.file), requiredEvidence = files.filter(f => ['TRACE', 'LOG'].includes(f.kind)).map(f => f.file.sha256);
            const common = { schemaVersion: '1.0' as const, attemptId: claim.attemptId, jobManifestSha256: claim.snapshotSha256, cleanupStatus, evidence, requiredEvidence, processStopped: true as const };
            let completion: CompletionManifestV1;
            if (manifest.kind === 'TEST')
                completion = { ...common, kind: 'TEST', retrySafety: caseResult!.retrySafety ?? 'UNKNOWN', businessOutcome: caseResult!.businessOutcome, caseVersionId: manifest.caseVersionId, expectedPlansSha256: sha256(await readFile(join(work, 'metadata/expected-plans.json'))) };
            else if (manifest.kind === 'CLEANUP')
                completion = { ...common, kind: 'CLEANUP', businessOutcome: workerResult.businessOutcome, fixtureVersionId: manifest.fixtureVersionId, namespace: manifest.namespace };
            else if (workerResult.businessOutcome === 'PASSED')
                completion = { ...common, kind: 'VALIDATE', businessOutcome: 'PASSED', compiledBundleSha256: sha256(await readFile(join(work, 'bundle.json'))), engineInventorySha256: release.inventoryHash };
            else
                completion = { ...common, kind: 'VALIDATE', businessOutcome: 'ERROR', engineInventorySha256: release.inventoryHash, failureCode: workerResult.failureCode ?? 'COMPILATION_FAILED', ...(workerResult.diagnostics ? { diagnostics: workerResult.diagnostics } : {}), evidence: evidence as [
                        EvidenceFileEntryV1,
                        ...EvidenceFileEntryV1[]
                    ], requiredEvidence: requiredEvidence as [
                        string,
                        ...string[]
                    ] };
            if (validateSchema('CompletionManifestV1', completion).length)
                throw new Error('INVALID_COMPLETION');
            const completionBytes = canonicalBytes(completion);
            await writeFile(join(work, 'completion.json'), completionBytes, { mode: 0o600 });
            await this.upload(claim, { kind: 'MANIFEST', localPath: join(work, 'completion.json'), file: { path: 'completion.json', sha256: sha256(completionBytes), sizeBytes: completionBytes.length, sensitivity: 'REDACTED' } });
            await events.flush();
            await client.request(`/internal/v1/attempts/${claim.attemptId}/finish`, 'POST', { leaseToken: claim.leaseToken, fencingToken: claim.fencingToken, kind: manifest.kind, outcome: manifest.kind === 'TEST' ? caseResult!.outcome : workerResult.businessOutcome, manifestSha256: sha256(completionBytes), lastSequence: events.lastSequence, cleanupStatus });
            return { completion, stop, files };
        }
        catch (error) {
            const failure = error instanceof RuntimeError ? error.code : error instanceof Error && /^[A-Z][A-Z_]{1,79}$/.test(error.message) ? error.message : "EXECUTION_ERROR";
            if (stop)
                stop.reason = failure;
            reason ??= failure;
            stop ??= child ? await this.terminateAttempt(claim.attemptId, reason ?? 'EXECUTION_ERROR') : { attemptId: claim.attemptId, processStopped: record.state !== 'SPAWNING', reason: record.state === 'SPAWNING' ? 'UNKNOWN_PROCESS' : failure, stoppedAt: new Date().toISOString() };
            await this.reconcile(claim, stop, caseResult?.cleanupStatus ?? (child ? 'PENDING' : 'NOT_REQUIRED')).catch(() => { });
            return { stop, files };
        }
        finally {
            heartbeat.close();
            clearInterval(flushTimer);
            monitor?.close();
            signal.removeEventListener('abort', aborted);
            await broker?.close();
            // Results/evidence are retained for acknowledgement/recovery. Only task-owned regenerables are removed.
            if (stop?.processStopped)
                for (const path of ['node_modules', 'tmp/npm-cache'])
                    await rm(join(work, path), { recursive: true, force: true });
            if (stop?.processStopped)
                await rm(tmp, { recursive: true, force: true });
        }
    }
    private async resolveCredential(claim: Claim, reference: {
        secretRef: string;
        versionId: string;
    }, signal: AbortSignal) {
        return this.options.client.session.withCredential(async (config) => {
            const response = await fetch(`${config.server}/internal/v1/attempts/${claim.attemptId}/credentials/resolve`, { method: 'POST', redirect: 'error', credentials: 'omit', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), headers: { Authorization: `Bearer ${config.deviceToken}`, 'Content-Type': 'application/json', 'X-VeriQ-Lease-Token': claim.leaseToken, 'X-VeriQ-Fencing-Token': String(claim.fencingToken) }, body: JSON.stringify({ secretRef: reference.secretRef, versionId: reference.versionId }) });
            if (!response.ok)
                throw new Error('CREDENTIAL_RESOLUTION_FAILED');
            const reader = response.body!.getReader();
            let size = 0;
            const chunks: Uint8Array[] = [];
            while (true) {
                const item = await reader.read();
                if (item.done)
                    break;
                size += item.value.length;
                if (size > 65536) {
                    await reader.cancel();
                    throw new Error('CREDENTIAL_RESPONSE_LIMIT');
                }
                chunks.push(item.value);
            }
            return JSON.parse(Buffer.concat(chunks).toString()).data.value;
        });
    }
    private async upload(claim: Claim, evidence: LocalEvidence): Promise<string> {
        const bytes = await readFile(evidence.localPath);
        if (bytes.length > 32 * 1024 * 1024 || sha256(bytes) !== evidence.file.sha256)
            throw new Error('EVIDENCE_CHANGED');
        const reply = await this.options.client.request<{
            artifactId: string;
            uploadUrl: string;
        }>(`/internal/v1/attempts/${claim.attemptId}/artifact-uploads`, 'POST', { leaseToken: claim.leaseToken, fencingToken: claim.fencingToken, kind: evidence.kind, filename: evidence.file.path, contentType: 'application/octet-stream', sha256: evidence.file.sha256, sizeBytes: bytes.length, sensitivity: evidence.file.sensitivity });
        for (let offset = 0; offset < Math.max(1, bytes.length); offset += 1024 * 1024)
            await this.options.client.binary(`${reply.uploadUrl}?offset=${offset}`, claim, AbortSignal.timeout(15000), bytes.subarray(offset, offset + 1024 * 1024));
        return reply.artifactId;
    }
}
