/** 业务测试共享真实编译、签名包与 HTTP 控制夹具构造，生产代码不导入此文件；真实引擎由固定 queue-fixture 构建 SDK、contracts、compiler 和离线依赖闭包，HTTP 响应仅代表本地 Node 控制夹具而非 Python/MySQL 服务验收。 */
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm, chmod, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { compileFiles, type EngineDistribution } from "@veriq/compiler";
import { canonicalBytes, assetSourceBytes, validateSchema, type ExecutionSnapshotV1 } from "@veriq/contracts";
import { snapshot, asset, id } from "../../../../packages/compiler/tests/helpers.ts";
import { TrustStore, type IssuerTrust } from "../../src/offline/trust.ts";
import { loadRelease } from "../../src/execution/release.ts";
import { readBoundedFile } from "../../src/offline/config.ts";
import { DeviceStore, RuntimeClient } from "../../src/enrollment.ts";
import { DeviceSession } from "../../src/agent/credentials.ts";
import { AgentClient, type Claim } from "../../src/agent/transport.ts";
import { ExecutionSupervisor, type AttemptResult } from "../../src/execution/supervisor.ts";
import type { DarwinSourceCapability } from "../../src/execution/darwin-source.ts";
const sha = (raw: Uint8Array) => createHash("sha256").update(raw).digest("hex");
const hash = sha;
async function cleanup(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.isDirectory()) await cleanup(join(path, entry.name));
    }
    await chmod(path, 0o700);
}
/** 签名包夹具保留原 offline suite 的恶意路径、版本及信任边界样本，真实业务调用必须显式提供实际离线发行闭包；缺省的小字节依赖只服务签名与结构拒绝测试，不代表 SDK 执行结果、编译成功回执或浏览器停止证据。 */
export async function fixture(realDistribution?: EngineDistribution, baseURL = "https://business.test", expectedURL = baseURL + "/") {
    const dir = await mkdtemp(join(await realpath(tmpdir()), "veriq-offline-")),
        pair = generateKeyPairSync("ed25519"),
        raw = pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    const issuer: IssuerTrust = {
        issuerId: "test_issuer",
        revision: 1,
        keys: [
            {
                keyId: "key_1",
                algorithm: "Ed25519",
                publicKey: raw.toString("base64"),
                fingerprint: sha(raw),
                revoked: false,
            },
        ],
    };
    const trust = new TrustStore(join(dir, "trust"));
    await trust.bind(issuer, "https://control.test", issuer.keys[0]!.fingerprint);
    async function archive(
        opts: {
            extra?: string;
            mutate?: boolean;
            expired?: boolean;
            debug?: boolean;
            dslOnly?: boolean;
            dslError?: boolean;
            unsigned?: boolean;
            duplicate?: boolean;
            link?: boolean;
            payload?: Buffer;
            directoryCollision?: boolean;
            suite?: boolean;
            inconsistent?:
                | "entries"
                | "adapter"
                | "engine"
                | "entrypoints"
                | "entrypath"
                | "suiteSwap"
                | "validationOnly"
                | "dependencies";
            signing?: { keyId: string; privateKey: typeof pair.privateKey };
        } = {},
    ) {
        const source = snapshot(
            realDistribution
                ? [
                      {
                          id: "open",
                          action: "goto",
                          path: "/",
                          afterAssertions: [
                              {
                                  id: "url",
                                  type: "url",
                                  source: "page",
                                  operator: "equals",
                                  expected: expectedURL,
                                  severity: "BLOCK",
                                  expectedSource: "REQ",
                              },
                          ],
                      },
                  ]
                : undefined,
            [
                asset(3, "ENVIRONMENT", {
                    schemaVersion: "1.0",
                    baseURL,
                    apiBaseURL: baseURL,
                    allowedOrigins: [baseURL],
                    locale: "en",
                    timezone: "UTC",
                    roles: [
                        {
                            roleKey: "reader",
                            authAdapterVersionId: id(13),
                            secretRef: "reader",
                            allowedIdentityIds: ["reader"],
                            secretVersionId: id(14),
                        },
                    ],
                }),
            ],
        );
        const suite = opts.suite || opts.inconsistent === "suiteSwap";
        if (suite) {
            const first = source.assets.find((a) => a.kind === "CASE")!;
            source.assets.push(
                asset(10, "CASE", { ...first.document, caseKey: "second" }),
                asset(20, "SUITE", {
                    schemaVersion: "1.0",
                    cases: [{ versionId: id(1) }, { versionId: id(10) }],
                }),
            );
            source.entryCaseVersionIds.push(id(10));
        }
        const configuration = {
            kind: "HTTP_BEARER" as const,
            identityPath: "/me",
            identityPointer: "/id",
        };
        source.authAdapters = [
            {
                workspaceId: source.workspaceId,
                versionId: id(13),
                configuration,
                contentHash: sha(canonicalBytes(configuration)),
            },
        ];
        source.sourceHash = sha(assetSourceBytes(source));
        const vendor = Buffer.from("isolated dependency byte fixture");
        const dependencies = [
            {
                name: "@veriq/runner-sdk",
                version: "0.1.0",
                integrity: "sha512-" + createHash("sha512").update(vendor).digest("base64"),
            },
        ];
        const distribution: EngineDistribution = realDistribution ?? {
            engineVersion: "0.1.0",
            runnerSdkVersion: "0.1.0",
            dependencies,
            packageJson: canonicalBytes({
                name: "veriq-generated",
                type: "module",
                dependencies: { "@veriq/runner-sdk": "file:vendor/sdk.tgz" },
            }),
            packageLock: canonicalBytes({
                lockfileVersion: 3,
                packages: {
                    "": { dependencies: { "@veriq/runner-sdk": "file:vendor/sdk.tgz" } },
                    "node_modules/@veriq/runner-sdk": {
                        version: "0.1.0",
                        resolved: "file:vendor/sdk.tgz",
                        integrity: dependencies[0]!.integrity,
                    },
                },
            }),
            files: { "vendor/sdk.tgz": vendor },
        };
        const files: Record<string, Buffer> = {
            "snapshot.json": Buffer.from(canonicalBytes(source)),
            "value.txt": opts.payload ?? Buffer.from("original"),
        };
        const put = (path: string, value: unknown) => {
            files[path] = Buffer.from(canonicalBytes(value));
        };
        put("selection.json", {
            ...(suite ? { suiteVersionId: id(20) } : { caseVersionIds: [id(1)] }),
            environmentVersionId: id(3),
            validationStatus: opts.debug || opts.dslOnly ? "UNVALIDATED_DEBUG" : "VALIDATED",
        });
        put("resources.json", {
            resources: source.assets.map((a) => ({
                id: a.resourceId,
                workspaceId: source.workspaceId,
                kind: a.kind,
                key: "resource_" + a.versionId,
                name: "Resource",
                status: "PUBLISHED",
                latestVersionId: a.versionId,
            })),
            versions: source.assets.map((a) => ({
                id: a.versionId,
                resourceId: a.resourceId,
                workspaceId: source.workspaceId,
                versionNo: 1,
                schemaVersion: "1.0",
                sha256: a.sha256,
                content: { kind: a.kind, document: a.document },
                publishedAt: "2020-01-01T00:00:00Z",
            })),
        });
        for (const a of source.assets) {
            put(`assets/${a.versionId}.json`, a);
            const original = {
                schemaVersion: "1.0",
                workspaceId: source.workspaceId,
                engineVersion: source.engineVersion,
                sourceHash: "",
                entryCaseVersionIds:
                    a.kind === "CASE" ? [a.versionId] : a.kind === "SUITE" ? [id(1), id(10)] : [],
                assets:
                    a.kind === "CASE"
                        ? source.assets.filter(
                              (x) => x.versionId === a.versionId || x.kind === "ELEMENT_CATALOG",
                          )
                        : a.kind === "SUITE"
                          ? source.assets.filter((x) => x.kind !== "ENVIRONMENT")
                          : [a],
                ...(a.kind === "ENVIRONMENT" ? { authAdapters: source.authAdapters } : {}),
                validationTarget: {
                    resourceId: a.resourceId,
                    versionId: a.versionId,
                    revision: 1,
                },
            };
            original.sourceHash = sha(assetSourceBytes(original));
            const compiled = compileFiles(original as typeof source, distribution),
                descriptor = compiled.bundle;
            put(`provenance/${a.versionId}/source.json`, original);
            put(`provenance/${a.versionId}/descriptor.json`, descriptor);
            put(`provenance/${a.versionId}/receipt.json`, {
                sourceHash: original.sourceHash,
                compiledBundleSha256: sha(canonicalBytes(descriptor)),
                engineVersion: "0.1.0",
                compilerTrust: "MANAGED",
                revision: 1,
            });
            for (const [path, bytes] of Object.entries(compiled.files))
                files[`compiled/${a.versionId}/${path}`] = Buffer.from(bytes);
        }
        const engineFiles = ["package.json", "package-lock.json", "dependencies.json"].map(
            (path) => {
                const body = Buffer.from(
                    path === "package.json"
                        ? distribution.packageJson
                        : path === "package-lock.json"
                          ? distribution.packageLock
                          : canonicalBytes(distribution.dependencies),
                );
                files["engine/" + path] = body;
                return { path, sha256: sha(body), sizeBytes: body.length };
            },
        );
        put("engine/inventory.json", {
            schemaVersion: "1.0",
            engines: [
                {
                    engineVersion: "0.1.0",
                    compilerVersion: "0.1.0",
                    runnerSdkVersion: "0.1.0",
                    files: engineFiles,
                    dependencies: distribution.dependencies,
                },
            ],
        });
        if (opts.directoryCollision) {
            files["Folder/a.txt"] = Buffer.from("a");
            files["folder/b.txt"] = Buffer.from("b");
        }
        if (opts.inconsistent) {
            const update = (path: string, change: (value: any) => void) => {
                const value = JSON.parse(files[path]!.toString());
                change(value);
                put(path, value);
                return value;
            };
            if (opts.inconsistent === "entries" || opts.inconsistent === "adapter") {
                if (opts.inconsistent === "entries") source.entryCaseVersionIds = [id(999)];
                else
                    source.authAdapters = [
                        {
                            workspaceId: id(999),
                            versionId: id(13),
                            configuration: {
                                kind: "HTTP_BEARER",
                                identityPath: "/me",
                                identityPointer: "/id",
                            },
                            contentHash: "0".repeat(64),
                        },
                    ];
                source.sourceHash = sha(assetSourceBytes(source));
                put("snapshot.json", source);
            } else if (opts.inconsistent === "engine") {
                update("engine/inventory.json", (v) => {
                    v.engines[0].compilerVersion = "9.9.9";
                    v.engines[0].runnerSdkVersion = "9.9.9";
                });
            } else {
                const target = opts.inconsistent === "suiteSwap" ? id(20) : id(1);
                const path = `provenance/${target}/descriptor.json`;
                update(path, (v) => {
                    if (opts.inconsistent === "entrypoints")
                        v.entrypoints[0].caseVersionId = id(999);
                    if (opts.inconsistent === "entrypath") v.entrypoints[0].path = "package.json";
                    if (opts.inconsistent === "suiteSwap")
                        [v.entrypoints[0].path, v.entrypoints[1].path] = [
                            v.entrypoints[1].path,
                            v.entrypoints[0].path,
                        ];
                    if (opts.inconsistent === "validationOnly") v.validationOnly = true;
                    if (opts.inconsistent === "dependencies") v.dependencies[0].version = "9.9.9";
                });
                update(`provenance/${target}/receipt.json`, (v) => {
                    v.compiledBundleSha256 = sha(files[path]!);
                });
            }
        }
        if (opts.dslOnly) {
            const draft = JSON.parse(files[`provenance/${id(1)}/source.json`]!.toString());
            if (opts.dslError) {
                const changed = draft.assets.find(
                    (a: { versionId: string }) => a.versionId === id(1),
                );
                changed.document.steps = [{ id: "click", action: "click", target: "missing" }];
                changed.sha256 = sha(
                    canonicalBytes({ kind: changed.kind, document: changed.document }),
                );
                draft.sourceHash = sha(assetSourceBytes(draft));
                source.assets[source.assets.findIndex((a) => a.versionId === id(1))] = changed;
                put(`assets/${id(1)}.json`, changed);
            }
            source.validationTarget = draft.validationTarget;
            source.sourceHash = sha(assetSourceBytes(source));
            put("snapshot.json", source);
            put("draft/source.json", draft);
            put("draft/metadata.json", { frozenAt: "2026-11-12T00:00:00Z" });
            put("selection.json", {
                draftValidationJobId: id(77),
                environmentVersionId: id(3),
                validationStatus: "UNVALIDATED_DEBUG",
            });
            const resources = JSON.parse(files["resources.json"]!.toString());
            resources.versions = resources.versions.filter((v: { id: string }) => v.id !== id(1));
            for (const resource of resources.resources)
                if (resource.latestVersionId === id(1)) delete resource.latestVersionId;
            put("resources.json", resources);
            for (const path of Object.keys(files))
                if (
                    path.startsWith("compiled/") ||
                    path.startsWith("engine/") ||
                    path.startsWith(`provenance/${id(1)}/`)
                )
                    delete files[path];
            put("engine/requirements.json", {
                engineVersion: "0.1.0",
                localCompilationRequired: true,
            });
        }
        const manifest = {
            schemaVersion: "1.0",
            bundleId: "00000000-0000-4000-8000-000000000010",
            workspaceId: source.workspaceId,
            issuerId: issuer.issuerId,
            keyId: opts.signing?.keyId ?? "key_1",
            createdAt: "2020-01-01T00:00:00Z",
            expiresAt: opts.expired ? "2021-01-01T00:00:00Z" : "2099-01-01T00:00:00Z",
            sourceHash: source.sourceHash,
            snapshotSha256: sha(files["snapshot.json"]!),
            engineVersion: "0.1.0",
            validationStatus: opts.debug || opts.dslOnly ? "UNVALIDATED_DEBUG" : "VALIDATED",
            files: Object.entries(files).map(([path, body]) => ({
                path,
                sha256: sha(body),
                sizeBytes: body.length,
            })),
        };
        const manifestRaw = Buffer.from(canonicalBytes(manifest));
        files["manifest.json"] = manifestRaw;
        files["manifest.sig"] = opts.unsigned
            ? Buffer.alloc(64)
            : sign(null, manifestRaw, opts.signing?.privateKey ?? pair.privateKey);
        if (opts.mutate) files["value.txt"] = Buffer.from("tampered");
        if (opts.extra) files[opts.extra] = Buffer.from("extra");
        const input = join(dir, "entries.json"),
            output = join(dir, "bundle.zip");
        await writeFile(
            input,
            JSON.stringify({
                files: Object.fromEntries(
                    Object.entries(files).map(([k, v]) => [k, v.toString("base64")]),
                ),
                duplicate: opts.duplicate,
                link: opts.link,
            }),
        );
        execFileSync(process.platform === "darwin" ? "python3" : "python", [
            "-c",
            `import json,base64,zipfile,sys
v=json.load(open(sys.argv[1]))
with zipfile.ZipFile(sys.argv[2],'w',compression=zipfile.ZIP_DEFLATED) as z:
 for n,b in v['files'].items():
    info=zipfile.ZipInfo(n);info.external_attr=((0o120777 if v.get('link') and n=='value.txt' else 0o100600)<<16);info.compress_type=zipfile.ZIP_DEFLATED;z.writestr(info,base64.b64decode(b))
 if v.get('duplicate'): z.writestr('VALUE.txt',b'x')`,
            input,
            output,
        ]);
        return output;
    }
    return {
        dir,
        trust,
        issuer,
        archive,
        close: async () => {
            await cleanup(dir);
            await rm(dir, { recursive: true, force: true });
        },
    };
}

/** 构建只调用现有测试入口生成真实且冻结的离线闭包，再按受信 inventory 重建 release 并由产品 loadRelease 核验；调用方只在有充分空间的真实浏览器宿主使用，本地受限 Linux 不会复制或安装引擎。 */
export async function buildBusinessEngine(root: string) {
    const source = join(root, "engine-source.json"), build = join(root, "build"), release = join(root, "release");
    await writeFile(source, canonicalBytes(snapshot()));
    execFileSync(process.execPath, ["--import", fileURLToPath(import.meta.resolve("tsx")), "tests/queue-fixture.ts", source, build], {
        cwd: fileURLToPath(new URL("../../../../packages/runner-sdk", import.meta.url)), timeout: 120000, stdio: "pipe",
    });
    const index = JSON.parse(await readFile(join(build, "index.json"), "utf8"));
    for (const file of index.inventory.engines[0].files) {
        await mkdir(dirname(join(release, file.path)), { recursive: true });
        await copyFile(join(build, file.sha256), join(release, file.path));
    }
    await writeFile(join(release, "inventory.json"), canonicalBytes(index.inventory));
    const approved = await loadRelease(release, "0.1.0");
    const distribution: EngineDistribution = {
        engineVersion: "0.1.0", runnerSdkVersion: "0.1.0", dependencies: approved.entry.dependencies,
        packageJson: approved.files["package.json"]!, packageLock: approved.files["package-lock.json"]!,
        files: Object.fromEntries(Object.entries(approved.files).filter(([path]) => path.startsWith("vendor/"))),
    };
    if (process.platform === "darwin") console.log(JSON.stringify({ businessEngine: { inventorySha256: hash(await readFile(join(release, "inventory.json"))), engineVersion: approved.entry.engineVersion, compilerVersion: approved.entry.compilerVersion, dependencies: approved.entry.dependencies.length, files: approved.entry.files.length } }));
    await rm(build, { recursive: true, force: true });
    return { release, distribution };
}

/** 在线夹具沿用原 physical 测试的真实内容下载、设备会话及上传摘要核验，观察回调只在清理前读取真实证据；connectFailure 只影响断言预期，不伪造完成清单、受控证明、报告内容或服务容量事实。 */
export async function onlineBusiness(options: {
    browserExecutable?: string;
    darwinSource?: DarwinSourceCapability;
    connectFailure?: boolean;
    signal?: AbortSignal;
    expectCancelled?: boolean;
    expectIncomplete?: boolean;
    expectedStop?: boolean;
    onPage?: () => void;
    inspect?: (value: { result: AttemptResult; uploads: Map<string, { bytes: Buffer; sha256: string; filename: string }>; events: Record<string, unknown>[]; root: string; run: number; supervisor: ExecutionSupervisor }) => Promise<void>;
} = {}) {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'veriq-t10-physical-'));
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
        if (options.onPage) { options.onPage(); return; }
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
    let retainRoot = false;
    try {
        const { release, distribution } = await buildBusinessEngine(root);
        const source = snapshot([{ id: 'open', action: 'goto', path: '/' }, { id: 'status', action: 'apiRequest', method: 'GET', path: '/status', observers: [{ id: 'response', method: 'GET', path: '/status', window: { mode: 'UNTIL_ACTION_SETTLED', quietMs: 0 } }], afterAssertions: [{ id: 'ready', type: 'responseField', source: 'response:response', pointer: '/ok', operator: 'equals', expected: true, severity: 'BLOCK', expectedSource: 'REQ-ready' }] }], [asset(3, 'FIXTURE', { schemaVersion: '1.0', prepare: { method: 'POST', path: '/prepare' }, query: { method: 'GET', path: '/query' }, cleanup: { method: 'POST', path: '/cleanup' }, inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, ttlSeconds: 60 })], { fixtureVersionId: id(3) });
        const output = compileFiles(source, distribution!);
        const store = new DeviceStore(join(root, 'device'));
        await store.save({ server: origin, runnerId: id(70), workspaceId: id(99), deviceToken: currentToken, expiresAt: '2027-01-01T00:00:00Z' });
        session = new DeviceSession(store, new RuntimeClient(origin));
        await session.open();
        const supervisor = new ExecutionSupervisor({ root: join(root, 'agent'), client: new AgentClient(session), releaseDirectory: release, browserExecutable: options.browserExecutable ?? '/usr/bin/chromium', ...(options.darwinSource ? { darwinSource: options.darwinSource } : {}) });
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
            let result: AttemptResult;
            try { result = await supervisor.runAttempt({ claim, requestStarted: performance.now(), responseReceived: performance.now() }, options.signal ?? new AbortController().signal); }
            catch (error) {
                if (!options.darwinSource) throw error;
                retainRoot = true;
                await emitBusinessDiagnostic("ONLINE", join(root, "agent/work", claim.attemptId), { rejected: true, stop: { reason: error instanceof Error ? error.message : undefined } });
                throw new Error("NATIVE_ONLINE_RUN_FAILED");
            }
            if (options.darwinSource && !result.stop.processStopped) retainRoot = true;
            results.push(result);
            if (options.darwinSource) await emitBusinessDiagnostic("ONLINE", join(root, "agent/work", claim.attemptId), result);
            await options.inspect?.({ result, uploads, events, root, run, supervisor });
            if (!result.completion && !options.darwinSource) {
                try { process.stderr.write('guardian: '+await readFile(join(root,'agent/processes',claim.attemptId+'.drained.json.error'),'utf8')); } catch {}
                for (const file of ['worker-failure.json', 'worker-result.json', 'tmp/playwright.json'])
                    try {
                        const diagnostic = await readFile(join(root, 'agent/work', claim.attemptId, file), 'utf8');
                        process.stderr.write(file + ': ' + diagnostic.slice(0, 16000) + '\n');
                    }
                    catch { }
            }
            if (options.expectIncomplete) {
                assert.equal(result.completion, undefined);
                if (options.expectedStop !== undefined) assert.equal(result.stop.processStopped, options.expectedStop);
                assert.notEqual(result.stop.processStopScope, "NO_PROCESS_SPAWNED");
                break;
            }
            if (options.expectCancelled) {
                assert.equal(result.stop.processStopped, true);
                assert.equal(result.stop.processStopScope, "CONTROLLED_WORKER_BROWSER");
                if (result.completion) assert.equal(result.completion.businessOutcome, "CANCELLED");
                break;
            }
            if (options.connectFailure) {
                assert.equal(result.completion, undefined);
                assert.equal(result.stop.processStopped, true);
                assert.equal(result.stop.processStopScope, "CONTROLLED_WORKER_BROWSER");
                break;
            }
            assert(result.completion, options.darwinSource ? "Missing actual completion; see bounded business diagnostics" : `missing actual completion: ${JSON.stringify(result.stop)}`);
            assert.equal(result.stop.processStopped, true);
            assert.equal(result.stop.processStopScope, (options.darwinSource ? "CONTROLLED_WORKER_BROWSER" : "FULL_DESCENDANT_TREE"));
            assert.equal(result.completion.processStopScope, result.stop.processStopScope);
            assert(result.files.some(f => f.kind === 'TRACE' && f.file.sensitivity === 'CREDENTIAL_RESTRICTED' && f.file.sizeBytes > 0));
            assert.deepEqual(supervisor.processes.active(), []);
            await rm(join(root, 'agent/work', claim.attemptId), { recursive: true, force: true });
        }
        if (options.connectFailure || options.expectCancelled || options.expectIncomplete) return;
        assert.equal(serviceWorkerHits, 0);
        loseActivation = true;
        const lost = { ...previous!, attemptId: id(84), serverTime: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() };
        const recovered = await supervisor.runAttempt({ claim: lost, requestStarted: performance.now(), responseReceived: performance.now() }, new AbortController().signal);
        assert.equal(recovered.completion, undefined);
        assert.equal(recovered.stop.processStopped, true);
        assert.equal(recovered.stop.reason, 'NETWORK_UNAVAILABLE');
        assert.equal(recovered.stop.processStopScope, 'NO_PROCESS_SPAWNED');
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
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (options.darwinSource && retainRoot) console.log(JSON.stringify({ onlineFixtureCleanup: { retained: true, processStopUnconfirmed: true } }));
        else await rm(root, { recursive: true, force: true });
    }
}

/** 业务夹具在创建执行 Promise 的同一同步轮次安装完成与拒绝观察，readiness 不能单独等待而忽略提前结束或 Node 测试取消；原异常仅留在内存，固定阶段错误交给 TAP，避免私有控制内容被原始 message、cause 或堆栈片段带入日志。 */
export function watchBusinessRun<T>(running: Promise<T>, signal: AbortSignal) {
    const outcome = running.then(
        (value) => ({ state: "fulfilled" as const, value }),
        (error: unknown) => ({ state: "rejected" as const, error }),
    );
    let cancelled!: () => void;
    const cancellation = new Promise<{ state: "cancelled" }>((resolve) => { cancelled = () => resolve({ state: "cancelled" }); });
    signal.addEventListener("abort", cancelled, { once: true });
    if (signal.aborted) cancelled();
    return {
        outcome,
        async waitFor(readiness: Promise<unknown>, phase: "BARRIER" | "STOP"): Promise<void> {
            if (signal.aborted) throw new Error("BUSINESS_TEST_CANCELLED");
            const value = await Promise.race([cancellation, outcome, readiness.then(() => ({ state: "ready" as const }), () => ({ state: "readiness-failed" as const }))]);
            if (value.state === "ready") return;
            if (value.state === "cancelled") throw new Error("BUSINESS_TEST_CANCELLED");
            if (value.state === "readiness-failed") throw new Error("BUSINESS_READINESS_REJECTED");
            throw new Error(value.state === "fulfilled" ? `BUSINESS_RUN_COMPLETED_BEFORE_${phase}` : `BUSINESS_RUN_REJECTED_BEFORE_${phase}`);
        },
        async result(): Promise<T> {
            const value = await outcome;
            if (value.state === "rejected") throw new Error("BUSINESS_RUN_REJECTED");
            return value.value;
        },
        close(): void { signal.removeEventListener("abort", cancelled); },
    };
}

/** 诊断仅投影受信 worker 的固定阶段枚举、业务枚举与布尔事实，私有 JSON 读取先限制六万五千字节再解析；随机控制绑定、原始错误、配置正文及路径均不输出，未知代码用 OTHER 表示而不把来源字符串直接复制到日志。 */
export async function emitBusinessDiagnostic(phase: "ONLINE" | "OFFLINE" | "WORKER_EXIT", work: string, result: unknown): Promise<void> {
    if (process.platform !== "darwin") return;
    const choices = new Set(["PASSED", "FAILED", "ERROR", "CANCELLED", "INCOMPLETE", "UNSTABLE", "CONTROLLED_WORKER_BROWSER", "FULL_DESCENDANT_TREE", "NO_PROCESS_SPAWNED", "READY", "TEST", "VALIDATE", "CLEANUP", "SPAWNING", "RUNNING", "STOPPED", "INSTALL_FAILED", "COMPILER_EXTRACTION_FAILED", "COMPILER_PROCESS_FAILED", "PLAYWRIGHT_PROCESS_FAILED", "CONTROLLED_COMMAND_MANAGEMENT_FAILED", "PROCESS_STOP_UNCONFIRMED", "MISSING_CASE_RESULT", "DARWIN_CONTROLLED_START_FAILED", "DARWIN_ATTEMPT_STOPPING", "USER_CANCELLED", "COMPLETED", "EXECUTION_ERROR", "LOCAL_CANCELLATION_READ_FAILED", "REQUIRED_EVIDENCE_MISSING", "WORKER_COMMAND_FAILED", "PLAYWRIGHT_PROCESS_FAILED", "COMPILED_PROVENANCE_MISMATCH", "COMPILATION_FAILED", "UNKNOWN_ELEMENT", "ASSET_VALIDATION_FAILED", "INVALID_COMPLETION", "INVALID_EXECUTION_SNAPSHOT", "INVALID_COMPILED_BUNDLE", "UNAPPROVED_ENGINE_BYTES", "OFFLINE_EXECUTION_ERROR", "LOCAL_OWNERSHIP_LOST", "CONTROLLED_OWNER_MISMATCH", "WORKER_COMMAND_TIMEOUT", "INVALID_CREDENTIAL", "AUTH_IDENTITY_FAILED"]);
    const fixed = (value: unknown) => typeof value === "string" && choices.has(value) ? value : value === undefined ? "ABSENT" : "OTHER";
    const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
    const read = async (name: string) => {
        let present = false;
        try {
            const path = join(work, name), info = await (await import("node:fs/promises")).lstat(path);
            present = true;
            if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) return { present, readable: false, data: {} as Record<string, unknown> };
            return { present, readable: true, data: object(JSON.parse((await readBoundedFile(path, 65536, true)).toString("utf8"))) };
        } catch { return { present, readable: false, data: {} as Record<string, unknown> }; }
    };
    const value = object(result), stop = object(value.stop), completion = object(value.completion);
    const attempts = Array.isArray(value.attempts) ? value.attempts : [];
    const attempt = object(attempts[0]);
    const worker = await read("worker-result.json"), failure = await read("worker-failure.json");
    const commandFacts: { readable: boolean; frames: number; intents: number; exits: number; seals: number; exitCodes: (number | null)[] } = { readable: false, frames: 0, intents: 0, exits: 0, seals: 0, exitCodes: [] };
    try {
        const path = join(dirname(dirname(work)), "controlled-journals", basename(work), "command.jsonl");
        const bytes = await readBoundedFile(path, 1024 * 1024, true);
        const lines = bytes.toString("utf8").trim().split("\n");
        if (lines.length > 4096) throw new Error("DIAGNOSTIC_FRAME_LIMIT");
        for (const line of lines) {
            const frame = object(JSON.parse(line));
            commandFacts.frames++;
            if (frame.type === "INTENT") commandFacts.intents++;
            if (frame.type === "SEAL") commandFacts.seals++;
            if (frame.type === "EXITED") {
                commandFacts.exits++;
                if (commandFacts.exitCodes.length < 8) commandFacts.exitCodes.push(typeof frame.exitCode === "number" && Number.isSafeInteger(frame.exitCode) ? frame.exitCode : null);
            }
        }
        commandFacts.readable = true;
    } catch { }
    console.log(JSON.stringify({ businessDiagnostic: {
        phase, runRejected: value.rejected === true, completion: !!value.completion, attempts: attempts.length,
        processStopped: phase === "WORKER_EXIT" ? null : phase === "ONLINE" ? stop.processStopped === true : attempt.processStopped === true,
        scope: fixed(phase === "ONLINE" ? stop.processStopScope : attempt.processStopScope),
        reason: fixed(phase === "ONLINE" ? stop.reason : attempt.failureCode), outcome: fixed(phase === "ONLINE" ? completion.businessOutcome : value.outcome),
        workerResultPresent: worker.present, workerResultReadable: worker.readable, workerKind: fixed(worker.data.kind), workerFailure: fixed(worker.data.failureCode),
        failurePresent: failure.present, failureReadable: failure.readable, failureCode: fixed(failure.data.failureCode), commandFacts,
    } }));
}
