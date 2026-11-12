import { test, mock } from "node:test";
import { updatePrivate } from "../src/offline/config.ts";
import { RuntimeClient, type DeviceConfig } from "../src/enrollment.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm, chmod, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { compileFiles, type EngineDistribution } from "@veriq/compiler";
import { canonicalBytes, assetSourceBytes } from "@veriq/contracts";
import { snapshot, asset, id } from "../../../packages/compiler/tests/helpers.ts";
import { verifyBundle } from "../src/offline/verify.ts";
import { TrustStore, type IssuerTrust } from "../src/offline/trust.ts";
import { SecretStore, SecretResolver } from "../src/credentials/store.ts";
const sha = (raw: Uint8Array) => createHash("sha256").update(raw).digest("hex");
async function cleanup(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.isDirectory()) await cleanup(join(path, entry.name));
    }
    await chmod(path, 0o700);
}
async function fixture(realDistribution?: EngineDistribution, baseURL = "https://business.test") {
    const dir = await mkdtemp(join(tmpdir(), "veriq-offline-")),
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
                                  expected: baseURL + "/",
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
        execFileSync("python", [
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
test("signed bytes require a separately trusted root; tamper/extra/link/portable-path collisions fail before publication", async () => {
    const f = await fixture();
    try {
        const bundle = await f.archive();
        const result = await verifyBundle(bundle, {
            trust: f.trust,
            destination: join(f.dir, "valid"),
        });
        assert.equal(result.revocationStatus, "UNKNOWN");
        assert.equal(result.formalGateEligible, false);
        assert.equal(await readFile(join(f.dir, "valid/value.txt"), "utf8"), "original");
        await assert.rejects(
            verifyBundle(bundle, {
                trust: new TrustStore(join(f.dir, "untrusted")),
                destination: join(f.dir, "no-root"),
            }),
            /ISSUER_NOT_TRUSTED/,
        );
        for (const options of [
            { mutate: true },
            { extra: "extra.txt" },
            { extra: "../escape" },
            { extra: "AUX.txt" },
            { extra: "ads:secret" },
            { extra: "trailing." },
            { extra: "back\\slash" },
            { duplicate: true },
            { link: true },
            { unsigned: true },
        ]) {
            const input = await f.archive(options);
            const destination = join(f.dir, "reject");
            await assert.rejects(verifyBundle(input, { trust: f.trust, destination }));
            await assert.rejects(stat(destination), { code: "ENOENT" });
        }
    } finally {
        await f.close();
    }
});
test("expiry and debug require explicit consent, revoked keys remain rejected; rotation cannot replace or roll back trust", async () => {
    const f = await fixture();
    try {
        const archive = await f.archive({ expired: true });
        await assert.rejects(
            verifyBundle(archive, {
                trust: f.trust,
                destination: join(f.dir, "expired"),
            }),
            /BUNDLE_EXPIRED/,
        );
        assert.equal(
            (
                await verifyBundle(archive, {
                    trust: f.trust,
                    destination: join(f.dir, "debug"),
                    debug: true,
                })
            ).debug,
            true,
        );
        const state = structuredClone(f.issuer);
        state.revision++;
        state.keys[0]!.revoked = true;
        // Authenticated exact-origin transport establishes complete rotation/revocation metadata.
        const replacement = generateKeyPairSync("ed25519")
            .publicKey.export({ format: "der", type: "spki" })
            .subarray(-32);
        state.keys.push({
            keyId: "key_2",
            algorithm: "Ed25519",
            publicKey: replacement.toString("base64"),
            fingerprint: sha(replacement),
            revoked: false,
        });
        const config = {
            server: "https://control.test",
            deviceToken: "synthetic-device",
        } as DeviceConfig;
        let remote = state;
        const request = mock.method(
            RuntimeClient.prototype,
            "request",
            async function (path: string, method: string, _body: unknown, token: string) {
                assert.equal(path, "/internal/v1/issuer");
                assert.equal(method, "GET");
                assert.equal(token, config.deviceToken);
                return remote;
            },
        );
        await f.trust.refresh(config);
        await assert.rejects(
            verifyBundle(archive, {
                trust: f.trust,
                destination: join(f.dir, "revoked"),
                debug: true,
            }),
            /ISSUER_KEY_REVOKED/,
        );
        remote = f.issuer;
        await assert.rejects(f.trust.refresh(config), /ISSUER_ROLLBACK/);
        await assert.rejects(
            f.trust.bind(f.issuer, "https://control.test", f.issuer.keys[0]!.fingerprint),
            /ISSUER_KEY_REVOKED/,
        );
        const altered = structuredClone(state);
        altered.revision++;
        altered.keys[0] = { ...state.keys[1]!, keyId: "key_1" };
        remote = altered;
        await assert.rejects(f.trust.refresh(config), /ISSUER_REPLACEMENT/);
        request.mock.restore();
    } finally {
        await f.close();
    }
});
test("restricted local mapping binds issuer/workspace/exact version and never falls back", async () => {
    const f = await fixture();
    try {
        const store = new SecretStore(join(f.dir, "credentials"));
        const ref = {
            issuerId: "test_issuer",
            workspaceId: "00000000-0000-4000-8000-000000000099",
            secretRef: "local",
            versionId: "00000000-0000-4000-8000-000000000001",
        };
        await store.set(ref, { token: "private-local-value" });
        const resolver = new SecretResolver(store),
            attempt = {
                issuerId: ref.issuerId,
                workspaceId: ref.workspaceId,
                secretVersions: [{ secretRef: ref.secretRef, versionId: ref.versionId }],
            };
        assert.deepEqual(await resolver.resolve(ref, attempt), {
            token: "private-local-value",
        });
        await assert.rejects(
            resolver.resolve({ ...ref, issuerId: "foreign" }, attempt),
            /CREDENTIAL_SCOPE_MISMATCH/,
        );
        await assert.rejects(
            store.resolve({
                ...ref,
                versionId: "00000000-0000-4000-8000-000000000002",
            }),
            /LOCAL_CREDENTIAL_MISSING/,
        );
        assert.equal((await stat(join(f.dir, "credentials/local-secrets.json"))).mode & 0o077, 0);
        await store.clear();
        await assert.rejects(store.resolve(ref), /LOCAL_CREDENTIAL_MISSING/);
        assert.equal((await f.trust.issuer("test_issuer")).issuerId, "test_issuer");
    } finally {
        await f.close();
    }
});

test("signed portable directory aliases and compressed oversize members are rejected before install", async () => {
    const f = await fixture();
    try {
        const collision = await f.archive({ directoryCollision: true });
        await assert.rejects(
            verifyBundle(collision, {
                trust: f.trust,
                destination: join(f.dir, "collision"),
            }),
            /UNSAFE_ARCHIVE/,
        );
        const bomb = await f.archive({ payload: Buffer.alloc(17 * 1024 * 1024) });
        await assert.rejects(
            verifyBundle(bomb, { trust: f.trust, destination: join(f.dir, "bomb") }),
            /UNSAFE_ARCHIVE/,
        );
    } finally {
        await f.close();
    }
});

test("OOB fingerprint never admits appended signers or their unsigned revision", async () => {
    const f = await fixture();
    try {
        const attacker = generateKeyPairSync("ed25519");
        const raw = attacker.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
        const injected = {
            ...f.issuer,
            revision: 999999,
            keys: [
                ...f.issuer.keys,
                {
                    keyId: "attacker",
                    algorithm: "Ed25519" as const,
                    publicKey: raw.toString("base64"),
                    fingerprint: sha(raw),
                    revoked: false,
                },
            ],
        };
        for (const trust of [new TrustStore(join(f.dir, "first-bind")), f.trust]) {
            await trust.bind(injected, "https://control.test", f.issuer.keys[0]!.fingerprint);
            const input = await f.archive({
                signing: { keyId: "attacker", privateKey: attacker.privateKey },
            });
            const destination = join(f.dir, "injected");
            await assert.rejects(verifyBundle(input, { trust, destination }), /ISSUER_KEY/);
            await assert.rejects(stat(destination), { code: "ENOENT" });
            assert.notEqual((await trust.issuer(f.issuer.issuerId)).revision, injected.revision);
        }
    } finally {
        await f.close();
    }
});

for (const inconsistent of [
    "entries",
    "adapter",
    "engine",
    "entrypoints",
    "entrypath",
    "suiteSwap",
    "validationOnly",
    "dependencies",
] as const) {
    test(`signed inconsistent ${inconsistent} is rejected before install`, async () => {
        const f = await fixture();
        try {
            if (inconsistent === "suiteSwap") {
                const positive = await verifyBundle(await f.archive({ suite: true }), {
                    trust: f.trust,
                    destination: join(f.dir, "suite-positive"),
                });
                assert.deepEqual(positive.snapshot.entryCaseVersionIds, [id(1), id(10)]);
            }
            const input = await f.archive({ inconsistent }),
                destination = join(f.dir, "semantic");
            await assert.rejects(verifyBundle(input, { trust: f.trust, destination }), /BUNDLE_/);
            await assert.rejects(stat(destination), { code: "ENOENT" });
        } finally {
            await f.close();
        }
    });
}

test("unsigned metadata cannot poison authenticated revisions; legacy revocations deny aliases after rebind", async () => {
    const f = await fixture();
    try {
        const rotated = generateKeyPairSync("ed25519"),
            raw = rotated.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
        const key = {
            keyId: "rotation",
            algorithm: "Ed25519" as const,
            publicKey: raw.toString("base64"),
            fingerprint: sha(raw),
            revoked: false,
        };
        await f.trust.bind(
            {
                ...f.issuer,
                revision: Number.MAX_SAFE_INTEGER,
                keys: [...f.issuer.keys, key],
            },
            "https://control.test",
            f.issuer.keys[0]!.fingerprint,
        );
        const config = {
            server: "https://control.test",
            deviceToken: "synthetic-device",
        } as DeviceConfig;
        const request = mock.method(RuntimeClient.prototype, "request", async () => ({
            ...f.issuer,
            revision: 2,
            keys: [...f.issuer.keys, key],
        }));
        try {
            await f.trust.refresh(config);
        } finally {
            request.mock.restore();
        }
        const archive = await f.archive({
            signing: { keyId: key.keyId, privateKey: rotated.privateKey },
        });
        await verifyBundle(archive, {
            trust: f.trust,
            destination: join(f.dir, "rotated"),
        });
        const directory = join(f.dir, "legacy"),
            legacy = new TrustStore(directory);
        await updatePrivate(directory, "trust.json", () => ({
            origins: { "https://control.test": f.issuer.issuerId },
            issuers: {
                [f.issuer.issuerId]: {
                    ...f.issuer,
                    keys: [{ ...f.issuer.keys[0]!, revoked: true }, key],
                },
            },
        }));
        await assert.rejects(legacy.issuer(f.issuer.issuerId), /ISSUER_NOT_TRUSTED/);
        await legacy.bind({ ...f.issuer, keys: [key] }, "https://control.test", key.fingerprint);
        await assert.rejects(
            legacy.bind(
                {
                    issuerId: "renamed",
                    revision: 999,
                    keys: [{ ...f.issuer.keys[0]!, keyId: "alias" }],
                },
                "https://control.test",
                f.issuer.keys[0]!.fingerprint,
            ),
            /ISSUER_KEY_REVOKED/,
        );
        assert.deepEqual((await legacy.issuer(f.issuer.issuerId)).keys, [key]);
    } finally {
        await f.close();
    }
});

test("execution boundary rechecks signed installed bytes instead of trusting a VerifiedBundle object", async () => {
    const { reverifyInstalled } = await import("../src/offline/verify.ts");
    const f = await fixture();
    try {
        const bundle = await verifyBundle(await f.archive(), {
            trust: f.trust,
            destination: join(f.dir, "installed"),
        });
        const checked = await reverifyInstalled(bundle.directory, { trust: f.trust });
        assert.equal(checked.manifest.bundleId, bundle.manifest.bundleId);
        const member = bundle.manifest.files.find((f) => f.path.endsWith(".test.ts"))!;
        await chmod(join(bundle.directory, member.path), 0o600);
        await writeFile(join(bundle.directory, member.path), 'console.log("tampered")');
        await assert.rejects(
            reverifyInstalled(bundle.directory, { trust: f.trust }),
            /BUNDLE_(HASH|SIZE)_MISMATCH/,
        );
    } finally {
        await f.close();
    }
});
test("disconnected missing credential failure is durable without a platform request", async () => {
    const { runOffline } = await import("../src/offline/run.ts");
    const { LocalStore } = await import("../src/offline/store.ts");
    const f = await fixture();
    try {
        const bundle = await verifyBundle(await f.archive(), {
            trust: f.trust,
            destination: join(f.dir, "run-bundle"),
        });
        const result = await runOffline(bundle, {
            trust: f.trust,
            root: join(f.dir, "local"),
            secrets: new SecretStore(join(f.dir, "secrets")),
            releaseDirectory: join(f.dir, "uninstalled"),
            browserExecutable: "/uninstalled",
            deviceId: id(90),
        });
        assert.equal(result.outcome, "ERROR");
        assert.equal(result.attempts[0]?.failureCode, "LOCAL_CREDENTIAL_MISSING");
        assert.equal(result.attempts[0]?.processStopped, true);
        const store = await LocalStore.open(join(f.dir, "local"));
        assert.deepEqual(store.result(result.workspaceId, result.localRunId), result);
        assert.equal(store.active(), undefined);
        assert.throws(() => store.result(id(999), result.localRunId), /LOCAL_RUN_NOT_FOUND/);
        store.close();
        const { uploadOffline } = await import("../src/offline/upload.ts");
        await assert.rejects(
            uploadOffline(join(f.dir, "local"), result.localRunId, {
                server: "http://127.0.0.1:1",
                workspaceId: result.workspaceId,
                deviceToken: "synthetic-offline-device",
            }),
            /UPLOAD_FAILED/,
        );
        const pending = await LocalStore.open(join(f.dir, "local"));
        assert.equal(pending.history(result.workspaceId)[0]!.uploadState, "PENDING");
        pending.close();
        const { createServer } = await import("node:http");
        let received = 0;
        let key = "";
        const transport = createServer(async (req, res) => {
            assert.equal(req.headers.authorization, "Bearer synthetic-offline-device");
            let body = "";
            for await (const chunk of req) body += chunk;
            const sent = JSON.parse(body);
            assert.equal(sent.localRunId, result.localRunId);
            key = String(req.headers["idempotency-key"]);
            received++;
            res.setHeader("content-type", "application/json");
            res.end(
                JSON.stringify({
                    data: {
                        id: id(88),
                        runId: id(89),
                        localRunId: result.localRunId,
                        source: "OFFLINE_IMPORT",
                        officialGatePassed: false,
                        duplicate: received > 1,
                    },
                }),
            );
        });
        await new Promise<void>((r) => transport.listen(0, "127.0.0.1", r));
        try {
            const uploadConfig = {
                server: `http://127.0.0.1:${(transport.address() as { port: number }).port}`,
                workspaceId: result.workspaceId,
                deviceToken: "synthetic-offline-device",
            };
            const first = await uploadOffline(
                join(f.dir, "local"),
                result.localRunId,
                uploadConfig,
            );
            const repeated = await uploadOffline(
                join(f.dir, "local"),
                result.localRunId,
                uploadConfig,
            );
            assert.equal(first.runId, repeated.runId);
            assert.equal(key, "offline_" + result.localRunId);
            assert.equal(received, 2);
        } finally {
            await new Promise<void>((r) => transport.close(() => r()));
        }
    } finally {
        await f.close();
    }
});

test(
    "actual disconnected worker executes signed immutable source with Chromium and keeps raw Trace after reopen",
    { timeout: 180000 },
    async () => {
        const { createServer } = await import("node:http");
        const { mkdir, copyFile } = await import("node:fs/promises");
        const { dirname } = await import("node:path");
        const { fileURLToPath } = await import("node:url");
        const { runOffline } = await import("../src/offline/run.ts");
        const { loadRelease } = await import("../src/execution/release.ts");
        const { LocalStore } = await import("../src/offline/store.ts");
        let hang = false,
            failPage = 0;
        let observed: () => void = () => {};
        const server = createServer((req, res) => {
            if (hang && req.url === "/") {
                observed();
                return;
            }
            if (req.url === "/" && failPage > 0) {
                failPage--;
                res.statusCode = 302;
                res.setHeader("location", "/wrong");
                res.end();
                return;
            }
            if (req.url === "/me") {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ id: "reader" }));
            } else {
                res.setHeader("content-type", "text/html");
                res.end("<h1>VeriQ offline business</h1>");
            }
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
        const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const root = await mkdtemp(join(tmpdir(), "veriq-offline-real-"));
        let f: Awaited<ReturnType<typeof fixture>> | undefined;
        try {
            const source = join(root, "source.json"),
                build = join(root, "build"),
                release = join(root, "release");
            await writeFile(source, canonicalBytes(snapshot()));
            execFileSync(
                process.execPath,
                [
                    "--import",
                    fileURLToPath(import.meta.resolve("tsx")),
                    "tests/queue-fixture.ts",
                    source,
                    build,
                ],
                {
                    cwd: fileURLToPath(new URL("../../../packages/runner-sdk", import.meta.url)),
                    timeout: 120000,
                    stdio: "pipe",
                },
            );
            const index = JSON.parse(await readFile(join(build, "index.json"), "utf8"));
            for (const file of index.inventory.engines[0].files) {
                await mkdir(dirname(join(release, file.path)), { recursive: true });
                await copyFile(join(build, file.sha256), join(release, file.path));
            }
            await writeFile(join(release, "inventory.json"), canonicalBytes(index.inventory));
            const approved = await loadRelease(release, "0.1.0");
            const distribution = {
                engineVersion: "0.1.0",
                runnerSdkVersion: "0.1.0",
                dependencies: approved.entry.dependencies,
                packageJson: approved.files["package.json"]!,
                packageLock: approved.files["package-lock.json"]!,
                files: Object.fromEntries(
                    Object.entries(approved.files).filter(([path]) => path.startsWith("vendor/")),
                ),
            };
            f = await fixture(distribution, baseURL);
            const bundle = await verifyBundle(await f.archive(), {
                trust: f.trust,
                destination: join(f.dir, "installed"),
            });
            const secrets = new SecretStore(join(f.dir, "secrets"));
            await secrets.set(
                {
                    issuerId: f.issuer.issuerId,
                    workspaceId: id(99),
                    secretRef: "reader",
                    versionId: id(14),
                },
                { token: "local-test-only" },
            );
            const result = await runOffline(bundle, {
                trust: f.trust,
                root: join(f.dir, "local"),
                secrets,
                releaseDirectory: release,
                browserExecutable: process.env.VERIQ_TEST_CHROMIUM ?? "/usr/bin/chromium",
                deviceId: id(90),
            });
            assert.equal(
                result.outcome,
                "PASSED",
                JSON.stringify(
                    result.attempts.map((a) => ({
                        outcome: a.outcome,
                        failure: a.failureCode,
                        events: a.events,
                    })),
                ),
            );
            assert.equal(result.attempts[0]!.processStopped, true);
            assert.equal(result.revocationStatus, "UNKNOWN");
            const trace = result.attempts[0]!.artifacts.find((a) => a.kind === "TRACE");
            assert(trace);
            const { LocalReports } = await import("../src/offline/reports.ts");
            const reports = new LocalReports(join(f.dir, "local"), () => true);
            const reportSnapshot = await reports.snapshot(result.workspaceId, result.localRunId);
            assert.equal(reportSnapshot.reports[0]!.gateNow.passed, false);
            assert.equal(reportSnapshot.reports[0]!.statistics.firstPassCount, 1);
            const { LocalReportAdapter } = await import(
                new URL("../../web/src/features/reports/adapters.ts", import.meta.url).href
            );
            const adapter = new LocalReportAdapter(reportSnapshot);
            assert.equal((await adapter.report(result.localRunId)).run.id, result.localRunId);
            assert.equal(
                (await adapter.display(result.localRunId, result.attempts[0]!.attemptId))
                    .metadataStatus,
                "AVAILABLE",
            );
            assert.equal(
                reportSnapshot.history[result.attempts[0]!.attemptId]!.length,
                result.attempts[0]!.lastSequence,
            );
            assert.equal(
                sha(
                    await reports.readRaw(
                        result.workspaceId,
                        result.localRunId,
                        result.attempts[0]!.attemptId,
                        trace.artifactId!,
                    ),
                ),
                trace.sha256,
            );
            await assert.rejects(
                new LocalReports(join(f.dir, "local"), () => false).readRaw(
                    result.workspaceId,
                    result.localRunId,
                    result.attempts[0]!.attemptId,
                    trace.artifactId!,
                ),
                /RAW_EVIDENCE_FORBIDDEN/,
            );

            const bytes = await readFile(
                join(f.dir, "local", "work", result.attempts[0]!.attemptId, "evidence", trace.path),
            );
            assert.equal(sha(bytes), trace.sha256);
            const store = await LocalStore.open(join(f.dir, "local"));
            assert.deepEqual(store.result(result.workspaceId, result.localRunId), result);
            store.close();
            const debug = await verifyBundle(await f.archive({ dslOnly: true }), {
                trust: f.trust,
                destination: join(f.dir, "draft"),
                debug: true,
            });
            const debugResult = await runOffline(debug, {
                trust: f.trust,
                root: join(f.dir, "local"),
                secrets,
                releaseDirectory: release,
                browserExecutable: process.env.VERIQ_TEST_CHROMIUM ?? "/usr/bin/chromium",
                deviceId: id(90),
                debug: true,
            });
            assert.equal(
                debugResult.outcome,
                "PASSED",
                JSON.stringify(
                    debugResult.attempts.map((a) => ({
                        outcome: a.outcome,
                        failure: a.failureCode,
                    })),
                ),
            );
            assert.equal(debugResult.dirty, true);
            assert.equal(debugResult.attempts[0]!.sourceKind, "DRAFT_DEBUG");
            const invalid = await verifyBundle(await f.archive({ dslOnly: true, dslError: true }), {
                trust: f.trust,
                destination: join(f.dir, "invalid-draft"),
                debug: true,
            });
            const invalidResult = await runOffline(invalid, {
                trust: f.trust,
                root: join(f.dir, "local"),
                secrets,
                releaseDirectory: release,
                browserExecutable: process.env.VERIQ_TEST_CHROMIUM ?? "/usr/bin/chromium",
                deviceId: id(90),
                debug: true,
            });
            assert.equal(invalidResult.outcome, "ERROR");
            assert.equal(invalidResult.attempts[0]!.failureCode, "UNKNOWN_ELEMENT");
            assert.equal(invalidResult.attempts[0]!.diagnostics?.[0]?.code, "UNKNOWN_ELEMENT");
            failPage = 1;
            const retried = await runOffline(bundle, {
                trust: f.trust,
                root: join(f.dir, "local"),
                secrets,
                releaseDirectory: release,
                browserExecutable: process.env.VERIQ_TEST_CHROMIUM ?? "/usr/bin/chromium",
                deviceId: id(90),
                retry: true,
            });
            assert.equal(
                retried.outcome,
                "UNSTABLE",
                JSON.stringify(
                    retried.attempts.map((a) => ({
                        outcome: a.outcome,
                        failure: a.failureCode,
                        retry: a.retrySafety,
                    })),
                ),
            );
            assert.equal(retried.attempts.length, 2);
            assert.notEqual(
                retried.attempts[0]!.execution!.namespace,
                retried.attempts[1]!.execution!.namespace,
            );
            hang = true;
            let reached = new Promise<void>((resolve) => {
                observed = resolve;
            });
            const cancelled = runOffline(bundle, {
                trust: f.trust,
                root: join(f.dir, "local"),
                secrets,
                releaseDirectory: release,
                browserExecutable: process.env.VERIQ_TEST_CHROMIUM ?? "/usr/bin/chromium",
                deviceId: id(90),
            });
            await reached;
            const cancellationStore = await LocalStore.open(join(f.dir, "local"));
            const active = cancellationStore.active()!;
            cancellationStore.cancel(active.workspaceId, active.runId);
            cancellationStore.close();
            const cancelledResult = await cancelled;
            assert.equal(cancelledResult.outcome, "CANCELLED");
            assert.equal(cancelledResult.attempts[0]!.processStopped, true);
            const { spawn } = await import("node:child_process");
            reached = new Promise<void>((resolve) => {
                observed = resolve;
            });
            const script = `import {runOffline} from './src/offline/run.ts';import {TrustStore} from './src/offline/trust.ts';import {SecretStore} from './src/credentials/store.ts';const [directory,profile,root,release,browser,device]=process.argv.slice(1);await runOffline({directory},{trust:new TrustStore(profile),root,secrets:new SecretStore(profile+'/../secrets'),releaseDirectory:release,browserExecutable:browser,deviceId:device});`;
            const parent = spawn(
                process.execPath,
                [
                    "--import",
                    "tsx",
                    "--input-type=module",
                    "-e",
                    script,
                    bundle.directory,
                    join(f.dir, "trust"),
                    join(f.dir, "local"),
                    release,
                    process.env.VERIQ_TEST_CHROMIUM ?? "/usr/bin/chromium",
                    id(90),
                ],
                { stdio: ["ignore", "pipe", "pipe"] },
            );
            const exited = new Promise<void>((resolve) => parent.once("exit", () => resolve()));
            await Promise.race([
                reached,
                exited.then(() => {
                    throw new Error("OFFLINE_PARENT_EXITED_BEFORE_BUSINESS");
                }),
            ]);
            parent.kill("SIGKILL");
            await exited;
            const { recoverOffline } = await import("../src/offline/run.ts");
            const recovered = await recoverOffline(join(f.dir, "local"));
            assert.equal(recovered?.processStopped, true);
            const recoveredStore = await LocalStore.open(join(f.dir, "local"));
            assert.equal(recoveredStore.active(), undefined);
            assert(recoveredStore.history(id(99)).some((r) => r.state === "FINISHED"));
            recoveredStore.close();
        } finally {
            await f?.close();
            await rm(root, { recursive: true, force: true });
            await new Promise<void>((r) => server.close(() => r()));
        }
    },
);
