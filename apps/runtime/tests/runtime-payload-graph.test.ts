import { symlink, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import {
    verifyRuntimePayloadInputs as verify,
    RuntimePayloadError,
} from "../scripts/runtime-payload-inputs.ts";
import { fixture, model, bytes, rehashPackages } from "./fixtures/runtime-payload.ts";
/**
 * 图反例始终保留真实包文件与正确外层摘要，只修改需要核对的关系记录；缺少逐声明边覆盖、实例身份、解析归属或 bin 包归属
 * 检查时，这些输入会被错误接受。
 */
const failure = (e: unknown) => e instanceof RuntimePayloadError;
const changes: Record<string, (f: ReturnType<typeof model>) => void> = {
    missingEdge: (f: ReturnType<typeof model>) => f.graph.edges.pop(),
    duplicateEdge: (f: ReturnType<typeof model>) => f.graph.edges.push({ ...f.graph.edges[0]! }),
    wrongVersion: (f: ReturnType<typeof model>) => (f.graph.instances[0]!.version = "9.0.0"),
    wrongPackageHash: (f: ReturnType<typeof model>) =>
        (f.graph.instances[0]!.ownTreeSha256 = "f".repeat(64)),
    binWrongOwner: (f: ReturnType<typeof model>) => (f.graph.bins[0]!.owner = "p2"),
    resolutionWrongOwner: (f: ReturnType<typeof model>) =>
        (f.graph.resolutionProof.resolutions[0]!.to = "p5"),
    missingRootBinding: (f: ReturnType<typeof model>) => f.graph.rootBindings.pop(),
    missingImportReceipt: (f: ReturnType<typeof model>) =>
        f.receipts.entries.outputs[0]!.imports.pop(),
};
for (const [name, change] of Object.entries(changes))
    test(`static graph rejects ${name}`, async () =>
        fixture(async (f) => {
            change(f);
            await assert.rejects(
                verify(await f.save(), f.expected, { inputRoot: f.root }),
                failure,
            );
        }));

/**
 * 每个包声明的 bin 都应有明确归属计划，不能通过删掉整个 bins 数组让实际 CLI 入口从审核中消失；此测试保留 tsx 真实
 * package.json 的 bin 声明，要求缺计划时拒绝。
 */
test("package-declared bins cannot disappear from the graph", async () =>
    fixture(async (f) => {
        f.graph.bins = [];
        await assert.rejects(
            verify(await f.save(), f.expected, { inputRoot: f.root }),
            (e: unknown) =>
                e instanceof RuntimePayloadError && e.code === "PAYLOAD_BIN_UNSUPPORTED",
        );
    }));

/**
 * optional 覆盖普通依赖，optional peer 的缺失与 npm alias 原始 requested 文本分别保留；两个 peer 上下文仍是不同实例，
 * 测试要求有效选择成功并拒绝缺失或串换的决定证据。
 */
test("optional overrides optional peers and npm alias edges stay explicit", async () =>
    fixture(async (f) => {
        f.put(
            "trees/dependencies/entry/node_modules/peer-lib/package.json",
            bytes({
                name: "peer-lib",
                version: "1.0.0",
                dependencies: { host: "overridden" },
                optionalDependencies: { host: "*" },
                peerDependencies: { missing: "*" },
                peerDependenciesMeta: { missing: { optional: true } },
            }),
        );
        const edge = f.graph.edges[0]!;
        edge.kind = "optional";
        f.graph.edges.push({
            from: "p2",
            alias: "missing",
            kind: "optional-peer",
            requested: "*",
            to: null,
            absence: "OPTIONAL_PEER_ABSENT",
        });
        f.receipts.dependencies.optionalDecisions = [
            { from: "p2", alias: "host", action: "include", evidence: f.recipe.tools[0]!.evidence },
            {
                from: "p2",
                alias: "missing",
                action: "absent-optional-peer",
                evidence: f.recipe.tools[0]!.evidence,
            },
        ];
        f.put(
            "trees/dependencies/execution/node_modules/peer-lib/package.json",
            bytes({
                name: "peer-lib",
                version: "1.0.0",
                dependencies: { aliasHost: "npm:host@2.0.0" },
            }),
        );
        f.graph.edges[1]!.alias = "aliasHost";
        f.graph.edges[1]!.requested = "npm:host@2.0.0";
        f.graph.edges[1]!.kind = "dependency";
        f.graph.resolutionProof.resolutions[1]!.specifier = "aliasHost";
        rehashPackages(f);
        const report = await verify(await f.save(), f.expected, { inputRoot: f.root });
        assert.equal(
            report.trees.dependencies.receipt.graph.instances.filter((p) => p.name === "peer-lib")
                .length,
            2,
        );
        f.receipts.dependencies.optionalDecisions.pop();
        await assert.rejects(verify(await f.save(), f.expected, { inputRoot: f.root }), failure);
    }));

/**
 * 原始 bin alias 可以是明确记录的逻辑链接，但只能指向同 owner 的真实原目标，读取阶段不会追随它；正确链接通过后再串换
 * target，必须由 alias 映射检查拒绝。
 */
test("bin sourceAlias logical link is checked without dereferencing", async () =>
    fixture(async (f) => {
        const bin = f.graph.bins[0]!;
        bin.sourceAlias = bin.aliasPath;
        f.inventories.dependencies.directories.push("node_modules/.bin");
        f.inventories.dependencies.links.push({
            path: bin.aliasPath,
            target: "../tsx/dist/loader.mjs",
        });
        const b = await f.save();
        await symlink(
            "../tsx/dist/loader.mjs",
            join(f.root, f.recipe.dependencies.root, bin.aliasPath),
        );
        assert.equal(
            (await verify(b, f.expected, { inputRoot: f.root })).trees.dependencies.linkCount,
            1,
        );
        await rm(join(f.root, f.recipe.dependencies.root, bin.aliasPath));
        f.inventories.dependencies.links[0]!.target = "../unowned";
        const bad = await f.save();
        await symlink("../unowned", join(f.root, f.recipe.dependencies.root, bin.aliasPath));
        await assert.rejects(verify(bad, f.expected, { inputRoot: f.root }), failure);
    }));

/**
 * 第三方 native bin 使用独立检查声明而非挤进两个产品输出，目标字节只是普通合成数据且绝不执行；成功报告必须列出检查记录
 * 和实际 evidence，架构或 minOS 串换则拒绝。
 */
test("third party native bins bind inspection hash arch minOS and evidence", async () =>
    fixture(async (f) => {
        f.add(
            "dependencies",
            "node_modules/esbuild/package.json",
            bytes({ name: "esbuild", version: "0.27.3", bin: { esbuild: "bin/esbuild" } }),
        );
        const target = f.add(
            "dependencies",
            "node_modules/esbuild/bin/esbuild",
            "synthetic native bin; not executable\n",
            493,
        );
        f.graph.instances.push({
            id: "p6",
            root: "node_modules/esbuild",
            name: "esbuild",
            version: "0.27.3",
            lockSnapshot: "esbuild@0.27.3",
            packageJson: { sizeBytes: 0, sha256: "0".repeat(64) },
            ownTreeSha256: "0".repeat(64),
        });
        f.put(
            "trees/dependencies/node_modules/tsx/package.json",
            bytes({
                name: "tsx",
                version: "4.23.15",
                bin: { tsx: "dist/loader.mjs" },
                dependencies: { esbuild: "0.27.3" },
            }),
        );
        f.graph.edges.push({
            from: "p1",
            alias: "esbuild",
            kind: "dependency",
            requested: "0.27.3",
            to: "p6",
            absence: null,
        });
        f.graph.resolutionProof.resolutions.push({
            from: "p1",
            consumer: "node_modules/tsx/package.json",
            specifier: "esbuild",
            resolvedFile: target.path,
            to: "p6",
        });
        rehashPackages(f);
        const inspection = {
            schemaVersion: 1,
            kind: "NATIVE_BIN_INSPECTION",
            platform: "darwin",
            arch: "x64",
            path: target.path,
            sha256: target.sha256,
            minimumOs: "14.0",
            inspectionEvidence: f.recipe.tools[0]!.evidence,
        };
        const inspectionRef = f.put("evidence/esbuild-inspection.json", bytes(inspection));
        f.graph.bins.push({
            owner: "p6",
            name: "esbuild",
            aliasPath: "node_modules/.bin/esbuild",
            sourceAlias: null,
            targetPath: target.path,
            targetSha256: target.sha256,
            launcher: "native",
            inspection: inspectionRef,
        });
        const report = await verify(await f.save(), f.expected, { inputRoot: f.root });
        assert.ok(report.checkedEvidence.some((r) => r.path === inspectionRef.path));
        assert.ok(report.pending.includes("TARGET_EXECUTION_AND_PROVENANCE"));
        for (const change of [
            { minimumOs: "15.0.1" },
            { arch: "arm64" },
            { sha256: "f".repeat(64) },
            { unexpected: "secret" },
        ]) {
            const ref = f.put(inspectionRef.path, bytes({ ...inspection, ...change }));
            f.graph.bins[1]!.inspection = ref;
            await assert.rejects(
                verify(await f.save(), f.expected, { inputRoot: f.root }),
                failure,
            );
        }
    }));

/**
 * 静态源码使用独立于 JSON 的十六 MiB 单文件预算，声明超限必须在真实成员正文读取之前拒绝；fixture 只修改小文件的声明长
 * 度，不生成大文件来浪费共享工作区剩余磁盘。
 */
test("AST declarations above sixteen MiB reject before physical body read", async () =>
    fixture(async (f) => {
        f.inventories.entries.files[0]!.sizeBytes = 16 * 1024 ** 2 + 1;
        await assert.rejects(
            verify(await f.save(), f.expected, { inputRoot: f.root }),
            (e: unknown) => e instanceof RuntimePayloadError && e.code === "PAYLOAD_LIMIT",
        );
    }));

/**
 * JS 文件不能通过把角色声明成 asset 来隐藏实际外部导入，asset 的空 imports 仍须与其可解析代码事实一致；新增文件和库存
 * 摘要全部真实绑定，避免把拒绝归因于漏文件或 hash 错误。
 */
test("JavaScript assets cannot hide literal imports", async () =>
    fixture(async (f) => {
        f.add("entries", "hidden.js", 'import "unbound-package";\n');
        f.receipts.entries.outputs.push({ path: "hidden.js", kind: "asset", imports: [] });
        await assert.rejects(
            verify(await f.save(), f.expected, { inputRoot: f.root }),
            (e: unknown) => e instanceof RuntimePayloadError && e.code === "PAYLOAD_GRAPH_MISMATCH",
        );
    }));

/**
 * 完整生产闭包不允许无引用的物理孤立包，bin 也不能自己建立新的 root；这里提供全部正确包字节与摘要，只缺从根消费者沿依
 * 赖边可达的关系，单纯端点检查无法发现该问题。
 */
test("physical package instances must be reachable from consumers", async () =>
    fixture(async (f) => {
        f.add(
            "dependencies",
            "node_modules/orphan/package.json",
            bytes({ name: "orphan", version: "1.0.0" }),
        );
        f.graph.instances.push({
            id: "p6",
            root: "node_modules/orphan",
            name: "orphan",
            version: "1.0.0",
            lockSnapshot: "orphan@1.0.0",
            packageJson: { sizeBytes: 0, sha256: "0".repeat(64) },
            ownTreeSha256: "0".repeat(64),
        });
        rehashPackages(f);
        await assert.rejects(
            verify(await f.save(), f.expected, { inputRoot: f.root }),
            (e: unknown) => e instanceof RuntimePayloadError && e.code === "PAYLOAD_GRAPH_MISMATCH",
        );
    }));

/**
 * npm 原归档图虽未核包正文，也不能容纳自报的孤立实例或缺失明确 npm-cli 根消费者；测试只要求内部声明闭合，固定 ARCHIVE
 * 与 npm 内容 pending 在有效样本成功后仍必须保留。
 */
test("npm declaration graph requires reachable instances and explicit npm-cli root", async () => {
    for (const orphan of [true, false])
        await fixture(async (f) => {
            const graph = f.nodeReceipt.npmGraph;
            if (orphan)
                graph.instances.push({
                    ...graph.instances[0]!,
                    id: "p2",
                    root: "npm/node_modules/orphan",
                    name: "orphan",
                    lockSnapshot: `node-archive:${f.recipe.node.file.sha256}:node_modules/orphan`,
                });
            else {
                graph.rootBindings = [];
                graph.resolutionProof.resolutions = [];
            }
            await assert.rejects(
                verify(await f.save(), f.expected, { inputRoot: f.root }),
                (e: unknown) =>
                    e instanceof RuntimePayloadError && e.code === "PAYLOAD_GRAPH_MISMATCH",
            );
        });
});

/**
 * 完整 AST 能区分静态 export、字面动态 import 与字符串注释中的伪导入，同时保留非字面运行期加载边界；真实相对目标必须在
 * 库存中且 dynamic 标记准确，测试不会执行这些合成模块。
 */
test("AST checks literal exports dynamic imports and ignores comment strings", async () =>
    fixture(async (f) => {
        f.add(
            "entries",
            "chunk.js",
            'export {value} from "./sub.js"; await import("./sub.js"); const text="import(never)"; const later=()=>i' +
                "mport(runtimePath);\n",
        );
        f.add("entries", "sub.js", "export const value=1;\n");
        f.receipts.entries.outputs.push(
            {
                path: "chunk.js",
                kind: "chunk",
                imports: [
                    { specifier: "./sub.js", kind: "relative", target: "sub.js", dynamic: false },
                    { specifier: "./sub.js", kind: "relative", target: "sub.js", dynamic: true },
                ],
            },
            { path: "sub.js", kind: "chunk", imports: [] },
        );
        await verify(await f.save(), f.expected, { inputRoot: f.root });
        f.receipts.entries.outputs[2]!.imports[1]!.dynamic = false;
        await assert.rejects(verify(await f.save(), f.expected, { inputRoot: f.root }), failure);
    }));

/**
 * 合计 AST 预算覆盖入口与八个执行成员，而不是给每个文件独立分配六十四 MiB；测试只改九个小文件的声明长度并重写库存证据
 * ，要求在实际内容尺寸不符之前先稳定报告 LIMIT。
 */
test("AST cumulative declarations share sixty-four MiB budget", async () =>
    fixture(async (f) => {
        for (const file of f.inventories.execution.files) file.sizeBytes = 16 * 1024 ** 2;
        const b = f.seal();
        for (const ref of [f.recipe.execution.inventory, f.recipe.execution.buildReceipt])
            await writeFile(join(f.root, ref.path), f.data.get(ref.path)!);
        await assert.rejects(
            verify(b, f.expected, { inputRoot: f.root }),
            (e: unknown) => e instanceof RuntimePayloadError && e.code === "PAYLOAD_LIMIT",
        );
    }));
