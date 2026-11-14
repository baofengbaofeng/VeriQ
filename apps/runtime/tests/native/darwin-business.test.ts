/** 此入口只在真实 macOS15 原生宿主运行完整业务，复用现有真实 SDK/compiler/npm 离线闭包与 Playwright CLI；所有扫描在私有配置之外执行，诊断只输出计数，任何真实端点命中都会令当前交付门禁失败并保留窄范围泄漏结论。 */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, realpath, rm, readFile, readdir, mkdir, writeFile, chmod, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename, relative } from "node:path";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { chromium, type BrowserServer } from "playwright-core";
import { fromBuffer, type ZipFile } from "yauzl";
import { fixture, buildBusinessEngine, onlineBusiness, watchBusinessRun, emitBusinessDiagnostic, businessArtifactRole, observeBusinessExit } from "../fixtures/business-engine.ts";
import { createDarwinSource } from "../../src/execution/darwin-source.ts";
import { ProcessSupervisor, type OwnedProcess } from "../../src/execution/processes.ts";
import { runOffline, recoverOffline } from "../../src/offline/run.ts";
import { verifyBundle } from "../../src/offline/verify.ts";
import { SecretStore } from "../../src/credentials/store.ts";
import { LocalReports } from "../../src/offline/reports.ts";
import { LocalStore } from "../../src/offline/store.ts";
import { uploadOffline } from "../../src/offline/upload.ts";
import { darwinNative, type DarwinPrivateDirectory } from "../../src/native/darwin.ts";
import { privateDirectory, readPrivate, updatePrivate, readBoundedFile } from "../../src/offline/config.ts";
import { AttemptBroker, createDarwinBrokerDirectory } from "../../src/execution/broker.ts";
import { id } from "../../../../packages/compiler/tests/helpers.ts";

assert.equal(process.platform, "darwin", "Actual macOS is required; all-skip Linux is not business evidence");
let root: string;
let activeBusinessFixtures = 0, retainBusinessRoot = false;
let engine: Awaited<ReturnType<typeof buildBusinessEngine>>;
before(async () => {
    root = await mkdtemp(join(await realpath(tmpdir()), "veriq-c2b2-"));
    engine = await buildBusinessEngine(root);
}, { timeout: 180000 });
after(async () => {
    if (activeBusinessFixtures || retainBusinessRoot) console.log(JSON.stringify({ businessRootCleanup: { retained: true, activeFixtures: activeBusinessFixtures, cleanupUnconfirmed: retainBusinessRoot } }));
    else await rm(root, { recursive: true, force: true });
});

/** 私有控制成员与第三方异常只在夹具内转换为固定阶段，TAP 不得借 JSON 语法片段、错误 cause 或动态 message 输出端点和控制 nonce；真正的原始对象与结果仍由测试保留，诊断只输出受限枚举与布尔分类。 */
function privateJson(bytes: string | Buffer): any {
    try { return JSON.parse(bytes.toString()); }
    catch { throw new Error("PRIVATE_TEST_JSON_INVALID"); }
}
function reportNativeFailure(phase: "OFFLINE_RUN" | "BROWSER_LAUNCH" | "FIXTURE_CLEANUP", error: unknown): void {
    const value = error instanceof Error ? error.message : "";
    const codes = new Set(["LOCAL_OWNERSHIP_LOST", "LOCAL_CAPACITY_HELD", "DARWIN_CONTROLLED_START_FAILED", "DARWIN_ATTEMPT_STOPPING", "PROCESS_STOP_UNCONFIRMED", "COMMIT_UNCONFIRMED", "UNSAFE_CONFIGURATION", "UNSAFE_DESTINATION", "BUNDLE_DESTINATION_EXISTS", "INVALID_OFFLINE_RESULT"]);
    console.log(JSON.stringify({ nativeFailure: { phase, error: true, code: codes.has(value) ? value : "OTHER", moduleMissing: /ERR_MODULE_NOT_FOUND|Cannot find module/.test(value), connectionError: /browserType\.connect|ECONNREFUSED|WebSocket/.test(value) } }));
}

/** 夹具收尾只等待原对象的实际操作，并共用首次收尾得到的现有 source 上限绝对期限；到期或拒绝只产生未确认失败，不猜测 PID、不调用 test-force-exit，也不会把随后由夹具终止得到的事实写回产品停止回执。 */
async function fixtureBefore<T>(operation: Promise<T>, deadline: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const result = await Promise.race([
            operation.then((value) => ({ ok: true as const, value }), () => ({ ok: false as const })),
            new Promise<{ ok: false }>((resolve) => { timer = setTimeout(() => resolve({ ok: false }), Math.max(0, deadline - performance.now())); }),
        ]);
        if (!result.ok) throw new Error("OWNED_FIXTURE_CLEANUP_UNCONFIRMED");
        return result.value;
    } finally { clearTimeout(timer); }
}

/** Playwright 的真实错误正文只在测试内存分类，投影有限错误数量和预先固定的连接、模块、类型与断言特征；既不复制错误消息、源码片段和堆栈，也不由某个分类直接推断 SDK 根因或受控停止成功，实际修复仍须协调者按新证据裁定。 */
async function reportPlaywrightFacts(path: string): Promise<void> {
    const facts = { readable: false, errorStrings: 0, connection: false, moduleMissing: false, typeError: false, referenceError: false, syntaxError: false, assertion: false };
    try {
        const value = privateJson(await readBoundedFile(path, 2 * 1024 * 1024));
        let visited = 0;
        const visit = (item: unknown, field: string, depth: number): void => {
            if (++visited > 10000 || depth > 24) return;
            if (typeof item === "string" && ["message", "stack", "error"].includes(field)) {
                facts.errorStrings++;
                facts.connection ||= /browserType\.connect|ECONNREFUSED|WebSocket/.test(item);
                facts.moduleMissing ||= /ERR_MODULE_NOT_FOUND|Cannot find module/.test(item);
                facts.typeError ||= /TypeError/.test(item);
                facts.referenceError ||= /ReferenceError/.test(item);
                facts.syntaxError ||= /SyntaxError|Unexpected token|does not provide an export/.test(item);
                facts.assertion ||= /AssertionError|expect\(|Expected:|Received:/.test(item);
            } else if (item && typeof item === "object") for (const [key, child] of Object.entries(item)) visit(child, key, depth + 1);
        };
        visit(value, "root", 0);
        facts.readable = true;
    } catch { }
    console.log(JSON.stringify({ playwrightDiagnostic: facts }));
}

/** ZIP 解析只复用已有 yauzl，以输入、条目数量、单项及总解压字节四重限额读取真实归档；条目名字同样受扫描，嵌套只允许 HTML 选定数据与 Trace 两层，不把压缩原字节未命中当成已检查正文。 */
async function scanArchive(bytes: Buffer, check: (bytes: Buffer) => void): Promise<number> {
    assert.ok(bytes.length <= 32 * 1024 * 1024, "Archive input limit");
    const zip = await new Promise<ZipFile>((resolve, reject) => fromBuffer(bytes, { lazyEntries: true }, (error, value) => error ? reject(new Error("ARTIFACT_ZIP_OPEN_FAILED")) : resolve(value!)));
    let entries = 0, total = 0;
    try {
        await new Promise<void>((resolve, reject) => {
            zip.on("error", reject);
            zip.on("end", resolve);
            zip.on("entry", (entry) => {
                try {
                    assert.ok(++entries <= 4096 && entry.uncompressedSize <= 16 * 1024 * 1024 && (total += entry.uncompressedSize) <= 64 * 1024 * 1024, "Archive expansion limit");
                    check(Buffer.from(entry.fileName));
                    zip.openReadStream(entry, (error, stream) => {
                        if (error) { reject(error); return; }
                        const chunks: Buffer[] = [];
                        let size = 0;
                        stream!.on("error", reject);
                        stream!.on("data", (chunk: Buffer) => {
                            size += chunk.length;
                            if (size > entry.uncompressedSize) { stream!.destroy(new Error("ARCHIVE_ENTRY_LIMIT")); return; }
                            chunks.push(chunk);
                        });
                        stream!.on("end", () => {
                            try { check(Buffer.concat(chunks)); zip.readEntry(); } catch (error) { reject(error); }
                        });
                    });
                } catch (error) { reject(error); }
            });
            zip.readEntry();
        });
    } catch { throw new Error("ARTIFACT_ZIP_DECODE_FAILED"); }
    finally { zip.close(); }
    return entries;
}

/** 观察器只保留测试内存中的完整端点和随机路径，检查 URL/JSON/百分号/base64 编码；产品私有 invocation/PW config 不属于上传容器，报告 JSON、JUnit、HTML 内嵌 ZIP 与 Trace 解压正文则必须逐项经过真实读取。 */
async function observeBusiness(label: "ONLINE_ASSERT_FAIL_PASS" | "ONLINE_CONNECT_FAIL" | "OFFLINE_PASS" | "OFFLINE_ASSERT_FAIL" | "OFFLINE_CONNECT_FAIL", run: (inspect: (bytes: Buffer, name: string) => Promise<void>, assertClean: () => void) => Promise<void>, connectFailure = false, expectedHeadless?: boolean) {
    activeBusinessFixtures++;
    const endpoints: string[] = [], servers: BrowserServer[] = [];
    const launchServer = chromium.launchServer.bind(chromium);
    const start = ProcessSupervisor.prototype.start;
    let buffers = 0, archives = 0, members = 0, hits = 0, json = 0, html = 0, junit = 0, traces = 0;
    let runReturned = false, scanComplete = false;
    const owned: OwnedProcess[] = [];
    const observations: { exited: Promise<unknown>; assertClean(): void }[] = [];
    const assertClean = () => { if (hits > 0) throw new Error("PRIVATE_ENDPOINT_DISCLOSURE"); for (const observation of observations) observation.assertClean(); };
    let currentContainer = "raw";
    const containers: Record<string, number> = {}, fields: Record<string, number> = {};
    const check = (bytes: Buffer) => {
        buffers++;
        for (const endpoint of endpoints) {
            const token = new URL(endpoint).pathname.slice(1);
            for (const value of [endpoint, token]) {
                const forms = new Set([value, encodeURIComponent(value), encodeURI(value), JSON.stringify(value).slice(1, -1), Buffer.from(value).toString("base64"), Buffer.from(value).toString("base64url")]);
                if ([...forms].some((form) => form.length > 0 && bytes.includes(Buffer.from(form)))) {
                    hits++;
                    containers[currentContainer] = (containers[currentContainer] ?? 0) + 1;
                    let visited = 0;
                    const identify = (value: unknown, field: string, depth: number): void => {
                        if (++visited > 10000 || depth > 24) return;
                        if (typeof value === "string" && [...forms].some((form) => form.length > 0 && value.includes(form))) fields[field] = (fields[field] ?? 0) + 1;
                        else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) identify(child, /^(?:message|stack|error|errors|stdout|stderr|source|url|wsEndpoint|text)$/.test(key) ? key : field, depth + 1);
                    };
                    for (const line of bytes.toString().split("\n").slice(0, 10000)) {
                        try { identify(JSON.parse(line), "other", 0); } catch { }
                    }
                }
            }
        }
    };
    const inspect = async (bytes: Buffer, name: string) => {
        const role = businessArtifactRole(name);
        currentContainer = role === "TRACE" ? "trace.zip" : role === "MAIN_HTML" ? "report.html" : role === "JUNIT" ? "junit.xml" : role === "JSON" ? "playwright.json" : name.includes("events-completion") ? "events-completion" : name.includes("offline-result") ? "offline-result-report" : "referenced-data";
        check(bytes);
        if (role === "JSON") json++;
        if (role === "JUNIT") junit++;
        if (role === "MAIN_HTML") {
            html++;
            const embedded = bytes.toString().match(/(?:data:application\/zip;base64,)([A-Za-z0-9+/=]+)/);
            assert.ok(embedded, "HTML must contain the actual embedded report ZIP");
            archives++;
            currentContainer = "report.html:decoded-zip";
            members += await scanArchive(Buffer.from(embedded[1]!, "base64"), check);
        }
        if (role === "TRACE") { archives++; traces++; currentContainer = "trace.zip:decoded"; members += await scanArchive(bytes, check); }
        if (hits > 0) throw new Error("PRIVATE_ENDPOINT_DISCLOSURE");
    };
    chromium.launchServer = async (options) => {
        assert.equal(options?.executablePath, chromium.executablePath());
        assert.equal(options?.chromiumSandbox, true);
        if (expectedHeadless !== undefined) assert.equal(options?.headless, expectedHeadless);
        let server: BrowserServer;
        try { server = await launchServer(options); }
        catch (error) { reportNativeFailure("BROWSER_LAUNCH", error); throw new Error("NATIVE_BROWSER_LAUNCH_FAILED"); }
        servers.push(server);
        const endpoint = server.wsEndpoint();
        endpoints.push(endpoint);
        if (connectFailure) {
            const broken = new URL(endpoint);
            broken.port = "1";
            endpoints.push(broken.href);
            server.wsEndpoint = () => broken.href;
        }
        return server;
    };
    ProcessSupervisor.prototype.start = async function (...args: Parameters<typeof start>) {
        const child = await start.apply(this, args);
        owned.push(child);
        const invocation = privateJson(await readFile(join(args[1].cwd, "invocation.json"), "utf8"));
        const observation = observeBusinessExit(child.exited, async () => {
            const value = await child.exited;
            console.log(JSON.stringify({ nativeWorkerExit: { code: value.code, signal: [null, "SIGINT", "SIGTERM", "SIGKILL"].includes(value.signal) ? value.signal : "OTHER" } }));
            await emitBusinessDiagnostic("WORKER_EXIT", args[1].cwd, undefined);
            await reportPlaywrightFacts(join(invocation.tmp, "playwright.json"));
            const visit = async (directory: string): Promise<void> => {
                for (const item of await readdir(directory, { withFileTypes: true })) {
                    const path = join(directory, item.name);
                    if (item.isDirectory() && item.name !== "npm-cache") await visit(path);
                    else if (item.isFile()) await inspect(await readBoundedFile(path, 32 * 1024 * 1024), relative(invocation.tmp, path));
                }
            };
            await visit(invocation.tmp);
        });
        observations.push(observation);
        return { ...child, exited: observation.exited };
    };
    try {
        await run(inspect, assertClean);
        runReturned = true;
        await Promise.all(observations.map((observation) => observation.exited));
        assertClean();
        assert.ok(endpoints.length > 0 && json > 0 && html > 0 && junit > 0, "Actual reports and endpoint observations are required");
        assert.ok(traces > 0, "Actual Trace archives are required");
        scanComplete = true;
        assert.equal(hits, 0, "PRIVATE_ENDPOINT_DISCLOSURE: affected delivery must pause; diagnostics contain counts only");
    } finally {
        console.log(JSON.stringify({ endpointScan: { label, coverage: buffers === 0 ? "unreached" : scanComplete ? "complete" : "partial", runReturned, buffers, archives, members, hits, containers, fields, json, html, junit, traces, stdio: { policy: "IGNORED", stdoutBytes: 0, stderrBytes: 0 } } }));
        const deadline = performance.now() + 30000;
        try {
            for (const process of owned) {
                if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill("SIGKILL");
                await fixtureBefore(process.exited, deadline);
            }
            for (const server of servers) {
                const child = server.process();
                if (child.exitCode === null && child.signalCode === null) {
                    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
                    await fixtureBefore(server.kill(), deadline);
                    await fixtureBefore(exited, deadline);
                }
            }
            await fixtureBefore(Promise.allSettled(observations.map((observation) => observation.exited)), deadline);
        } catch (error) { retainBusinessRoot = true; reportNativeFailure("FIXTURE_CLEANUP", error); throw new Error("OWNED_FIXTURE_CLEANUP_UNCONFIRMED"); }
        finally {
            ProcessSupervisor.prototype.start = start;
            chromium.launchServer = launchServer;
            activeBusinessFixtures--;
            if (hits > 0) throw new Error("PRIVATE_ENDPOINT_DISCLOSURE");
        }
    }
}

/** 线上业务复用原 physical 的真实失败与第二次成功，并在清理前扫描实际上传和报告容器；HTTP 夹具只确认传输封套，容量、fence 服务事务和真实 MySQL 结论仍由独立 Linux 服务门禁证明。 */
test("online actual SDK assertion FAIL/PASS preserves CONTROLLED proof and scans decoded artifacts", { timeout: 240000 }, async () => {
    const source = await createDarwinSource({ temporaryDirectory: root });
    await observeBusiness("ONLINE_ASSERT_FAIL_PASS", async (inspect, assertClean) => onlineBusiness({ beforeDelivery: assertClean, darwinSource: source, browserExecutable: chromium.executablePath(), inspect: async ({ result, uploads, events }) => {
        for (const upload of uploads.values()) await inspect(upload.bytes, upload.filename);
        await inspect(Buffer.from(JSON.stringify({ completion: result.completion, events })), "events-completion.json");
    } }));
});

test("online actual CLI connection FAIL scans errors and decoded reports without exposing endpoint", { timeout: 180000 }, async () => {
    const source = await createDarwinSource({ temporaryDirectory: root });
    await observeBusiness("ONLINE_CONNECT_FAIL", async (inspect, assertClean) => onlineBusiness({ beforeDelivery: assertClean, darwinSource: source, connectFailure: true, inspect: async ({ result, uploads, events }) => {
        for (const upload of uploads.values()) await inspect(upload.bytes, upload.filename);
        await inspect(Buffer.from(JSON.stringify({ completion: result.completion, events })), "events-completion.json");
    } }), true);
});

/** 离线执行只访问测试业务 HTTP 页面而没有控制平台客户端，正常与断言失败均走真正冻结 npm 闭包和 CLI；重新打开 SQLite 报告与恢复入口保留同代受控范围，不把普通业务失败解释为进程生命周期失败。 */
async function offlineReportScenario(failing: boolean, connectFailure = false) {
    const server = createServer((request, response) => {
        response.setHeader("Content-Type", request.url === "/me" ? "application/json" : "text/html");
        response.end(request.url === "/me" ? JSON.stringify({ id: "reader" }) : '<div data-testid="name">Ready</div>');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const f = await fixture(engine.distribution, origin, failing ? origin + "/wrong" : origin + "/");
    try {
        const bundle = await verifyBundle(await f.archive(), { trust: f.trust, destination: join(f.dir, "installed") });
        const secrets = new SecretStore(join(f.dir, "secrets"));
        await secrets.set({ issuerId: f.issuer.issuerId, workspaceId: id(99), secretRef: "reader", versionId: id(14) }, { token: "local-test-only" });
        const local = join(f.dir, "local"), source = await createDarwinSource({ temporaryDirectory: root });
        await observeBusiness(connectFailure ? "OFFLINE_CONNECT_FAIL" : failing ? "OFFLINE_ASSERT_FAIL" : "OFFLINE_PASS", async (inspect, assertClean) => {
            const result = await diagnosedOfflineRun(bundle, { trust: f.trust, root: local, secrets, releaseDirectory: engine.release, browserExecutable: chromium.executablePath(), darwinSource: source, deviceId: id(90), headless: false });
            assertClean();
            assert.equal(result.outcome, connectFailure ? "ERROR" : failing ? "FAILED" : "PASSED");
            assert.equal(result.attempts[0]!.processStopScope, "CONTROLLED_WORKER_BROWSER");
            assert.equal(result.attempts[0]!.processStopped, true);
            const reports = new LocalReports(local, () => true), snapshot = await reports.snapshot(result.workspaceId, result.localRunId);
            assert.equal(snapshot.reports[0]!.cases[0]!.attempts[0]!.facts.processStopScope, "CONTROLLED_WORKER_BROWSER");
            assert.equal(snapshot.reports[0]!.gateNow.passed, false);
            for (const artifact of result.attempts[0]!.artifacts) await inspect(await reports.readRaw(result.workspaceId, result.localRunId, result.attempts[0]!.attemptId, artifact.artifactId!), artifact.path);
            await inspect(Buffer.from(JSON.stringify({ result, snapshot })), "offline-result-report.json");

            const received = new Map<string, Buffer>(), metadata = new Map<string, { sizeBytes: number; sha256: string; path: string }>();
            let imports = 0, observedScope = 0, uploadFailed = false;
            const transport = createServer(async (request, response) => {
                try {
                    const chunks: Buffer[] = [];
                    for await (const chunk of request) chunks.push(chunk);
                    const bytes = Buffer.concat(chunks), path = request.url!.split("?")[0]!;
                    const reply = (data: unknown) => { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ data })); };
                    assert.equal(request.headers["idempotency-key"], "offline_" + result.localRunId);
                    if (path.endsWith("/result-import-uploads")) {
                        const key = randomUUID();
                        received.set(key, Buffer.alloc(0));
                        metadata.set(key, JSON.parse(bytes.toString()).file);
                        reply({ id: key, uploadUrl: `/internal/v1/workspaces/${result.workspaceId}/result-import-uploads/${key}` });
                    } else if (path.includes("/result-import-uploads/")) {
                        const key = path.split("/").pop()!;
                        const combined = Buffer.concat([received.get(key)!, bytes]);
                        received.set(key, combined);
                        reply({ receivedBytes: combined.length, complete: combined.length === metadata.get(key)!.sizeBytes });
                    } else if (path.endsWith("/result-imports")) {
                        for (const [key, content] of received) {
                            assert.equal(content.length, metadata.get(key)!.sizeBytes);
                            assert.equal(createHash("sha256").update(content).digest("hex"), metadata.get(key)!.sha256);
                        }
                        const imported = JSON.parse(bytes.toString());
                        observedScope += imported.attempts.filter((attempt: { processStopScope: string }) => attempt.processStopScope === "CONTROLLED_WORKER_BROWSER").length;
                        await inspect(bytes, "offline-result-report.json");
                        imports++;
                        reply({ id: id(88), runId: id(89), localRunId: result.localRunId, source: "OFFLINE_IMPORT", officialGatePassed: false, duplicate: imports > 1 });
                    } else throw new Error("UNEXPECTED_IMPORT_PATH");
                } catch { uploadFailed = true; response.statusCode = 500; response.end(); }
            });
            await new Promise<void>((resolve) => transport.listen(0, "127.0.0.1", resolve));
            try {
                assertClean();
                const configuration = { server: `http://127.0.0.1:${(transport.address() as { port: number }).port}`, workspaceId: result.workspaceId, deviceToken: "synthetic-import-device" };
                const first = await uploadOffline(local, result.localRunId, configuration);
                const repeated = await uploadOffline(local, result.localRunId, configuration);
                assert.equal(first.runId, repeated.runId);
                assert.equal(imports, 2);
                assert.equal(observedScope, 2);
                assert.equal(uploadFailed, false);
                assert.ok(received.size >= result.attempts[0]!.artifacts.length);
                for (const [key, bytes] of received) await inspect(bytes, metadata.get(key)!.path);
            } finally { transport.closeAllConnections(); await new Promise<void>((resolve) => transport.close(() => resolve())); }

            assert.equal(await recoverOffline(local), undefined);
            const store = await LocalStore.open(local);
            try { assert.equal(store.active(), undefined); assert.equal(store.result(result.workspaceId, result.localRunId).attempts[0]!.processStopScope, "CONTROLLED_WORKER_BROWSER"); } finally { store.close(); }
        }, connectFailure, false);
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await f.close(); }
}
for (const failing of [false, true]) test(`offline actual frozen engine ${failing ? "assertion FAIL" : "PASS"} reopens scoped report without platform`, { timeout: 180000 }, async () => offlineReportScenario(failing));
test("offline actual CLI connection FAIL scans errors and decoded reports without exposing endpoint", { timeout: 180000 }, async () => offlineReportScenario(false, true));

/** 私有配置真实读取与发布使用 B 能力，宽权限、ALLOW ACL 和超过调用者限额都拒绝；这里不修复对象权限，提交失败保留不确定性，公开大包读取也不会因此扩大原生两兆硬上限。 */
test("Darwin private config rejects insecure mode and ALLOW ACL without repair", async () => {
    const directory = join(root, "private-config");
    await privateDirectory(directory);
    await updatePrivate(directory, "config.json", () => ({ value: "private" }));
    assert.deepEqual(await readPrivate(directory, "config.json"), { value: "private" });
    await chmod(directory, 0o755);
    await assert.rejects(privateDirectory(directory));
    assert.equal((await lstat(directory)).mode & 0o777, 0o755);
    await chmod(directory, 0o700);
    execFileSync("chmod", ["+a", "everyone allow read,search", directory]);
    try { await assert.rejects(readPrivate(directory, "config.json")); } finally { execFileSync("chmod", ["-N", directory]); }
});

/** Broker 只使用可信短临时根的独占目录，构造器按实际 UTF8 字节拒绝 sockaddr_un 溢出；业务根再长也不会被静默 realpath，真实传输仍验证 nonce、EOF 以及关闭后只退休当前拥有的套接字和标记目录。 */
test("Darwin broker validates UTF8 boundary and transports through an owned short B directory", async () => {
    assert.doesNotThrow(() => new AttemptBroker("x".repeat(103), async () => null));
    assert.throws(() => new AttemptBroker("x".repeat(104), async () => null), /IPC_PATH_INVALID/);
    assert.doesNotThrow(() => new AttemptBroker("中".repeat(34), async () => null));
    assert.throws(() => new AttemptBroker("中".repeat(35), async () => null), /IPC_PATH_INVALID/);
    assert.throws(() => new AttemptBroker("bad\0path", async () => null), /IPC_PATH_INVALID/);
    const owned = await createDarwinBrokerDirectory();
    const broker = new AttemptBroker(join(owned.path, "control.sock"), async () => ({ received: true }));
    try {
        await broker.open();
        const reply = await new Promise<string>((resolve, reject) => {
            const socket = createConnection(broker.path);
            let bytes = "";
            socket.on("connect", () => socket.end(JSON.stringify({ nonce: broker.nonce }) + "\n"));
            socket.on("error", reject);
            socket.on("data", (chunk) => { bytes += chunk; });
            socket.on("end", () => resolve(bytes));
        });
        assert.equal(JSON.parse(reply).value.received, true);
        assert.equal((await lstat(broker.path)).mode & 0o777, 0o600);
    } finally { await broker.close(); await owned.close(); }
    await assert.rejects(lstat(owned.path), { code: "ENOENT" });
    const denied = await createDarwinBrokerDirectory(), deniedBroker = new AttemptBroker(join(denied.path, "control.sock"), async () => null);
    execFileSync("chmod", ["+a", "everyone allow read,search", denied.path]);
    try {
        await assert.rejects(deniedBroker.open());
        await assert.rejects(lstat(deniedBroker.path), { code: "ENOENT" });
    } finally {
        execFileSync("chmod", ["-N", denied.path]);
        await deniedBroker.close();
        await denied.close();
    }
});

/** 本夹具在真实离线包周围提供实际业务服务器、可取消请求与原 BrowserServer 句柄，异常后只终止本次真正创建的 Chrome 并等原对象退出；不以 PID 查询补证明，也不把启动取消或提交不确定性假称没有派生。 */
async function offlineScenario(run: (value: { local: string; config: Parameters<typeof runOffline>[1]; bundle: Awaited<ReturnType<typeof verifyBundle>>; controller: AbortController; page: Promise<void>; abort(): void; cleanupDeadline(): number }) => Promise<void>, timeoutMs = 30000, testSignal?: AbortSignal) {
    activeBusinessFixtures++;
    let page!: () => void;
    const observed = new Promise<void>((resolve) => { page = resolve; });
    const server = createServer((request, response) => {
        if (request.url === "/me") { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ id: "reader" })); }
        else page();
    });
    let origin = "";
    const controller = new AbortController(), servers: { server: BrowserServer; exited: Promise<void> }[] = [], owned: OwnedProcess[] = [];
    const launch = chromium.launchServer.bind(chromium), start = ProcessSupervisor.prototype.start;
    let deadline: number | undefined;
    const cleanupDeadline = () => deadline ??= performance.now() + timeoutMs;
    const abort = () => { cleanupDeadline(); controller.abort(); };
    testSignal?.addEventListener("abort", abort, { once: true });
    if (testSignal?.aborted) abort();
    let f: Awaited<ReturnType<typeof fixture>> | undefined;
    chromium.launchServer = async (options) => {
        let server: BrowserServer;
        try { server = await launch(options); }
        catch (error) { reportNativeFailure("BROWSER_LAUNCH", error); throw new Error("NATIVE_BROWSER_LAUNCH_FAILED"); }
        const child = server.process();
        const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>((resolve) => child.once("exit", () => resolve()));
        servers.push({ server, exited });
        return server;
    };
    ProcessSupervisor.prototype.start = async function (...args) {
        const child = await start.apply(this, args);
        owned.push(child);
        return child;
    };
    try {
        if (testSignal?.aborted) throw new Error("BUSINESS_TEST_CANCELLED");
        await new Promise<void>((resolve, reject) => {
            server.once("error", () => reject(new Error("NATIVE_HTTP_FIXTURE_START_FAILED")));
            server.listen(0, "127.0.0.1", resolve);
        });
        origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        f = await fixture(engine.distribution, origin);
        const local = join(f.dir, "local");
        const bundle = await verifyBundle(await f.archive(), { trust: f.trust, destination: join(f.dir, "installed") });
        const secrets = new SecretStore(join(f.dir, "secrets"));
        await secrets.set({ issuerId: f.issuer.issuerId, workspaceId: id(99), secretRef: "reader", versionId: id(14) }, { token: "local-test-only" });
        const source = await createDarwinSource({ temporaryDirectory: root, stopTimeoutMs: timeoutMs });
        await run({ local, config: { root: local, trust: f.trust, secrets, releaseDirectory: engine.release, browserExecutable: chromium.executablePath(), darwinSource: source, deviceId: id(90), signal: controller.signal }, bundle, controller, page: observed, abort, cleanupDeadline });
    } finally {
        abort();
        let cleanupConfirmed = true;
        try {
            for (const child of owned) {
                try {
                    if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill("SIGKILL");
                    await fixtureBefore(child.exited, cleanupDeadline());
                } catch { cleanupConfirmed = false; }
            }
            for (const { server, exited } of servers) {
                try {
                    const child = server.process();
                    if (child.exitCode === null && child.signalCode === null) await fixtureBefore(server.kill(), cleanupDeadline());
                    await fixtureBefore(exited, cleanupDeadline());
                } catch { cleanupConfirmed = false; }
            }
        } finally {
            chromium.launchServer = launch;
            ProcessSupervisor.prototype.start = start;
            testSignal?.removeEventListener("abort", abort);
            server.closeAllConnections();
            try { if (server.listening) await fixtureBefore(new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())), cleanupDeadline()); }
            catch { cleanupConfirmed = false; }
            activeBusinessFixtures--;
            let directoryRetired = false;
            try {
                if (!cleanupConfirmed) { retainBusinessRoot = true; throw new Error("OWNED_FIXTURE_CLEANUP_UNCONFIRMED"); }
                try { await f?.close(); directoryRetired = true; }
                catch { retainBusinessRoot = true; throw new Error("OWNED_FIXTURE_DIRECTORY_UNCONFIRMED"); }
            } finally { console.log(JSON.stringify({ nativeFixtureCleanup: { ownedObjectsOnly: true, workers: owned.length, browsers: servers.length, ownedObjectsConfirmed: cleanupConfirmed, directoryRetired } })); }
        }
    }
}

/** 离线操作一创建就附加拒绝处理，结果的有界阶段投影在目录清理前完成；异常只输出固定代码和类型分类，不能把内部错误 cause 或私有控制配置交给 TAP，同时原始业务枚举与停止断言保持不变。 */
function diagnosedOfflineRun(bundle: Parameters<typeof runOffline>[0], config: Parameters<typeof runOffline>[1]) {
    return runOffline(bundle, config).then(async (result) => {
        const work = join(config.root, "work", result.attempts[0]?.attemptId ?? "unreached");
        await emitBusinessDiagnostic("OFFLINE", work, result);
        return result;
    }, (error: unknown) => {
        reportNativeFailure("OFFLINE_RUN", error);
        throw new Error("NATIVE_OFFLINE_RUN_FAILED");
    });
}

/** 取消在真实页面请求已到达后发生，CLI 必须按同代授权退出并完成观察封存，在线与离线的终结调用数均保持一次；这里不把取消 ACK 或 BrowserServer.close 返回单独作为停止结论。 */
test("offline real running CLI cancellation immediately uses one stop operation and actual CONTROLLED proof", { timeout: 180000 }, async () => offlineScenario(async ({ local, config, bundle, controller, page }) => {
    const terminate = ProcessSupervisor.prototype.terminateAttempt;
    let calls = 0;
    ProcessSupervisor.prototype.terminateAttempt = function (...args) { calls++; return terminate.apply(this, args); };
    try {
        const running = diagnosedOfflineRun(bundle, config);
        await page;
        const at = performance.now();
        controller.abort();
        assert.equal(calls, 1, "Cancellation must initiate stop synchronously");
        const result = await running;
        assert.equal(result.outcome, "CANCELLED");
        assert.equal(result.attempts[0]!.processStopped, true);
        assert.equal(result.attempts[0]!.processStopScope, "CONTROLLED_WORKER_BROWSER");
        assert.equal(calls, 1);
        assert.ok(performance.now() - at < 30000);
        const proof = privateJson(await readFile(join(local, "processes", `${result.attempts[0]!.attemptId}.controlled.json`), "utf8"));
        assert.equal(proof.outer.code, 130);
        assert.equal(proof.scope, "CONTROLLED_WORKER_BROWSER");
        const store = await LocalStore.open(local);
        try { assert.equal(store.active(), undefined); } finally { store.close(); }
    } finally { ProcessSupervisor.prototype.terminateAttempt = terminate; }
}));

test("online actual page cancellation immediately supplies lease-clamped monotonic deadline once", { timeout: 180000 }, async () => {
    const source = await createDarwinSource({ temporaryDirectory: root }), controller = new AbortController();
    const terminate = ProcessSupervisor.prototype.terminateAttempt;
    const deadlines: number[] = [];
    ProcessSupervisor.prototype.terminateAttempt = function (attemptId, reason, deadline) {
        assert.ok(typeof deadline === "number" && Number.isFinite(deadline), "Online Darwin cancellation requires an absolute finite deadline");
        assert.ok(deadline <= performance.now() + 59000 && deadline > performance.now(), "Deadline must clamp the remaining 60s lease minus 1s");
        deadlines.push(deadline);
        return terminate.call(this, attemptId, reason, deadline);
    };
    try {
        await onlineBusiness({ darwinSource: source, signal: controller.signal, expectCancelled: true, onPage: () => {
            controller.abort();
            assert.equal(deadlines.length, 1, "Online abort must initiate stop before any prewait");
        } });
        assert.equal(deadlines.length, 1);
    } finally { ProcessSupervisor.prototype.terminateAttempt = terminate; }
});

/** 启动中的取消发生在真实 start 已同步登记且尚未返回 child 的窗口，后台准入必须立即关闭；后续 start 拒绝与 finally 复用首次停止，SQLite 保留隔离，不允许重贴恢复代际或把空 child 当成未派生。 */
test("offline cancel while awaiting actual start closes admission without late business START", { timeout: 180000 }, async () => offlineScenario(async ({ config, bundle, controller, local }) => {
    const start = ProcessSupervisor.prototype.start, terminate = ProcessSupervisor.prototype.terminateAttempt;
    let stops = 0, starts = 0;
    ProcessSupervisor.prototype.start = function (...args) {
        starts++;
        const pending = start.apply(this, args);
        controller.abort();
        assert.equal(stops, 1, "Start admission must close before awaiting the child");
        return pending;
    };
    ProcessSupervisor.prototype.terminateAttempt = function (...args) { stops++; return terminate.apply(this, args); };
    try {
        const result = await diagnosedOfflineRun(bundle, config);
        assert.equal(result.outcome, "CANCELLED");
        assert.equal(starts, 1);
        assert.equal(stops, 1);
        assert.equal(result.attempts[0]!.processStopped, false);
        assert.equal(result.attempts[0]!.processStopScope, undefined);
        const store = await LocalStore.open(local);
        try { assert.equal(store.active()?.state, "QUARANTINED"); } finally { store.close(); }
    } finally { ProcessSupervisor.prototype.start = start; ProcessSupervisor.prototype.terminateAttempt = terminate; }
}));

/** 过期和非有限截止在真实 worker 已登记但尚未 START 时触发，终结 promise 必须粘滞且立即保守失败；之后更长的预算不能延长首次租约，也不能因浏览器或 worker 最终退出而改写未知证明。 */
for (const invalid of ["expired", "nan", "infinity"] as const) test(`actual Darwin ${invalid} stop deadline closes admission and remains sticky`, { timeout: 180000 }, async () => offlineScenario(async ({ config, bundle }) => {
    const start = ProcessSupervisor.prototype.start;
    let tested = false;
    ProcessSupervisor.prototype.start = async function (...args) {
        const owned = await start.apply(this, args);
        tested = true;
        const deadline = invalid === "expired" ? performance.now() - 1 : invalid === "nan" ? NaN : Infinity;
        const at = performance.now(), first = this.terminateAttempt(args[0], "TEST_EXPIRED", deadline);
        assert.equal(this.terminateAttempt(args[0], "TEST_EXTENSION", at + 30000), first);
        assert.equal((await first).processStopped, false);
        assert.ok(performance.now() - at < 1000, "Expired deadline cannot wait for a fresh graceful budget");
        await owned.exited;
        return owned;
    };
    try {
        const result = await diagnosedOfflineRun(bundle, config);
        assert.equal(tested, true);
        assert.equal(result.attempts[0]!.processStopped, false);
        assert.notEqual(result.outcome, "PASSED");
    } finally { ProcessSupervisor.prototype.start = start; }
}));

/** 原生目录包装只在真实 replace 完成后注入不确定结果，全部实际 B 文件核验、刷新及 Chrome 生命周期仍保留；私有 invocation 已经可见也不能宣称没有派生，重开恢复继续保留未知容量。 */
test("actual private invocation publication uncertainty cannot become NO_PROCESS or release offline owner", { timeout: 180000 }, async () => offlineScenario(async ({ config, bundle, local }) => {
    const native = darwinNative(), open = native.openPrivateDirectory.bind(native);
    let publications = 0;
    native.openPrivateDirectory = (path, create) => {
        const directory = open(path, create);
        if (!path.includes("/work/")) return directory;
        return {
            read: directory.read.bind(directory), entries: directory.entries.bind(directory), createExclusive: directory.createExclusive.bind(directory), remove: directory.remove.bind(directory), close: directory.close.bind(directory),
            replace(name, temporary, bytes, limit) {
                directory.replace(name, temporary, bytes, limit);
                if (name === "invocation.json") { publications++; throw Object.assign(new Error("TEST_COMMIT_UNCONFIRMED"), { code: "COMMIT_UNCONFIRMED" }); }
            },
        } satisfies DarwinPrivateDirectory;
    };
    try {
        const result = await diagnosedOfflineRun(bundle, config);
        assert.equal(publications, 1);
        assert.equal(result.attempts[0]!.processStopped, false);
        assert.equal(result.attempts[0]!.processStopScope, undefined);
        assert.notEqual(result.outcome, "PASSED");
        assert.equal((await recoverOffline(local))?.processStopped, false);
    } finally { native.openPrivateDirectory = open; }
}));

/** 线上 RUNNING 发布故障发生于真实 B 原子提交之后，outer 已存在而业务 START 尚未发送；后续只能复用真实受控停止结论，不能用 child 或普通路径提交猜测没有派生，也不能继续进入页面或上传成功完成清单。 */
test("online RUNNING journal publication uncertainty blocks business START and preserves controlled stopping", { timeout: 180000 }, async () => {
    const source = await createDarwinSource({ temporaryDirectory: root });
    const native = darwinNative(), open = native.openPrivateDirectory.bind(native), start = ProcessSupervisor.prototype.start;
    let publications = 0, businessStarts = 0;
    native.openPrivateDirectory = (path, create) => {
        const directory = open(path, create);
        if (!path.endsWith("/attempts")) return directory;
        return { read: directory.read.bind(directory), entries: directory.entries.bind(directory), createExclusive: directory.createExclusive.bind(directory), remove: directory.remove.bind(directory), close: directory.close.bind(directory), replace(name, temporary, bytes, limit) {
            directory.replace(name, temporary, bytes, limit);
            if (!publications && name.endsWith(".json") && privateJson(bytes).state === "RUNNING") { publications++; throw Object.assign(new Error("TEST_COMMIT_UNCONFIRMED"), { code: "COMMIT_UNCONFIRMED" }); }
        } } satisfies DarwinPrivateDirectory;
    };
    ProcessSupervisor.prototype.start = async function (...args) {
        const child = await start.apply(this, args);
        return { ...child, send(message: unknown) { if ((message as { type: string }).type === "START") businessStarts++; child.send(message); } };
    };
    try {
        await onlineBusiness({ darwinSource: source, expectIncomplete: true, expectedStop: true });
        assert.equal(publications, 1);
        assert.equal(businessStarts, 0);
    } finally { native.openPrivateDirectory = open; ProcessSupervisor.prototype.start = start; }
});

/** SQLite 的故障点先执行真实 RUNNING COMMIT 再抛错，因此调用方手中的旧 SPAWNING token 不能授权后续状态写入；停止仍立即执行，持久占用保持可恢复未知，不能在 finally 中用状态失配释放容量或补发业务 START。 */
test("offline actual RUNNING commit uncertainty retains capacity and never sends late START", { timeout: 180000 }, async () => offlineScenario(async ({ config, bundle, local }) => {
    const exec = DatabaseSync.prototype.exec, start = ProcessSupervisor.prototype.start;
    let injected = false, businessStarts = 0;
    DatabaseSync.prototype.exec = function (sql: string) {
        if (!injected && sql === "COMMIT" && this.prepare("SELECT state FROM veriq_local_owner WHERE singleton=1").get()?.state === "RUNNING") {
            exec.call(this, sql);
            injected = true;
            throw new Error("TEST_COMMIT_UNCONFIRMED");
        }
        return exec.call(this, sql);
    };
    ProcessSupervisor.prototype.start = async function (...args) {
        const child = await start.apply(this, args);
        return { ...child, send(message: unknown) { if ((message as { type: string }).type === "START") businessStarts++; child.send(message); } };
    };
    try {
        await assert.rejects(diagnosedOfflineRun(bundle, config));
        assert.equal(injected, true);
        assert.equal(businessStarts, 0);
        const store = await LocalStore.open(local);
        try { assert.equal(store.active()?.state, "RUNNING"); assert.equal(store.unspawnedStop(store.active()!), undefined); } finally { store.close(); }
    } finally { DatabaseSync.prototype.exec = exec; ProcessSupervisor.prototype.start = start; }
}));

/** 真正重试为每个 Attempt 写独立控制证明，第二次 LAUNCH 使用 SQLite 已提交的新代际而不是覆盖第一份历史；断言失败后通过仍显示 UNSTABLE，重开报告保留两个受控范围，不把新 owner generation 重贴到旧 proof。 */
test("offline real retry retains both launch generations and CONTROLLED report scopes", { timeout: 240000 }, async () => {
    let firstPage = true;
    const server = createServer((request, response) => {
        if (request.url === "/me") { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ id: "reader" })); return; }
        if (request.url === "/" && firstPage) { firstPage = false; response.writeHead(302, { location: "/wrong" }); response.end(); return; }
        response.setHeader("Content-Type", "text/html");
        response.end('<div data-testid="name">Ready</div>');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`, f = await fixture(engine.distribution, origin);
    try {
        const bundle = await verifyBundle(await f.archive(), { trust: f.trust, destination: join(f.dir, "installed") });
        const secrets = new SecretStore(join(f.dir, "secrets")), local = join(f.dir, "local");
        await secrets.set({ issuerId: f.issuer.issuerId, workspaceId: id(99), secretRef: "reader", versionId: id(14) }, { token: "local-test-only" });
        const source = await createDarwinSource({ temporaryDirectory: root });
        const result = await diagnosedOfflineRun(bundle, { root: local, trust: f.trust, secrets, releaseDirectory: engine.release, browserExecutable: chromium.executablePath(), darwinSource: source, deviceId: id(90), retry: true });
        assert.equal(result.outcome, "UNSTABLE");
        assert.equal(result.attempts.length, 2);
        for (const [index, attempt] of result.attempts.entries()) {
            assert.equal(attempt.processStopped, true);
            assert.equal(attempt.processStopScope, "CONTROLLED_WORKER_BROWSER");
            const proof = privateJson(await readFile(join(local, "processes", `${attempt.attemptId}.controlled.json`), "utf8"));
            assert.equal(proof.ownerGeneration, index + 1);
        }
        const snapshot = await new LocalReports(local, () => true).snapshot(result.workspaceId, result.localRunId);
        assert.equal(snapshot.reports[0]!.cases[0]!.attempts.length, 2);
        assert.ok(snapshot.reports[0]!.cases[0]!.attempts.every((attempt) => attempt.facts.processStopScope === "CONTROLLED_WORKER_BROWSER"));
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await f.close(); }
});

/** 即使停止先于任何实际 start 登记，首次终结也必须关闭该 Attempt 的未来准入，否则旧去重 promise 可能遮蔽后来创建的活进程；非法可见模式和下载目录同样必须在 Chrome 派生之前由真实受信入口拒绝。 */
test("Darwin first stop closes future admission and rejects untrusted browser options", async () => {
    const source = await createDarwinSource({ temporaryDirectory: root }), directory = join(root, "admission"), work = join(directory, "work");
    await mkdir(work, { recursive: true, mode: 0o700 });
    const processes = new ProcessSupervisor(join(directory, "processes"), 500, undefined, source), attemptId = randomUUID();
    const command = { executable: process.execPath, args: ["-e", "process.exit(0)"], cwd: work };
    await processes.terminateAttempt(attemptId, "CLOSED_BEFORE_START");
    await assert.rejects(processes.start(attemptId, command, { kind: "TEST", ownerGeneration: 1, prepare() {} }), /DARWIN_ATTEMPT_STOPPING/);
    await assert.rejects(processes.start(randomUUID(), command, { kind: "TEST", ownerGeneration: 1, headless: "false" as unknown as boolean, prepare() {} }), /INVALID_BROWSER_MODE/);
    await assert.rejects(processes.start(randomUUID(), command, { kind: "TEST", ownerGeneration: 1, downloadsPath: root, prepare() {} }), /DARWIN_DOWNLOAD_DIRECTORY_INVALID/);
});

/** 最终日志读取故障发生在真实 outer 与 CLI 已经结束之后，仍不能把普通 EOF、业务断言结果或已返回读字节提升成受控停止；包装保留实际 B File 拥有者，只注入读取结果不确定性，生产终结路径必须保留未知范围和容量。 */
test("online actual final B journal read uncertainty prevents delivery and positive scope", { timeout: 180000 }, async () => {
    const source = await createDarwinSource({ temporaryDirectory: root }), native = darwinNative(), open = native.openPrivateDirectory.bind(native);
    let reads = 0;
    native.openPrivateDirectory = (path, create) => {
        const directory = open(path, create);
        if (!path.includes("/controlled-journals/")) return directory;
        return { read: directory.read.bind(directory), entries: directory.entries.bind(directory), replace: directory.replace.bind(directory), remove: directory.remove.bind(directory), close: directory.close.bind(directory), createExclusive(name) {
            const file = directory.createExclusive(name);
            if (name !== "command.jsonl") return file;
            return { get fd() { return file.fd; }, close: file.close.bind(file), read(limit) {
                file.read(limit);
                reads++;
                throw new Error("TEST_READ_UNCONFIRMED");
            } };
        } } satisfies DarwinPrivateDirectory;
    };
    try {
        await onlineBusiness({ darwinSource: source, expectIncomplete: true, expectedStop: false, inspect: async ({ result }) => {
            assert.equal(result.stop.processStopScope, undefined);
            assert.equal(result.completion, undefined);
        } });
        assert.equal(reads, 1);
    } finally { native.openPrivateDirectory = open; }
});

/** 真实业务先生成完整停止证明，再只改变在线 journal 中的 Claim fence，恢复必须拒绝把有效旧 proof 借给不同代际；此测试不重写 proof、不伪造进程退出，也不以 HTTP 夹具的 reconcile ACK 代替服务端真实容量事务。 */
test("online actual controlled history cannot reconcile a different claim generation or kind", { timeout: 240000 }, async () => {
    const source = await createDarwinSource({ temporaryDirectory: root });
    let checked = 0;
    await onlineBusiness({ darwinSource: source, inspect: async ({ root: directory, result, supervisor, run }) => {
        assert.ok(result.completion);
        const journals = darwinNative().openPrivateDirectory(join(directory, "agent", "attempts"), false);
        try {
            const name = `${result.stop.attemptId}.json`, record = privateJson(journals.read(name, 65536));
            if (run === 1) record.claim.fencingToken++;
            else record.claim.jobKind = "VALIDATE";
            journals.replace(name, `.${randomUUID()}.tmp`, Buffer.from(JSON.stringify(record)), 65536);
        } finally { journals.close(); }
        const recovered = (await supervisor.recover()).find((receipt) => receipt.attemptId === result.stop.attemptId)!;
        assert.equal(recovered.processStopped, false);
        assert.equal(recovered.processStopScope, undefined);
        assert.equal(recovered.reason, "CONTROLLED_OWNER_MISMATCH");
        checked++;
    } });
    assert.equal(checked, 2);
});

/** 持久取消通过第二个真实 SQLite 连接写入，故意不派发 AbortSignal，实际 Chrome 已创建但 BrowserServer 返回受测试闸门控制；后台必须在释放闸门前观察取消并关闭启动准入，不能等待完整 start 返回或把未赋值 child 当成未派生。 */
test("persisted offline cancellation closes pending real BrowserServer admission before barrier release", { timeout: 180000 }, async (context) => offlineScenario(async ({ config, bundle, local, abort, cleanupDeadline }) => {
    const launch = chromium.launchServer.bind(chromium), start = ProcessSupervisor.prototype.start, terminate = ProcessSupervisor.prototype.terminateAttempt;
    let entered!: () => void, release!: () => void, stopped!: () => void;
    const atBarrier = new Promise<void>((resolve) => { entered = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const firstStop = new Promise<void>((resolve) => { stopped = resolve; });
    let stopCalls = 0, businessStarts = 0, released = false;
    chromium.launchServer = async (options) => {
        const server = await launch(options);
        entered();
        await barrier;
        return server;
    };
    ProcessSupervisor.prototype.start = async function (...args) {
        const child = await start.apply(this, args);
        return { ...child, send(message: unknown) { if ((message as { type: string }).type === "START") businessStarts++; child.send(message); } };
    };
    ProcessSupervisor.prototype.terminateAttempt = function (...args) {
        stopCalls++;
        if (stopCalls === 1) { assert.equal(released, false); stopped(); }
        return terminate.apply(this, args);
    };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let running: ReturnType<typeof runOffline> | undefined;
    let watch: ReturnType<typeof watchBusinessRun<Awaited<ReturnType<typeof runOffline>>>> | undefined;
    try {
        running = diagnosedOfflineRun(bundle, config);
        watch = watchBusinessRun(running, context.signal);
        await watch.waitFor(atBarrier, "BARRIER");
        const connection = await LocalStore.open(local);
        const owner = connection.active()!;
        const at = performance.now();
        try { connection.cancel(owner.workspaceId, owner.runId); } finally { connection.close(); }
        await watch.waitFor(Promise.race([firstStop, new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("PERSISTED_CANCEL_OBSERVATION_LATE")), 600); })]), "STOP");
        clearTimeout(timeout);
        assert.ok(performance.now() - at < 600, "Polling budget is100ms plus bounded500ms scheduler allowance");
        assert.equal(config.signal!.aborted, false);
        assert.equal(stopCalls, 1);
        released = true;
        release();
        const result = await watch.result();
        assert.equal(result.outcome, "CANCELLED");
        assert.equal(result.attempts[0]!.processStopped, false);
        assert.equal(result.attempts[0]!.processStopScope, undefined);
        assert.equal(businessStarts, 0);
        assert.equal(stopCalls, 1);
    } finally {
        clearTimeout(timeout);
        released = true;
        release();
        abort();
        try { if (watch) await fixtureBefore(watch.outcome, cleanupDeadline()); }
        finally {
            watch?.close();
            chromium.launchServer = launch;
            ProcessSupervisor.prototype.start = start;
            ProcessSupervisor.prototype.terminateAttempt = terminate;
        }
    }
}, 30000, context.signal));

/** Mac 发布只允许本次独占根在 rename 时暂存七百权限，所有内部目录和成员必须已经只读；返回前通过原 fd 将同一个根封为五百，测试比较真实 inode 并拒绝覆盖已有目标，不能由字符串 chmod 修复已安装或用户目录。 */
test("Darwin bundle publication renames only its owned writable root and returns a fully sealed tree", async () => {
    const f = await fixture(), rename = fs.rename;
    let renamed = 0, originalIdentity: { dev: number; ino: number } | undefined;
    fs.rename = async (source, target) => {
        if (String(source).includes("/.veriq-bundle-")) {
            const info = await lstat(source);
            originalIdentity = { dev: info.dev, ino: info.ino };
            assert.equal(info.mode & 0o777, 0o700);
            renamed++;
        }
        return rename(source, target);
    };
    syncBuiltinESMExports();
    try {
        const destination = join(f.dir, "sealed");
        const bundle = await verifyBundle(await f.archive(), { trust: f.trust, destination });
        assert.equal(renamed, 1);
        const current = await lstat(bundle.directory);
        assert.equal(current.dev, originalIdentity!.dev);
        assert.equal(current.ino, originalIdentity!.ino);
        const sealed = async (directory: string): Promise<void> => {
            assert.equal((await lstat(directory)).mode & 0o777, 0o500);
            for (const item of await readdir(directory, { withFileTypes: true })) {
                const path = join(directory, item.name);
                if (item.isDirectory()) await sealed(path);
                else assert.equal((await lstat(path)).mode & 0o777, 0o400);
            }
        };
        await sealed(destination);
        await assert.rejects(verifyBundle(await f.archive(), { trust: f.trust, destination }), /BUNDLE_DESTINATION_EXISTS/);
        assert.equal((await lstat(destination)).ino, current.ino);
    } finally { fs.rename = rename; syncBuiltinESMExports(); await f.close(); }
});

/** fd 封存先真实成功再注入不确定性，发布后的同一树必须保留且接口拒绝成功返回；finally 不得拿已经退出 staging 所有权的 installed 字符串去改权限或递归删除，更不能因此覆盖调用者原有目录。 */
test("Darwin post-publication fd seal uncertainty retains the published sealed inode without success", async () => {
    const f = await fixture(), open = fs.open;
    let seals = 0;
    fs.open = async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        if (String(args[0]).includes("/.veriq-bundle-") && (await handle.stat()).isDirectory()) {
            const chmod = handle.chmod.bind(handle);
            handle.chmod = async (mode) => {
                await chmod(mode);
                if (mode === 0o500) { seals++; throw new Error("TEST_SEAL_COMMIT_UNCONFIRMED"); }
            };
        }
        return handle;
    };
    syncBuiltinESMExports();
    try {
        const destination = join(f.dir, "uncertain");
        await assert.rejects(verifyBundle(await f.archive(), { trust: f.trust, destination }), /TEST_SEAL_COMMIT_UNCONFIRMED/);
        assert.equal(seals, 1);
        assert.equal((await lstat(destination)).mode & 0o777, 0o500);
        assert.ok((await readFile(join(destination, "manifest.json"))).length > 0);
        await assert.rejects(verifyBundle(await f.archive(), { trust: f.trust, destination }), /BUNDLE_DESTINATION_EXISTS/);
    } finally { fs.open = open; syncBuiltinESMExports(); await f.close(); }
});

/** 启动闸门内的取消查询若真实 SQLite 包装报告读取不确定，观察器必须走同一首次停止并关闭后端准入；测试只在实际 Chrome 已创建后注入固定读取错误，不伪造取消位、不派发用户信号，也不把失败解释成正常业务成功。 */
test("pending-start persisted cancellation read failure closes admission with one conservative stop", { timeout: 180000 }, async (context) => offlineScenario(async ({ config, bundle, abort, cleanupDeadline }) => {
    const launch = chromium.launchServer.bind(chromium), cancelled = LocalStore.prototype.cancelled, terminate = ProcessSupervisor.prototype.terminateAttempt;
    let entered!: () => void, release!: () => void, stopped!: () => void;
    const atBarrier = new Promise<void>((resolve) => { entered = resolve; }), barrier = new Promise<void>((resolve) => { release = resolve; }), firstStop = new Promise<void>((resolve) => { stopped = resolve; });
    let armed = false, stops = 0, timer: ReturnType<typeof setTimeout> | undefined, running: ReturnType<typeof runOffline> | undefined;
    chromium.launchServer = async (options) => { const server = await launch(options); entered(); await barrier; return server; };
    LocalStore.prototype.cancelled = function (runId) { if (armed) throw new Error("TEST_SQLITE_READ_UNCONFIRMED"); return cancelled.call(this, runId); };
    ProcessSupervisor.prototype.terminateAttempt = function (...args) { stops++; stopped(); return terminate.apply(this, args); };
    let watch: ReturnType<typeof watchBusinessRun<Awaited<ReturnType<typeof runOffline>>>> | undefined;
    try {
        running = diagnosedOfflineRun(bundle, config);
        watch = watchBusinessRun(running, context.signal);
        await watch.waitFor(atBarrier, "BARRIER");
        armed = true;
        await watch.waitFor(Promise.race([firstStop, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("CANCEL_READ_FAILURE_OBSERVATION_LATE")), 600); })]), "STOP");
        clearTimeout(timer);
        assert.equal(stops, 1);
        armed = false;
        release();
        const result = await watch.result();
        assert.equal(result.outcome, "ERROR");
        assert.equal(result.attempts[0]!.failureCode, "LOCAL_CANCELLATION_READ_FAILED");
        assert.equal(result.attempts[0]!.processStopped, false);
        assert.equal(result.attempts[0]!.processStopScope, undefined);
        assert.equal(stops, 1);
    } finally {
        clearTimeout(timer);
        armed = false;
        release();
        abort();
        try { if (watch) await fixtureBefore(watch.outcome, cleanupDeadline()); }
        finally {
            watch?.close();
            chromium.launchServer = launch;
            LocalStore.prototype.cancelled = cancelled;
            ProcessSupervisor.prototype.terminateAttempt = terminate;
        }
    }
}, 30000, context.signal));


/** 在同一个真实 CLI 已返回一的进程对象上破坏最终 JSON，观察器只保存故障而仍返回原始退出事实；这两个独立门禁负例不属于完整保密扫描组，必须证明报告拒绝并不损伤实际 CONTROLLED 停机回执，而且不会产生附件、交付请求或可读本地证据。 */
async function invalidFinalJson(label: "ONLINE_JSON_INVALID" | "OFFLINE_JSON_INVALID", run: () => Promise<void>) {
    const start = ProcessSupervisor.prototype.start, launch = chromium.launchServer.bind(chromium);
    const observations: { exited: Promise<unknown>; assertClean(): void }[] = [];
    const children: OwnedProcess[] = [], servers: BrowserServer[] = [];
    let faults = 0, actualCliFailure = 0;
    chromium.launchServer = async (options) => {
        const server = await launch(options); servers.push(server);
        const endpoint = new URL(server.wsEndpoint()); endpoint.port = "1";
        server.wsEndpoint = () => endpoint.href;
        return server;
    };
    ProcessSupervisor.prototype.start = async function (...args: Parameters<typeof start>) {
        const child = await start.apply(this, args); children.push(child);
        const invocation = privateJson(await readFile(join(args[1].cwd, "invocation.json")));
        const observation = observeBusinessExit(child.exited, async () => {
            const facts = await child.exited;
            assert.equal(facts.code, 1);
            actualCliFailure++;
            const json = join(invocation.tmp, "playwright.json");
            assert.equal((await lstat(json)).isFile(), true);
            await writeFile(json, "{", { mode: 0o600 }); faults++;
        });
        observations.push(observation);
        return { ...child, exited: observation.exited };
    };
    try {
        await run();
        await Promise.all(observations.map((observation) => observation.exited));
        for (const observation of observations) observation.assertClean();
        assert.equal(faults, 1); assert.equal(actualCliFailure, 1);
        console.log(JSON.stringify({ jsonDeliveryGate: { label, ordinaryCliExitOne: actualCliFailure, injected: faults, blocked: true, privacyScanCoverage: "EXPECTED_UNREACHED" } }));
    } finally {
        const deadline = performance.now() + 30000;
        try {
            for (const child of children) {
                if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill("SIGKILL");
                await fixtureBefore(child.exited, deadline);
            }
            for (const server of servers) {
                const child = server.process();
                if (child.exitCode === null && child.signalCode === null) {
                    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
                    await fixtureBefore(server.kill(), deadline); await fixtureBefore(exited, deadline);
                }
            }
            await fixtureBefore(Promise.allSettled(observations.map((observation) => observation.exited)), deadline);
        } finally { ProcessSupervisor.prototype.start = start; chromium.launchServer = launch; }
    }
}

test("online independent JSON gate blocks every artifact and finish request after actual CLI exit one", { timeout: 180000 }, async () => {
    const source = await createDarwinSource({ temporaryDirectory: root });
    let deliveries = 0;
    await invalidFinalJson("ONLINE_JSON_INVALID", async () => onlineBusiness({ darwinSource: source, expectIncomplete: true, expectedStop: true, beforeDelivery: () => { deliveries++; }, inspect: async ({ result, uploads, events }) => {
        assert.equal(result.completion, undefined); assert.equal(result.stop.reason, "REPORT_PRIVACY_UNCONFIRMED");
        assert.equal(result.stop.processStopScope, "CONTROLLED_WORKER_BROWSER");
        assert.equal(result.files.length, 0); assert.equal(uploads.size, 0); assert.equal(deliveries, 0);
        assert.equal(events.filter((event) => event.type === "ARTIFACT_CREATED").length, 0);
    } }));
});

test("offline independent JSON gate blocks evidence and local report bytes after actual CLI exit one", { timeout: 180000 }, async () => offlineScenario(async ({ local, config, bundle }) => {
    await invalidFinalJson("OFFLINE_JSON_INVALID", async () => {
        const result = await diagnosedOfflineRun(bundle, config), attempt = result.attempts[0]!;
        assert.equal(result.outcome, "ERROR"); assert.equal(attempt.failureCode, "REPORT_PRIVACY_UNCONFIRMED");
        assert.equal(attempt.processStopped, true); assert.equal(attempt.processStopScope, "CONTROLLED_WORKER_BROWSER");
        assert.equal(attempt.artifacts.length, 0); assert.equal(attempt.events.filter((event) => event.type === "ARTIFACT_CREATED").length, 0);
        const reports = new LocalReports(local, () => true), snapshot = await reports.snapshot(result.workspaceId, result.localRunId);
        assert.equal(snapshot.artifacts[attempt.attemptId]!.length, 0);
        await assert.rejects(reports.readRaw(result.workspaceId, result.localRunId, attempt.attemptId, randomUUID()), /LOCAL_ARTIFACT_NOT_FOUND/);
        await assert.rejects(lstat(join(local, "work", attempt.attemptId, "evidence")), { code: "ENOENT" });
    });
}));
