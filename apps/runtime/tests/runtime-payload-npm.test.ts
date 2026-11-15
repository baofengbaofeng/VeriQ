import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyRuntimePayloadInputs } from "../scripts/runtime-payload-inputs.ts";
import { intakeRuntimeArchives } from "../scripts/runtime-payload-archive.ts";
import { ArchiveTransaction } from "../scripts/runtime-payload-transaction.ts";
import { projectNpm } from "../scripts/runtime-payload-npm.ts";
import { fixture, hash } from "./fixtures/runtime-payload.ts";
import { stageModel, rehashStageNpm } from "./fixtures/runtime-payload-stage.ts";

test("npm physically projects real package bytes before shared package content verification", async () => {
    const output = await mkdtemp(join(tmpdir(), "veriq-npm-"));
    try {
        await fixture(
            async (f) => {
                const report = await verifyRuntimePayloadInputs(await f.save(), f.expected, {
                    inputRoot: f.root,
                });
                const intake = await intakeRuntimeArchives(await f.save(), f.expected, {
                    inputRoot: f.root,
                    outputParent: output,
                    candidateName: "intake",
                });
                const tx = new ArchiveTransaction(f.root, output, "work", undefined, "work");
                try {
                    await tx.initialize();
                    const projection = await projectNpm(report, intake, tx);
                    assert.equal(projection.inventory.files.length, 2);
                    assert.equal(projection.tree.root, "views");
                    await tx.audit();
                } finally {
                    await tx.cleanup();
                }
            },
            await stageModel(),
        );
    } finally {
        await rm(output, { recursive: true, force: true });
    }
});

// 每个 npm 物理投影场景都使用真实 fresh intake 和独立工作事务，清理只针对本场景根；坏 ownTree 或 package 声明必须在共享内容 helper 读到真实正文后拒绝，不能被已有静态 graph 声明或原输入同名路径代替。
async function projectionCase(
    run: (value: Awaited<ReturnType<typeof stageModel>>) => void,
    inspect: (
        projection: Awaited<ReturnType<typeof projectNpm>>,
        tx: ArchiveTransaction,
    ) => Promise<void>,
    error?: string,
) {
    const value = await stageModel();
    run(value);
    const output = await mkdtemp(join(tmpdir(), "veriq-npm-case-"));
    try {
        await fixture(async (f) => {
            const bytes = await f.save(),
                report = await verifyRuntimePayloadInputs(bytes, f.expected, { inputRoot: f.root });
            const intake = await intakeRuntimeArchives(bytes, f.expected, {
                inputRoot: f.root,
                outputParent: output,
                candidateName: "intake",
            });
            const tx = new ArchiveTransaction(f.root, output, "work", undefined, "work");
            try {
                await tx.initialize();
                if (error) await assert.rejects(projectNpm(report, intake, tx), { code: error });
                else {
                    const projection = await projectNpm(report, intake, tx);
                    await inspect(projection, tx);
                    await tx.audit();
                }
            } finally {
                await tx.cleanup();
            }
        }, value);
    } finally {
        await rm(output, { recursive: true, force: true });
    }
}

test("npm wrong ownTree rejects actual content", async () =>
    projectionCase(
        (value) => {
            value.nodeReceipt.npmGraph.instances[0]!.ownTreeSha256 = "e".repeat(64);
        },
        async () => {},
        "PAYLOAD_GRAPH_MISMATCH",
    ));
test("npm optional peer declaration requires exact real package edge", async () =>
    projectionCase(
        (value) => {
            value.nodeEntries.find((entry) => entry.path.endsWith("/npm/package.json"))!.body =
                JSON.stringify({
                    name: "npm",
                    version: "11.0.0",
                    bin: { npm: "bin/npm-cli.js" },
                    peerDependencies: { host: "^1" },
                    peerDependenciesMeta: { host: { optional: true } },
                });
            rehashStageNpm(value);
        },
        async () => {},
        "PAYLOAD_GRAPH_MISMATCH",
    ));

test("npm ordinary file-link multi-hop materializes terminal bytes with every raw origin", async () =>
    projectionCase(
        (value) => {
            const root = value.nodeReceipt.npmRoot;
            value.nodeEntries.push(
                { path: `${root}/copy-a.js`, kind: "link", target: "copy-b.js" },
                { path: `${root}/copy-b.js`, kind: "link", target: "bin/npm-cli.js" },
            );
            rehashStageNpm(value);
        },
        async (projection, tx) => {
            const { readFile, lstat } = await import("node:fs/promises");
            assert.equal(
                await readFile(join(tx.scratch, "views/npm/copy-a.js"), "utf8"),
                "export {};\n",
            );
            assert.ok((await lstat(join(tx.scratch, "views/npm/copy-a.js"))).isFile());
            const origins = projection.files.find(
                (file) => file.fact.path === "npm/copy-a.js",
            )!.origins;
            assert.equal(origins.length, 3);
            assert.equal(origins[0]!.sha256, hash(Buffer.from("copy-b.js")));
            assert.equal(origins[1]!.sha256, hash(Buffer.from("bin/npm-cli.js")));
        },
    ));

test("npm bin source alias becomes physical normalized audited work-only symlink", async () =>
    projectionCase(
        (value) => {
            const bin = value.nodeReceipt.npmGraph.bins[0]!;
            bin.sourceAlias = bin.aliasPath;
            value.nodeEntries.push({
                path: `${value.nodeReceipt.npmRoot}/.bin/npm`,
                kind: "link",
                target: "../bin/npm-cli.js",
            });
            rehashStageNpm(value);
        },
        async (projection, tx) => {
            const { lstat, readlink } = await import("node:fs/promises");
            assert.ok((await lstat(join(tx.scratch, "views/npm/.bin/npm"))).isSymbolicLink());
            assert.equal(
                await readlink(join(tx.scratch, "views/npm/.bin/npm")),
                "../bin/npm-cli.js",
            );
            assert.equal(projection.inventory.links.length, 1);
        },
    ));

test("npm directory alias cannot be expanded as ordinary files", async () =>
    projectionCase(
        (value) => {
            value.nodeEntries.push({
                path: `${value.nodeReceipt.npmRoot}/directory-alias`,
                kind: "link",
                target: "bin",
            });
            value.nodeReceipt.inputLinks.push({
                path: `${value.nodeReceipt.npmRoot}/directory-alias`,
                target: "bin",
            });
            value.bind();
        },
        async () => {},
        "PAYLOAD_ARCHIVE_LINK",
    ));

for (const nativeMode of [0o755, 0o644])
    test(`npm native mode ${nativeMode.toString(8)} uses original evidence and requires execution permission`, async () => {
        const value = await stageModel();
        const { bytes } = await import("./fixtures/runtime-payload.ts");
        const targetPath = "npm/bin/native",
            body = "synthetic native executable",
            digest = hash(Buffer.from(body));
        value.nodeEntries.find((entry) => entry.path.endsWith("/npm/package.json"))!.body =
            JSON.stringify({
                name: "npm",
                version: "11.0.0",
                bin: { npm: "bin/npm-cli.js", native: "bin/native" },
            });
        value.nodeEntries.push({
            path: `${value.nodeReceipt.npmRoot}/bin/native`,
            body,
            mode: nativeMode,
        });
        const inspection = value.put(
            "projection-evidence/native-inspection.json",
            bytes({
                schemaVersion: 1,
                kind: "NATIVE_BIN_INSPECTION",
                platform: "darwin",
                arch: "x64",
                path: targetPath,
                sha256: digest,
                minimumOs: "15.0",
                inspectionEvidence: value.recipe.tools[0]!.evidence,
            }),
        );
        value.nodeReceipt.npmGraph.bins.push({
            owner: "p1",
            name: "native",
            aliasPath: "npm/.bin/native",
            sourceAlias: null,
            targetPath,
            targetSha256: digest,
            launcher: "native",
            inspection,
        });
        rehashStageNpm(value);
        const output = await mkdtemp(join(tmpdir(), "veriq-native-readers-"));
        try {
            await fixture(async (f) => {
                const report = await verifyRuntimePayloadInputs(await f.save(), f.expected, {
                    inputRoot: f.root,
                });
                const intake = await intakeRuntimeArchives(await f.save(), f.expected, {
                    inputRoot: f.root,
                    outputParent: output,
                    candidateName: "intake",
                });
                const tx = new ArchiveTransaction(f.root, output, "work", undefined, "work");
                try {
                    await tx.initialize();
                    await tx.write(
                        inspection.path,
                        (async function* () {
                            yield Buffer.from("wrong reader sentinel");
                        })(),
                    );
                    if (nativeMode === 0o644)
                        await assert.rejects(projectNpm(report, intake, tx), {
                            code: "PAYLOAD_BIN_UNSUPPORTED",
                        });
                    else {
                        const projection = await projectNpm(report, intake, tx);
                        assert.equal(
                            projection.inventory.files.find((file) => file.path === targetPath)!
                                .sha256,
                            digest,
                        );
                    }
                    await tx.audit();
                } finally {
                    await tx.cleanup();
                }
            }, value);
        } finally {
            await rm(output, { recursive: true, force: true });
        }
    });

test("npm bin multihop original aliases normalize physically but retain original source facts", async () =>
    projectionCase(
        (value) => {
            const bin = value.nodeReceipt.npmGraph.bins[0]!;
            bin.sourceAlias = bin.aliasPath;
            value.nodeEntries.push(
                {
                    path: `${value.nodeReceipt.npmRoot}/.bin/npm`,
                    kind: "link",
                    target: "../relay.js",
                },
                {
                    path: `${value.nodeReceipt.npmRoot}/relay.js`,
                    kind: "link",
                    target: "bin/npm-cli.js",
                },
            );
            rehashStageNpm(value);
        },
        async (projection, tx) => {
            const { readlink } = await import("node:fs/promises");
            assert.equal(
                await readlink(join(tx.scratch, "views/npm/.bin/npm")),
                "../bin/npm-cli.js",
            );
            assert.equal(
                projection.files.find((file) => file.fact.path === "npm/relay.js")!.origins.length,
                2,
            );
        },
    ));

test("npm same-name same-version peer instances preserve both physical contexts", async () =>
    projectionCase(
        (value) => {
            const graph = value.nodeReceipt.npmGraph,
                root = value.nodeReceipt.npmRoot;
            value.nodeEntries.find((entry) => entry.path.endsWith("/npm/package.json"))!.body =
                JSON.stringify({
                    name: "npm",
                    version: "11.0.0",
                    bin: { npm: "bin/npm-cli.js" },
                    dependencies: { left: "npm:peer-lib@1.0.0", right: "npm:peer-lib@1.0.0" },
                });
            for (const [side, instanceId, hostId, hostVersion] of [
                ["left", "p2", "p4", "1.0.0"],
                ["right", "p3", "p5", "2.0.0"],
            ] as const) {
                const path = `npm/node_modules/${side}`,
                    host = `${path}/node_modules/host`;
                for (const [packageRoot, id, name, version, manifest] of [
                    [
                        path,
                        instanceId,
                        "peer-lib",
                        "1.0.0",
                        { name: "peer-lib", version: "1.0.0", peerDependencies: { host: "*" } },
                    ],
                    [host, hostId, "host", hostVersion, { name: "host", version: hostVersion }],
                ] as const) {
                    value.nodeEntries.push(
                        {
                            path: `${root}/${packageRoot.slice(4)}/package.json`,
                            body: JSON.stringify(manifest),
                        },
                        {
                            path: `${root}/${packageRoot.slice(4)}/index.js`,
                            body: `module.exports='${id}';\n`,
                        },
                    );
                    graph.instances.push({
                        id,
                        root: packageRoot,
                        name,
                        version,
                        lockSnapshot: "temporary",
                        packageJson: { sizeBytes: 0, sha256: "a".repeat(64) },
                        ownTreeSha256: "a".repeat(64),
                    });
                }
                graph.edges.push(
                    {
                        from: "p1",
                        alias: side!,
                        kind: "dependency",
                        requested: "npm:peer-lib@1.0.0",
                        to: instanceId!,
                        absence: null,
                    },
                    {
                        from: instanceId!,
                        alias: "host",
                        kind: "peer",
                        requested: "*",
                        to: hostId!,
                        absence: null,
                    },
                );
                graph.resolutionProof.resolutions.push(
                    {
                        from: "p1",
                        consumer: "npm/package.json",
                        specifier: side!,
                        resolvedFile: `${path}/index.js`,
                        to: instanceId!,
                    },
                    {
                        from: instanceId!,
                        consumer: `${path}/package.json`,
                        specifier: "host",
                        resolvedFile: `${host}/index.js`,
                        to: hostId!,
                    },
                );
            }
            rehashStageNpm(value);
        },
        async (projection, tx) => {
            const { readFile, lstat } = await import("node:fs/promises");
            const left = join(tx.scratch, "views/npm/node_modules/left/index.js"),
                right = join(tx.scratch, "views/npm/node_modules/right/index.js");
            assert.equal(await readFile(left, "utf8"), "module.exports='p2';\n");
            assert.equal(await readFile(right, "utf8"), "module.exports='p3';\n");
            assert.notEqual((await lstat(left)).ino, (await lstat(right)).ino);
            assert.ok(
                projection.inventory.files.some((file) =>
                    file.path.endsWith("right/node_modules/host/package.json"),
                ),
            );
        },
    ));

test("npm unlisted package body cannot hide under parent node_modules", async () =>
    projectionCase(
        (value) => {
            value.nodeEntries.push({
                path: `${value.nodeReceipt.npmRoot}/node_modules/unlisted/package.json`,
                body: JSON.stringify({ name: "unlisted", version: "1.0.0" }),
            });
            rehashStageNpm(value);
        },
        async () => {},
        "PAYLOAD_GRAPH_MISMATCH",
    ));

test("npm root resolution requires actual ordinary consumer in physical projection", async () =>
    projectionCase(
        (value) => {
            const graph = value.nodeReceipt.npmGraph;
            graph.rootBindings.push({ consumer: "npm/missing.js", specifier: "npm", to: "p1" });
            graph.resolutionProof.resolutions.push({
                from: "$npm",
                consumer: "npm/missing.js",
                specifier: "npm",
                resolvedFile: "npm/bin/npm-cli.js",
                to: "p1",
            });
        },
        async () => {},
        "PAYLOAD_GRAPH_MISMATCH",
    ));

test("npm unknown node shebang rejects after binding the real target hash", async () =>
    projectionCase(
        (value) => {
            const entry = value.nodeEntries.find((member) =>
                member.path.endsWith("/npm/bin/npm-cli.js"),
            )!;
            entry.body = "#!/bin/sh\nexit 0\n";
            value.nodeReceipt.npmGraph.bins[0]!.targetSha256 = hash(Buffer.from(entry.body));
            rehashStageNpm(value);
        },
        async () => {},
        "PAYLOAD_BIN_UNSUPPORTED",
    ));
