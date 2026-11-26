import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { runBoundedAssetCli } from "../scripts/runtime-assets-ci-process.mjs";
import {
    bindPinnedPnpm,
    classifyCommandResult,
    collectLayoutMetadata,
    runStages,
} from "../../../.github/scripts/production-layout.mjs";

// 这些测试只使用测试自己创建的小文件与真实宿主子进程，验证生产布局调用方的失败关闭和物理事实，不把微型夹具当作真实 pnpm
// 、原生 SDK 或目标 Runtime 验收结果。
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

// 真实退出零仍可能带有截断或关闭未知，调用方必须把这些正交事实逐一检查；手工翻转真实结果的单个字段只验证分类谓词，不替
// 代已有进程管理器的行为测试。
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

// 每个失败阶段之后必须保留尚未执行状态，且捕获真实退出、管道溢出和期限事实；第二个阶段若被错误执行会产生清晰断言失败，
// 不能通过伪造业务响应蒙混过关。
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

// 完整原始清单必须逐字节保留，同名同版本的嵌套包具有不同根与文件归属；每个输出引用都核对实际长度和摘要，防止成功结果仅
// 留下不可复核的内存汇总或省略的清单。
test("keeps nested duplicate instances, original manifests, ownership and complete references", () =>
    fixture(async ({ root, evidenceDir }) => {
        const outer = join(root, "node_modules/pkg"),
            inner = join(outer, "node_modules/pkg");
        await mkdir(inner, { recursive: true });
        const manifest =
            '{\n "name":"pkg", "version":"1.0.0", "dependencies":{"x":"*"}, "custom":{"preserved":true}, "bin":{"pkg' +
            '":"own.js"}\n}\n';
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
        const own = records.filter((entry) => entry.kind === "file" && entry.path.endsWith("own.js"));
        assert.deepEqual(own.map((entry) => entry.owner).sort(), packages.map((entry) => entry.path).sort());
        assert.equal(records.filter((entry) => entry.kind === "bin").length, 2);
    }));

// 外部目标刻意放置无效清单，若观察器解引用目录或文件链接就会读到毒化字节并错误失败；合格结果仅保留链接原文和词法端点，
// 不宣称目标内容或生产依赖边已经闭合。
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
                    .map(async (ref) => JSON.parse(await readFile(join(evidenceDir, ref.path), "utf8"))),
            )
        ).flat();
        assert.equal(result.totals.links, 3);
        assert.equal(records.find((entry) => entry.path === "node_modules/local").workspaceSource, "packages/local");
        assert.equal(records.find((entry) => entry.path === "node_modules/poison").workspaceSource, null);
    }));

// 生产上限只允许在测试中缩小，任何非法清单、计数、路径或正文超限都必须抛出而不能截断成成功；同时核验未知选项和超大限额
// 不会偷偷关闭默认保护。
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
            await assert.rejects(collectLayoutMetadata({ root, evidenceDir, workspaceRoots: [], limits }));
        }));
}

// 模块导入必须没有命令、目录或日志副作用，子进程在空白目录中导入真实模块后只输出目录项；这能捕获意外顶层生产入口而不执
// 行网络获取、pnpm 安装或真实工作流。
test("import is inert in an empty working directory", () =>
    fixture(async ({ root }) => {
        const target = pathToFileURL(join(import.meta.dirname, "../../../.github/scripts/production-layout.mjs")).href;
        const result = await runBoundedAssetCli({
            executable: process.execPath,
            args: [
                "--input-type=module",
                "-e",
                `await import(${JSON.stringify(target)}` +
                    `); const fs = await import('node:fs/promises'); console.log(JSON.stringify(await fs.readdir('.` +
                    `')));`,
            ],
            cwd: root,
            timeoutMs: 2000,
        });
        assert.equal(classifyCommandResult(result), "PASS");
        assert.deepEqual(JSON.parse(result.stdout), []);
        assert.deepEqual(await readdir(root), []);
    }));

// stderr 超限不会主动杀死子进程，因此真实零退出仍然能携带截断事实；此用例直接覆盖调用方曾容易遗漏的组合，并确认阶段不能
// 因为退出零而准许后续观察执行。
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

// 成功流水线的开始和结束事件均应可持久化，期限已过时不接纳任何新命令；两种真实调用共同验证 journal 不是事后猜测，且整体
// 期限不能被每个阶段重新计时而延长。
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

// 缩小单块 JSON 预算迫使普通文件事实分成多块，完整文件路径集合仍必须全部存在；每块独立可解析并核验摘要，证明分块不是静
// 默丢弃尾部成员的另一种截断方式。
test("chunks inventories without omissions under a reduced JSON budget", () =>
    fixture(async ({ root, evidenceDir }) => {
        for (let index = 0; index < 16; index++) await writeFile(join(root, `file-${index}`), "body");
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
        assert.equal(new Set(records.filter((entry) => entry.kind === "file").map((entry) => entry.path)).size, 16);
    }));

// 工作区端点不接受根外或非规范路径，包入口清单也不能借链接从外部读入；失败发生在内容解引用之前，输入根与证据根重叠时同
// 样拒绝，避免将新输出再次当作被观察的源成员。
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

// 关闭未知夹具先由实际持有管道的进程发送 nonce 与身份确认，再让直接子进程退出零；控制器只能在捕获同一 READY 后判断关闭
// 事实，启动未达条件会明确失败，不能把任意短期限当作继承管道已经建立的证明。
const inheritedPipeFixture = async (delayMs) => {
    const root = await mkdtemp(join(tmpdir(), "veriq-layout-pipe-")),
        nonce = randomUUID();
    const readyPath = join(root, "ready.json"),
        releasePath = join(root, "release.json"),
        donePath = join(root, "done.json"),
        errorPath = join(root, "error.json");
    // 三个握手标记都先完整写入同目录临时文件再 rename 发布，读取者只能见到缺失或完整 JSON；这防止 release 的创建与写入
    // 窗口被继承者误判成解析失败，同时保留真实异常文件而不把清理错误吞掉。
    const inheritor =
        `
        const fs = require("node:fs");
        const publish = (path, value) => { fs.writeFileSync(path + ".tmp", JSON.stringify(value)); fs.renameSync(pat` +
        `h + ".tmp", path); };
        process.once("uncaughtException", (error) => {
            publish(${JSON.stringify(errorPath)}, { name: error.name, message: error.message, code: error.code ?? nu` +
        `ll });
            process.exit(14);
        });
        const identity = { kind: "READY", nonce: ${JSON.stringify(nonce)}, pid: process.pid, parentPid: process.ppid };
        const expires = Date.now() + 12000;
        let finished = false;
        const finish = (reason) => {
            if (finished) return;
            finished = true;
            clearInterval(timer);
            fs.closeSync(1);
            fs.closeSync(2);
            publish(${JSON.stringify(donePath)}, { ...identity, kind: "DONE", descriptorsClosed: true, reason });
            process.exit(0);
        };
        const timer = setInterval(() => {
            let release = null;
            try { release = JSON.parse(fs.readFileSync(${JSON.stringify(releasePath)}, "utf8")); }
            catch (error) { if (error.code !== "ENOENT") throw error; }
            if (release?.nonce === identity.nonce) finish("RELEASE");
            else if (Date.now() > expires) finish("FAILSAFE");
        }, 20);
        publish(${JSON.stringify(readyPath)}, identity);
        process.send(identity);
    `;
    const direct =
        `
        const { spawn } = require("node:child_process");
        process.on("SIGTERM", () => {});
        setTimeout(() => {
            const child = spawn(process.execPath, ["-e", ${JSON.stringify(inheritor)}], { stdio: ["ignore", "inherit` +
        `", "inherit", "ipc"] });
            child.once("error", () => process.exit(11));
            child.once("message", (ready) => {
                if (ready.kind !== "READY" || ready.nonce !== ${JSON.stringify(nonce)} || ready.pid !== child.pid ||` +
        ` ready.parentPid !== process.pid) process.exit(12);
                process.stdout.write(JSON.stringify(ready) + "\\n", () => process.exit(0));
            });
            child.unref();
        }, ${delayMs});
    `;
    let ready = null,
        result = null,
        cleanup = "UNCONFIRMED",
        primaryError = null,
        cleanupError = null;
    try {
        const journal = await runStages({
            stages: [nodeStage("inherited-pipe", direct, 2000), nodeStage("observe", "process.exit(0)")],
            deadlineMs: Date.now() + 12000,
        });
        result = journal[0].commands[0].result;
        const { stdout, stderr, ...facts } = result;
        console.log(
            JSON.stringify({
                fixture: "inherited-pipe-result",
                delayMs,
                result: facts,
                stdout: stdout.toString(),
                stderr: stderr.toString(),
            }),
        );
        assert.ok(stdout.length, `Fixture READY missing: ${JSON.stringify(facts)}`);
        ready = JSON.parse(stdout.toString());
        assert.deepEqual(ready, JSON.parse(await readFile(readyPath, "utf8")));
        assert.equal(ready.kind, "READY");
        assert.equal(ready.nonce, nonce);
        assert.equal(ready.parentPid, result.pid);
        assert.ok(Number.isSafeInteger(ready.pid) && ready.pid > 0 && ready.pid !== result.pid);
        console.log(JSON.stringify({ fixture: "inherited-pipe", delayMs, ready, result: facts }));
        assert.equal(result.closeConfirmed, false);
        assert.equal(result.exit, 0);
        assert.equal(result.signal, null);
        assert.equal(result.admitted, true);
        assert.equal(result.truncated, false);
        assert.equal(result.error, null);
        assert.equal(result.timedOut, true);
        assert.equal(journal[0].error, "COMMAND_CLOSE_UNKNOWN");
        assert.deepEqual(
            journal.map((entry) => entry.status),
            ["FAIL", "NOT_RUN"],
        );
    } catch (error) {
        primaryError = error;
    } finally {
        // release 文件只对本次 nonce 生效，DONE 在继承的两个描述符真实关闭之后写入；条件轮询有独立短期限，失败时保留夹
        // 具并报告未知，不能在仍可能存在 writer 时递归删除以制造清理成功表象。
        const end = Date.now() + 2000;
        try {
            await writeFile(releasePath + ".tmp", JSON.stringify({ nonce }));
            await rename(releasePath + ".tmp", releasePath);
            let done;
            let pollingError = null;
            while (!done && !pollingError) {
                if (Date.now() > end) {
                    pollingError = new Error("Fixture DONE deadline exceeded");
                    break;
                }
                try {
                    done = JSON.parse(await readFile(donePath, "utf8"));
                } catch (error) {
                    if (error.code !== "ENOENT") pollingError = error;
                }
                if (!done && !pollingError) {
                    let failure;
                    try {
                        failure = JSON.parse(await readFile(errorPath, "utf8"));
                    } catch (error) {
                        if (error.code !== "ENOENT") pollingError = error;
                    }
                    if (failure && !pollingError)
                        pollingError = new Error(`Fixture inheritor failed: ${JSON.stringify(failure)}`);
                    if (!pollingError) await new Promise((resolve) => setTimeout(resolve, 20));
                }
            }
            if (pollingError) {
                cleanupError = pollingError;
            } else {
                assert.equal(done.kind, "DONE");
                assert.equal(done.nonce, nonce);
                if (ready) assert.equal(done.pid, ready.pid);
                assert.equal(done.descriptorsClosed, true);
                assert.equal(done.reason, "RELEASE");
                await rm(root, { recursive: true });
                await assert.rejects(lstat(root), { code: "ENOENT" });
                cleanup = "REMOVED_AFTER_DONE";
            }
        } catch (error) {
            cleanupError = error;
        } finally {
            console.log(JSON.stringify({ fixture: "inherited-pipe", delayMs, nonce, root, cleanup }));
        }
    }
    if (cleanupError) {
        if (primaryError)
            throw new AggregateError([primaryError, cleanupError], "Fixture assertion and cleanup failed");
        throw cleanupError;
    }
    if (primaryError) throw primaryError;
};

test("actual unknown close follows actual inheritor READY", () => inheritedPipeFixture(0));

// 额外的真实启动延迟超过旧夹具的一百二十毫秒，但不会改变生产期限或进程关闭谓词；该场景只运行一次，必须先收到实际继承者
// READY 再观察未知关闭，不依赖重复执行或操作系统专用跳过来取得绿色结果。
test("delayed startup establishes READY before unchanged unknown-close predicates", () => inheritedPipeFixture(250));

// 真实固定版本的工具入口是 ESM loader 加 ESM bundle，兼容 CJS shim 不能推导出同名 dist 文件；微型夹具保留原始清单与实际
// 文件摘要，但任何夹具包体都不执行，错误扩展名必须在真实文件读取时暴露。
const pnpmFixture = (body) =>
    fixture(async ({ root, base }) => {
        const packageRoot = join(root, "pnpm");
        await mkdir(join(packageRoot, "bin"), { recursive: true });
        await mkdir(join(packageRoot, "dist"));
        const original =
            '{\n "name":"pnpm", "version":"11.25.0", "type":"module", "bin":{"pnpm":"bin/pnpm.mjs"}, "custom":{"reta' +
            'ined":true}\n}\n';
        await writeFile(join(packageRoot, "package.json"), original);
        await writeFile(join(packageRoot, "bin/pnpm.cjs"), "import('./pnpm.mjs');\n");
        await writeFile(join(packageRoot, "bin/pnpm.mjs"), "await import('../dist/pnpm.mjs');\n");
        await writeFile(join(packageRoot, "dist/pnpm.mjs"), "throw new Error('Fixture bodies must never execute');\n");
        return body({ base, ownedRoot: root, packageRoot, original });
    });

test("binds pinned pnpm ESM files and complete original package identity", () =>
    pnpmFixture(async ({ packageRoot, ownedRoot, original }) => {
        const bound = await bindPinnedPnpm({ packageRoot, ownedRoot });
        assert.equal(bound.version, "11.25.0");
        assert.equal(bound.cli.path, join(packageRoot, "bin/pnpm.mjs"));
        assert.equal(bound.implementation.path, join(packageRoot, "dist/pnpm.mjs"));
        assert.equal(bound.package.path, join(packageRoot, "package.json"));
        assert.equal(bound.packageJson.toString(), original);
        for (const file of [bound.cli, bound.implementation, bound.package]) {
            const bytes = await readFile(file.path);
            assert.equal(file.bytes, bytes.length);
            assert.equal(file.sha256, digest(bytes));
        }
    }));

// 固定版本与入口声明的拒绝必须先于任何错误路径回退，所有负例在真实自有目录中改变一项事实；链接祖先、根外路径及不能读取
// 为普通实现正文的对象均失败，而不是靠兼容 shim 或另一个 bundle 猜测成功。
for (const [label, change, pattern] of [
    [
        "version",
        async ({ packageRoot }) => {
            const path = join(packageRoot, "package.json"),
                value = JSON.parse(await readFile(path));
            value.version = "11.25.1";
            await writeFile(path, JSON.stringify(value));
        },
        /PNPM_PACKAGE_IDENTITY/,
    ],
    [
        "module type",
        async ({ packageRoot }) => {
            const path = join(packageRoot, "package.json"),
                value = JSON.parse(await readFile(path));
            value.type = "commonjs";
            await writeFile(path, JSON.stringify(value));
        },
        /PNPM_PACKAGE_IDENTITY/,
    ],
    [
        "bin identity",
        async ({ packageRoot }) => {
            const path = join(packageRoot, "package.json"),
                value = JSON.parse(await readFile(path));
            value.bin = "bin/pnpm.mjs";
            await writeFile(path, JSON.stringify(value));
        },
        /PNPM_PACKAGE_IDENTITY/,
    ],
    [
        "escaping bin",
        async ({ packageRoot }) => {
            const path = join(packageRoot, "package.json"),
                value = JSON.parse(await readFile(path));
            value.bin.pnpm = "../../outside.mjs";
            await writeFile(path, JSON.stringify(value));
        },
        /PNPM_PACKAGE_IDENTITY/,
    ],
    ["missing implementation", async ({ packageRoot }) => rm(join(packageRoot, "dist/pnpm.mjs")), /ENOENT/],
    [
        "linked loader",
        async ({ packageRoot }) => {
            await rm(join(packageRoot, "bin/pnpm.mjs"));
            await symlink("../dist/pnpm.mjs", join(packageRoot, "bin/pnpm.mjs"));
        },
        /LAYOUT_FILE_LIMIT/,
    ],
    [
        "linked manifest",
        async ({ packageRoot, base }) => {
            const path = join(base, "external.json");
            await writeFile(path, await readFile(join(packageRoot, "package.json")));
            await rm(join(packageRoot, "package.json"));
            await symlink(path, join(packageRoot, "package.json"));
        },
        /LAYOUT_FILE_LIMIT/,
    ],
    [
        "linked ancestor",
        async ({ packageRoot, base }) => {
            await rm(join(packageRoot, "bin"), { recursive: true });
            await mkdir(join(base, "external-bin"));
            await symlink(join(base, "external-bin"), join(packageRoot, "bin"));
        },
        /PNPM_PACKAGE_BOUNDARY/,
    ],
    [
        "non-file hash input",
        async ({ packageRoot }) => {
            await rm(join(packageRoot, "dist/pnpm.mjs"));
            await mkdir(join(packageRoot, "dist/pnpm.mjs"));
        },
        /LAYOUT_FILE_LIMIT/,
    ],
]) {
    test(`rejects pinned pnpm ${label}`, () =>
        pnpmFixture(async (input) => {
            await change(input);
            await assert.rejects(bindPinnedPnpm(input), pattern);
        }));
}

// 工具根必须位于调用者已经持有的前缀内，验证入口前后还受原阶段截止时间约束；这些边界只作用于工具绑定，不延长生产阶段预
// 算，也不把绝对路径正常化当作对外部来源的访问许可。
test("rejects pinned pnpm root escape and expired binding deadline", () =>
    pnpmFixture(async ({ packageRoot, ownedRoot, base }) => {
        await assert.rejects(bindPinnedPnpm({ packageRoot, ownedRoot: join(base, "other") }), /PNPM_PACKAGE_BOUNDARY/);
        await assert.rejects(
            bindPinnedPnpm({ packageRoot, ownedRoot, deadlineMs: Date.now() - 1 }),
            /PRODUCER_DEADLINE/,
        );
    }));
