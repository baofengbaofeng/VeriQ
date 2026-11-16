import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
    chmod,
    link,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
    admitEntryRun,
    selectGitInventory,
    readSourceFile,
    qualifyAmbientInputs,
    sealMetadata,
    verifyMetadata,
    runEntryOperation,
} from "../../../.github/scripts/runtime-entries.mjs";
import { runBoundedAssetCli } from "../scripts/runtime-assets-ci-process.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const reference = (path, bytes) => ({ path, sizeBytes: bytes.length, sha256: sha(bytes) });
const admitted = {
    event: "workflow_dispatch",
    purpose: "entry-inputs",
    source: "a".repeat(40),
    commit: "a".repeat(40),
    platform: "darwin",
    arch: "arm64",
    expectedArch: "arm64",
    release: "24.6.0",
    nodeVersion: "v24.22.1",
};
const gitRecord = (mode, path) => `${mode} blob ${"b".repeat(40)}\t${path}\0`;

// 这些真实小目录只用于控制器的元数据和失败边界测试，外层授权包装器提供独占内存临时根；每个测试拥有自己的目录并在已等待直接子进程关闭后移除，不能据此声称原生项目构建或全局后代已通过验收。
async function fixture(consume) {
    const root = await mkdtemp(join(tmpdir(), "veriq-entry-ci-test-"));
    try {
        return await consume(root);
    } finally {
        await rm(root, { recursive: true });
    }
}

test("inert import starts no command and creates no file", async () =>
    fixture(async (root) => {
        const result = await runBoundedAssetCli({
            executable: process.execPath,
            args: [
                "--input-type=module",
                "-e",
                `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), ".github/scripts/runtime-entries.mjs")).href)})`,
            ],
            cwd: root,
            timeoutMs: 5000,
        });
        assert.equal(result.exit, 0);
        assert.equal(result.closeConfirmed, true);
        assert.equal(result.stdout.length, 0);
        assert.equal(result.stderr.length, 0);
        assert.deepEqual(await readdir(root), []);
    }));

test("native admission accepts only the full reviewed manual dual Mac input", () => {
    assert.equal(admitEntryRun(admitted).arch, "arm64");
    assert.equal(admitEntryRun({ ...admitted, arch: "x64", expectedArch: "x64" }).arch, "x64");
    for (const patch of [
        { event: "push" },
        { purpose: "assets" },
        { source: "a".repeat(7) },
        { commit: "b".repeat(40) },
        { platform: "linux" },
        { arch: "x64" },
        { expectedArch: "ia32" },
        { release: "23.0.0" },
        { release: "25.0.0" },
        { nodeVersion: "v24.1.0" },
    ])
        assert.throws(() => admitEntryRun({ ...admitted, ...patch }), /ENTRY_ADMISSION/);
});

test("Git selection includes every regular source and only the three named executable exclusions", () => {
    const raw = Buffer.from(
        gitRecord("100644", "package.json") +
            gitRecord("100644", "apps/a.ts") +
            ["build.sh", "deploy/install.sh", "deploy/start.sh"]
                .map((p) => gitRecord("100755", p))
                .join(""),
    );
    const result = selectGitInventory(raw);
    assert.deepEqual(
        result.selected.map((v) => v.path),
        ["apps/a.ts", "package.json"],
    );
    assert.equal(result.excluded.length, 3);
    for (const row of result.excluded) assert.equal(row.reason, "TRACKED_EXECUTABLE");
    for (const bad of [
        gitRecord("120000", "link"),
        gitRecord("160000", "submodule"),
        gitRecord("100755", "new.sh"),
        gitRecord("100644", "../escape"),
        gitRecord("100644", "A") + gitRecord("100644", "a"),
        gitRecord("100644", "x") + gitRecord("100644", "x"),
    ])
        assert.throws(() => selectGitInventory(Buffer.from(bad)), /ENTRY_GIT/);
});

test("physical source admission rejects private modes links and altered bytes without rewriting", async () =>
    fixture(async (root) => {
        const bytes = Buffer.from("source\n"),
            ref = reference("source.ts", bytes);
        await writeFile(join(root, ref.path), bytes, { mode: 0o644 });
        await chmod(join(root, ref.path), 0o644);
        assert.deepEqual(await readSourceFile(root, ref), bytes);
        for (const mode of [0o600, 0o755]) {
            await chmod(join(root, ref.path), mode);
            await assert.rejects(readSourceFile(root, ref), /ENTRY_SOURCE/);
            assert.equal((await lstat(join(root, ref.path))).mode & 0o777, mode);
        }
        await chmod(join(root, ref.path), 0o444);
        assert.deepEqual(await readSourceFile(root, ref), bytes);
        await link(join(root, ref.path), join(root, "alias"));
        await assert.rejects(readSourceFile(root, ref), /ENTRY_SOURCE/);
        await rm(join(root, "alias"));
        await chmod(join(root, ref.path), 0o644);
        await writeFile(join(root, ref.path), "changed");
        await assert.rejects(readSourceFile(root, ref), /ENTRY_SOURCE/);
        await rm(join(root, ref.path));
        await symlink("missing", join(root, ref.path));
        await assert.rejects(readSourceFile(root, ref), /ENTRY_SOURCE/);
    }));

test("ambient input qualification records absences and rejects a newly present ignored config", async () =>
    fixture(async (root) => {
        await mkdir(join(root, "src"));
        const bytes = Buffer.from("{}\n");
        await writeFile(join(root, "package.json"), bytes, { mode: 0o644 });
        const refs = [reference("package.json", bytes), reference("src/main.ts", Buffer.from(""))];
        const facts = await qualifyAmbientInputs(root, refs);
        assert.ok(facts.absent.includes(".env.production.local"));
        await writeFile(join(root, ".env"), "PRIVATE_VALUE", { mode: 0o644 });
        await assert.rejects(qualifyAmbientInputs(root, refs), /ENTRY_AMBIENT/);
        await rm(join(root, ".env"));
        await writeFile(join(root, "src/tsconfig.json"), bytes, { mode: 0o644 });
        await assert.rejects(qualifyAmbientInputs(root, refs), /ENTRY_AMBIENT/);
    }));

test("metadata copies preserve original consumer Refs and detect missing extra changed or linked copies", async () =>
    fixture(async (root) => {
        const bytes = Buffer.from('{"kind":"test"}\n'),
            original = reference("input-evidence/entries-receipt.json", bytes);
        const destination = join(root, "metadata");
        const manifest = await sealMetadata(destination, [{ ref: original, bytes }]);
        assert.deepEqual(manifest.files[0].consumerRef, original);
        assert.notEqual(manifest.files[0].path, original.path);
        assert.deepEqual(await verifyMetadata(destination), manifest);
        const copy = join(destination, manifest.files[0].path);
        await writeFile(copy, "changed");
        await assert.rejects(verifyMetadata(destination), /ENTRY_METADATA/);
        await writeFile(copy, bytes);
        await writeFile(join(destination, "extra"), "x");
        await assert.rejects(verifyMetadata(destination), /ENTRY_METADATA/);
        await rm(join(destination, "extra"));
        await rm(copy);
        await assert.rejects(verifyMetadata(destination), /ENTRY_METADATA/);
        await symlink("missing", copy);
        await assert.rejects(verifyMetadata(destination), /ENTRY_METADATA/);
    }));

test("metadata rejects mismatched held bytes duplicate Refs and oversized JSON before collection", async () =>
    fixture(async (root) => {
        const bytes = Buffer.from("{}"),
            ref = reference("input-evidence/source.json", bytes);
        await assert.rejects(
            sealMetadata(join(root, "bad"), [{ ref, bytes: Buffer.from("[]") }]),
            /ENTRY_METADATA/,
        );
        await assert.rejects(
            sealMetadata(join(root, "duplicate"), [
                { ref, bytes },
                { ref, bytes },
            ]),
            /ENTRY_METADATA/,
        );
        await assert.rejects(
            sealMetadata(join(root, "large"), [
                {
                    ref: reference("large.json", Buffer.alloc(4 * 1024 ** 2 + 1)),
                    bytes: Buffer.alloc(4 * 1024 ** 2 + 1),
                },
            ]),
            /ENTRY_METADATA/,
        );
    }));

test("a real child failure preserves the first error and records actual close before cleanup", async () =>
    fixture(async (root) => {
        const journal = { commands: [] };
        let final = false,
            cleaned = false;
        const result = await runEntryOperation({
            journal,
            produce: async (command) => {
                await command({
                    executable: process.execPath,
                    args: ["-e", 'process.stderr.write("expected child failure");process.exit(7)'],
                    cwd: root,
                    timeoutMs: 5000,
                });
                throw new Error("FIRST_BUILD_FAILURE");
            },
            verifyFinal: async () => {
                final = true;
            },
            cleanup: async () => {
                cleaned = true;
            },
        });
        assert.equal(result.status, "FAILED");
        assert.equal(result.error, "FIRST_BUILD_FAILURE");
        assert.equal(final, false);
        assert.equal(cleaned, true);
        assert.equal(journal.commands[0].observation.exit, 7);
        assert.equal(journal.commands[0].observation.closeConfirmed, true);
        assert.equal(journal.commands[0].stderr.toString(), "expected child failure");
    }));

test("callback remains provisional until final checks and cleanup finish", async () =>
    fixture(async (root) => {
        const journal = { commands: [] },
            order = [];
        const result = await runEntryOperation({
            journal,
            produce: async (command) => {
                await command({
                    executable: process.execPath,
                    args: ["-e", ""],
                    cwd: root,
                    timeoutMs: 5000,
                });
                order.push("callback");
                return "provisional";
            },
            verifyFinal: async () => {
                order.push("final");
                throw new Error("SOURCE_CHANGED");
            },
            cleanup: async () => {
                order.push("cleanup");
            },
        });
        assert.equal(result.status, "FAILED");
        assert.equal(result.error, "SOURCE_CHANGED");
        assert.deepEqual(order, ["callback", "final", "cleanup"]);
    }));

test("unknown close preserves owned scratch and never enters final scan or cleanup", async () =>
    fixture(async (root) => {
        const scratch = join(root, "scratch");
        await mkdir(scratch);
        await writeFile(join(scratch, "sentinel"), "held");
        const journal = { commands: [] };
        const result = await runEntryOperation({
            journal,
            produce: async (command) => {
                const closed = await command({
                    executable: process.execPath,
                    args: ["-e", ""],
                    cwd: root,
                    timeoutMs: 5000,
                });
                assert.equal(closed.closeConfirmed, true);
                const error = new Error("UNKNOWN_WRITER");
                error.cleanup = "INCOMPLETE";
                throw error;
            },
            verifyFinal: async () => {
                throw new Error("FORBIDDEN_SCAN");
            },
            cleanup: async () => {
                await rm(scratch, { recursive: true });
            },
        });
        assert.equal(result.status, "INCOMPLETE");
        assert.equal(result.error, "UNKNOWN_WRITER");
        assert.equal(await readFile(join(scratch, "sentinel"), "utf8"), "held");
    }));

test("successful real direct child settles before final verification and owned cleanup", async () =>
    fixture(async (root) => {
        const order = [],
            journal = { commands: [] };
        const result = await runEntryOperation({
            journal,
            produce: async (command) => {
                const observed = await command({
                    executable: process.execPath,
                    args: ["-e", 'process.stdout.write("held")'],
                    cwd: root,
                    timeoutMs: 5000,
                });
                assert.equal(observed.closeConfirmed, true);
                order.push("child");
            },
            verifyFinal: async () => {
                order.push("final");
            },
            cleanup: async () => {
                order.push("cleanup");
            },
        });
        assert.equal(result.status, "PASS");
        assert.deepEqual(order, ["child", "final", "cleanup"]);
        assert.equal(journal.commands[0].stdout.toString(), "held");
        assert.ok(journal.commands[0].started <= journal.commands[0].finished);
    }));

// 配置扩展由已安装的 TypeScript 正式解析器处理，测试只提供微小真实配置并检查外部或遗漏绑定被拒绝；不复制解析器、exports 算法或生产器夹具，也不把这些 Linux 控制器断言作为 Mac 构建证据。
test("real TypeScript config tooling rejects unbound or external extends", async () =>
    fixture(async (root) => {
        const { qualifyTypeScriptConfigs } = await import(
            "../../../.github/scripts/runtime-entries.mjs"
        );
        const ts = (await import("../node_modules/typescript/lib/typescript.js")).default;
        const base = Buffer.from('{"compilerOptions":{"strict":true}}'),
            config = Buffer.from('{"extends":"./base.json","files":[]}');
        await writeFile(join(root, "base.json"), base);
        await writeFile(join(root, "tsconfig.json"), config);
        const refs = [reference("base.json", base), reference("tsconfig.json", config)];
        const result = qualifyTypeScriptConfigs(root, refs, ts);
        assert.ok(result.reads.some((v) => v.path === "base.json"));
        assert.throws(() => qualifyTypeScriptConfigs(root, refs.slice(1), ts), /ENTRY_CONFIG/);
        const external = Buffer.from('{"extends":"/etc/hosts","files":[]}');
        await writeFile(join(root, "tsconfig.json"), external);
        assert.throws(
            () => qualifyTypeScriptConfigs(root, [reference("tsconfig.json", external)], ts),
            /ENTRY_CONFIG/,
        );
    }));

test("clean launch rejects ambient injection and pins production mode before loader registration", async () => {
    const { checkCleanEnvironment } = await import("../../../.github/scripts/runtime-entries.mjs");
    const env = {
        PATH: "/usr/bin:/bin",
        HOME: "/tmp/home",
        NODE_ENV: "production",
        NODE_DISABLE_COMPILE_CACHE: "1",
        TMPDIR: "/tmp/owned",
    };
    assert.equal(checkCleanEnvironment(env).nodeEnv, "production");
    for (const patch of [
        { VITE_SECRET: "hidden" },
        { NODE_OPTIONS: "--import=hidden" },
        { TSX_TSCONFIG_PATH: "hidden" },
        { NODE_ENV: "development" },
        { TOKEN: "hidden" },
    ])
        assert.throws(() => checkCleanEnvironment({ ...env, ...patch }), /ENTRY_ENVIRONMENT/);
});

// 此例让生产回调故意忽略真实非零退出，控制器仍须从已持有观察拒绝升级最终成功；回归保护的是阶段组合边界，不允许一个已失败的直接子进程被后续普通回调返回值覆盖。
test("ignored real child failure cannot reach final verification or PASS", async () =>
    fixture(async (root) => {
        let final = false,
            cleaned = false;
        const result = await runEntryOperation({
            journal: { commands: [] },
            produce: async (command) => {
                await command({
                    executable: process.execPath,
                    args: ["-e", "process.exit(9)"],
                    cwd: root,
                    timeoutMs: 5000,
                });
            },
            verifyFinal: async () => {
                final = true;
            },
            cleanup: async () => {
                cleaned = true;
            },
        });
        assert.equal(result.status, "FAILED");
        assert.equal(final, false);
        assert.equal(cleaned, true);
    }));

// 真实 CLI 入口在 Linux 上必须于创建独占根或触发安装前停止，测试通过一个清空环境的真实子进程观察退出与目录；这验证原生门禁确实接入主函数，但不声称具有任何 Mac 项目构建成功证据。
test("actual CLI refuses Linux before any source access installation or scratch creation", async () =>
    fixture(async (root) => {
        if (process.platform === "darwin") return;
        const helper = join(process.cwd(), ".github/scripts/runtime-entries.mjs");
        const result = await runBoundedAssetCli({
            executable: "/usr/bin/env",
            args: [
                "-i",
                `PATH=${process.env.PATH}`,
                "NODE_ENV=production",
                "NODE_DISABLE_COMPILE_CACHE=1",
                "GITHUB_EVENT_NAME=workflow_dispatch",
                "ENTRY_PURPOSE=entry-inputs",
                `GITHUB_SHA=${"a".repeat(40)}`,
                `MANUAL_SOURCE=${"a".repeat(40)}`,
                `EXPECTED_ARCH=${process.arch}`,
                process.execPath,
                helper,
            ],
            cwd: root,
            timeoutMs: 5000,
        });
        assert.equal(result.exit, 1);
        assert.equal(result.closeConfirmed, true);
        assert.match(result.stderr.toString(), /ENTRY_ADMISSION/);
        assert.deepEqual(await readdir(root), []);
    }));
