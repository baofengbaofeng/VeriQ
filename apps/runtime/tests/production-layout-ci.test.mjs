import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { runBoundedAssetCli } from "../scripts/runtime-assets-ci-process.mjs";
import {
    classifyCommandResult,
    collectLayoutMetadata,
    runStages,
} from "../../../.github/scripts/production-layout.mjs";

// 这些测试只使用测试自己创建的小文件与真实宿主子进程，验证生产布局调用方的失败关闭和物理事实，不把微型夹具当作真实 pnpm、原生 SDK 或目标 Runtime 验收结果。
const fixture = async (body) => {
    const base = await mkdtemp(join(tmpdir(), "veriq-layout-test-"));
    try {
        const root = join(base, "source"),
            evidenceDir = join(base, "evidence");
        await mkdir(root);
        return await body({ base, root, evidenceDir });
    } finally {
        await rm(base, { recursive: true, force: true });
    }
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const nodeStage = (name, script, timeoutMs = 2000) => ({
    name,
    timeoutMs,
    run: (command) => command(process.execPath, ["-e", script], process.cwd()),
});

// 真实退出零仍可能带有截断或关闭未知，调用方必须把这些正交事实逐一检查；手工翻转真实结果的单个字段只验证分类谓词，不替代已有进程管理器的行为测试。
test("classifies actual children and every success predicate", async () => {
    const result = await runBoundedAssetCli({
        executable: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: process.cwd(),
        timeoutMs: 2000,
    });
    assert.equal(classifyCommandResult(result), "PASS");
    for (const change of [
        { exit: 1 },
        { truncated: true },
        { timedOut: true },
        { closeConfirmed: false },
        { admitted: false },
        { signal: "SIGTERM" },
        { error: "ENOENT" },
    ]) {
        assert.equal(classifyCommandResult({ ...result, ...change }), "FAIL");
    }
    const absent = await runBoundedAssetCli({
        executable: "/no-such-veriq-layout-cli",
        args: [],
        cwd: process.cwd(),
        timeoutMs: 100,
    });
    assert.equal(classifyCommandResult(absent), "FAIL");
});

// 每个失败阶段之后必须保留尚未执行状态，且捕获真实退出、管道溢出和期限事实；第二个阶段若被错误执行会产生清晰断言失败，不能通过伪造业务响应蒙混过关。
for (const [label, script, timeoutMs] of [
    ["exit", "process.exit(7)", 2000],
    ["stdout overflow", "process.stdout.write(Buffer.alloc(70000));", 2000],
    ["timeout", "setInterval(() => {}, 1000)", 40],
]) {
    test(`failed ${label} leaves later stage NOT_RUN`, async () => {
        const journal = await runStages({
            stages: [nodeStage("first", script, timeoutMs), nodeStage("later", "process.exit(0)")],
            deadlineMs: Date.now() + 10000,
        });
        assert.deepEqual(
            journal.map((entry) => entry.status),
            ["FAIL", "NOT_RUN"],
        );
        assert.equal(journal[0].commands.length, 1);
        assert.equal(classifyCommandResult(journal[0].commands[0].result), "FAIL");
    });
}

// 完整原始清单必须逐字节保留，同名同版本的嵌套包具有不同根与文件归属；每个输出引用都核对实际长度和摘要，防止成功结果仅留下不可复核的内存汇总或省略的清单。
test("keeps nested duplicate instances, original manifests, ownership and complete references", () =>
    fixture(async ({ root, evidenceDir }) => {
        const outer = join(root, "node_modules/pkg"),
            inner = join(outer, "node_modules/pkg");
        await mkdir(inner, { recursive: true });
        const manifest =
            '{\n "name":"pkg", "version":"1.0.0", "dependencies":{"x":"*"}, "custom":{"preserved":true}, "bin":{"pkg":"own.js"}\n}\n';
        for (const location of [outer, inner]) {
            await writeFile(join(location, "package.json"), manifest);
            await writeFile(join(location, "own.js"), "export default 1;\n");
        }
        const result = await collectLayoutMetadata({ root, evidenceDir, workspaceRoots: [] });
        assert.equal(result.schemaVersion, 1);
        assert.equal(result.totals.instances, 2);
        const records = [];
        for (const ref of result.artifacts) {
            const bytes = await readFile(join(evidenceDir, ref.path));
            assert.equal(bytes.length, ref.bytes);
            assert.equal(digest(bytes), ref.sha256);
            if (ref.kind === "inventory") records.push(...JSON.parse(bytes));
            if (ref.kind === "manifest") assert.equal(bytes.toString(), manifest);
        }
        const packages = records.filter((entry) => entry.kind === "package");
        assert.deepEqual(packages.map((entry) => entry.path).sort(), [
            "node_modules/pkg",
            "node_modules/pkg/node_modules/pkg",
        ]);
        const own = records.filter(
            (entry) => entry.kind === "file" && entry.path.endsWith("own.js"),
        );
        assert.deepEqual(
            own.map((entry) => entry.owner).sort(),
            packages.map((entry) => entry.path).sort(),
        );
        assert.equal(records.filter((entry) => entry.kind === "bin").length, 2);
    }));

// 外部目标刻意放置无效清单，若观察器解引用目录或文件链接就会读到毒化字节并错误失败；合格结果仅保留链接原文和词法端点，不宣称目标内容或生产依赖边已经闭合。
test("does not follow poisoned links and maps workspace endpoints lexically", () =>
    fixture(async ({ base, root, evidenceDir }) => {
        const outside = join(base, "outside"),
            workspace = join(root, "packages/local");
        await mkdir(outside);
        await mkdir(workspace, { recursive: true });
        await writeFile(join(outside, "package.json"), "poison");
        await writeFile(join(workspace, "package.json"), '{"name":"local"}');
        await mkdir(join(root, "node_modules"));
        await symlink(outside, join(root, "node_modules/poison"));
        await symlink("../packages/local", join(root, "node_modules/local"));
        await symlink(join(outside, "package.json"), join(root, "alias.json"));
        const result = await collectLayoutMetadata({
            root,
            evidenceDir,
            workspaceRoots: [{ path: "packages/local", sourcePath: "packages/local" }],
        });
        const records = (
            await Promise.all(
                result.artifacts
                    .filter((ref) => ref.kind === "inventory")
                    .map(async (ref) =>
                        JSON.parse(await readFile(join(evidenceDir, ref.path), "utf8")),
                    ),
            )
        ).flat();
        assert.equal(result.totals.links, 3);
        assert.equal(
            records.find((entry) => entry.path === "node_modules/local").workspaceSource,
            "packages/local",
        );
        assert.equal(
            records.find((entry) => entry.path === "node_modules/poison").workspaceSource,
            null,
        );
    }));

// 生产上限只允许在测试中缩小，任何非法清单、计数、路径或正文超限都必须抛出而不能截断成成功；同时核验未知选项和超大限额不会偷偷关闭默认保护。
for (const [label, setup, limits] of [
    ["malformed manifest", async (root) => writeFile(join(root, "package.json"), "{"), {}],
    [
        "oversized manifest",
        async (root) => writeFile(join(root, "package.json"), '{"name":"too-long"}'),
        { manifestBytes: 8 },
    ],
    ["members", async (root) => writeFile(join(root, "a"), "x"), { members: 0 }],
    ["content", async (root) => writeFile(join(root, "a"), "abcd"), { contentBytes: 3 }],
    ["path", async (root) => writeFile(join(root, "long-name"), "x"), { pathBytes: 3 }],
    ["instances", async (root) => writeFile(join(root, "package.json"), "{}"), { instances: 0 }],
    ["links", async (root) => symlink("missing", join(root, "link")), { links: 0 }],
    ["metadata", async (root) => writeFile(join(root, "a"), "x"), { metadataBytes: 1 }],
    ["enlarged limit", async () => {}, { members: 40001 }],
    ["unknown limit", async () => {}, { anything: 1 }],
]) {
    test(`rejects ${label}`, () =>
        fixture(async ({ root, evidenceDir }) => {
            await setup(root);
            await assert.rejects(
                collectLayoutMetadata({ root, evidenceDir, workspaceRoots: [], limits }),
            );
        }));
}

// 模块导入必须没有命令、目录或日志副作用，子进程在空白目录中导入真实模块后只输出目录项；这能捕获意外顶层生产入口而不执行网络获取、pnpm 安装或真实工作流。
test("import is inert in an empty working directory", () =>
    fixture(async ({ root }) => {
        const target = pathToFileURL(
            join(import.meta.dirname, "../../../.github/scripts/production-layout.mjs"),
        ).href;
        const result = await runBoundedAssetCli({
            executable: process.execPath,
            args: [
                "--input-type=module",
                "-e",
                `await import(${JSON.stringify(target)}); const fs = await import('node:fs/promises'); console.log(JSON.stringify(await fs.readdir('.')));`,
            ],
            cwd: root,
            timeoutMs: 2000,
        });
        assert.equal(classifyCommandResult(result), "PASS");
        assert.deepEqual(JSON.parse(result.stdout), []);
        assert.deepEqual(await readdir(root), []);
    }));

// stderr 超限不会主动杀死子进程，因此真实零退出仍然能携带截断事实；此用例直接覆盖调用方曾容易遗漏的组合，并确认阶段不能因为退出零而准许后续观察执行。
test("actual exit zero with truncated stderr still blocks later stages", async () => {
    const journal = await runStages({
        stages: [
            nodeStage("overflow", "process.stderr.write(Buffer.alloc(4 * 1024 ** 2 + 4096))"),
            nodeStage("observe", "process.exit(0)"),
        ],
        deadlineMs: Date.now() + 10000,
    });
    assert.equal(journal[0].commands[0].result.exit, 0);
    assert.equal(journal[0].commands[0].result.truncated, true);
    assert.deepEqual(
        journal.map((entry) => entry.status),
        ["FAIL", "NOT_RUN"],
    );
});

// 成功流水线的开始和结束事件均应可持久化，期限已过时不接纳任何新命令；两种真实调用共同验证 journal 不是事后猜测，且整体期限不能被每个阶段重新计时而延长。
test("journals actual transitions and refuses expired overall admission", async () => {
    const events = [];
    const success = await runStages({
        stages: [nodeStage("one", "process.exit(0)"), nodeStage("two", "process.exit(0)")],
        deadlineMs: Date.now() + 10000,
        onUpdate: async (entries) => events.push(entries.map((entry) => entry.status)),
    });
    assert.deepEqual(
        success.map((entry) => entry.status),
        ["PASS", "PASS"],
    );
    assert.deepEqual(events[0], ["STARTED", "NOT_RUN"]);
    assert.deepEqual(events.at(-1), ["PASS", "PASS"]);
    const expired = await runStages({
        stages: [nodeStage("one", "process.exit(0)"), nodeStage("two", "process.exit(0)")],
        deadlineMs: Date.now() - 1,
    });
    assert.equal(expired[0].commands.length, 0);
    assert.deepEqual(
        expired.map((entry) => entry.status),
        ["FAIL", "NOT_RUN"],
    );
});

// 缩小单块 JSON 预算迫使普通文件事实分成多块，完整文件路径集合仍必须全部存在；每块独立可解析并核验摘要，证明分块不是静默丢弃尾部成员的另一种截断方式。
test("chunks inventories without omissions under a reduced JSON budget", () =>
    fixture(async ({ root, evidenceDir }) => {
        for (let index = 0; index < 16; index++)
            await writeFile(join(root, `file-${index}`), "body");
        const result = await collectLayoutMetadata({
            root,
            evidenceDir,
            workspaceRoots: [],
            limits: { jsonBytes: 512 },
        });
        assert.ok(result.artifacts.length > 1);
        const records = [];
        for (const ref of result.artifacts) {
            const bytes = await readFile(join(evidenceDir, ref.path));
            assert.ok(bytes.length <= 512);
            assert.equal(digest(bytes), ref.sha256);
            records.push(...JSON.parse(bytes));
        }
        assert.equal(records.filter((entry) => entry.kind === "file").length, 16);
        assert.equal(
            new Set(records.filter((entry) => entry.kind === "file").map((entry) => entry.path))
                .size,
            16,
        );
    }));

// 工作区端点不接受根外或非规范路径，包入口清单也不能借链接从外部读入；失败发生在内容解引用之前，输入根与证据根重叠时同样拒绝，避免将新输出再次当作被观察的源成员。
test("rejects linked package manifests and invalid workspace boundaries", () =>
    fixture(async ({ base, root, evidenceDir }) => {
        await assert.rejects(
            collectLayoutMetadata({
                root,
                evidenceDir,
                workspaceRoots: [{ path: "../outside", sourcePath: "outside" }],
            }),
        );
        await assert.rejects(
            collectLayoutMetadata({
                root,
                evidenceDir: join(root, "evidence"),
                workspaceRoots: [],
            }),
        );
        const body = join(base, "manifest.json");
        await writeFile(body, '{"name":"external"}');
        await symlink(body, join(root, "package.json"));
        await assert.rejects(collectLayoutMetadata({ root, evidenceDir, workspaceRoots: [] }));
    }));

// 直接子进程先退出而其已知短寿命后代仍持有管道时，真实有界管理器只能返回关闭未知；调用方必须冻结失败并留下后续未运行，测试让自己创建的后代自然退出，不把此事实宣传为任意后代清理证明。
test("actual unknown close blocks observation even after direct exit zero", async () => {
    const script =
        "const {spawn}=require('node:child_process'); spawn(process.execPath,['-e','setTimeout(()=>{}, 7200)'],{stdio:['ignore','inherit','inherit']}).unref(); process.exit(0)";
    const journal = await runStages({
        stages: [nodeStage("inherited-pipe", script, 120), nodeStage("observe", "process.exit(0)")],
        deadlineMs: Date.now() + 10000,
    });
    assert.equal(journal[0].commands[0].result.closeConfirmed, false);
    assert.equal(journal[0].commands[0].result.exit, 0);
    assert.equal(journal[0].error, "COMMAND_CLOSE_UNKNOWN");
    assert.deepEqual(
        journal.map((entry) => entry.status),
        ["FAIL", "NOT_RUN"],
    );
});
