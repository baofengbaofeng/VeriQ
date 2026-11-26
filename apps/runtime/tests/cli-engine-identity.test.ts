import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { create } from "tar";
import { validateSchema, type ApprovedEngineInventoryV1 } from "@veriq/contracts";

/**
 * 每个场景创建私有且可独立清理的选择测试库存，真实文件摘要必须通过正式装载器；归档只含包清单，不代表可执行引擎验收。
 */
async function inventoryFixture(run: (root: string, inventory: ApprovedEngineInventoryV1) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), "veriq-cli-engine-"));
    try {
        await chmod(root, 0o700);
        await mkdir(join(root, "engine"), { mode: 0o700 });
        await writeFile(
            join(root, "package.json"),
            JSON.stringify({ name: "veriq-engine-selection-test", version: "0.1.0", private: true }),
            { mode: 0o600 },
        );
        await writeFile(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }), {
            mode: 0o600,
        });
        await writeFile(join(root, "dependencies.json"), "[]", { mode: 0o600 });
        await create({ cwd: root, file: join(root, "engine/compiler.tgz"), gzip: true }, ["package.json"]);
        await chmod(join(root, "engine/compiler.tgz"), 0o600);
        const files = [];
        for (const path of ["package.json", "package-lock.json", "dependencies.json", "engine/compiler.tgz"]) {
            const bytes = await readFile(join(root, path));
            files.push({ path, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
        }
        const inventory: ApprovedEngineInventoryV1 = {
            schemaVersion: "1.0",
            engines: [
                {
                    engineVersion: "0.1.0",
                    compilerVersion: "0.1.0",
                    runnerSdkVersion: "0.1.0",
                    dependencies: [],
                    files,
                },
            ],
        };
        assert.deepEqual(validateSchema("ApprovedEngineInventoryV1", inventory), []);
        await run(root, inventory);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

/**
 * 子进程直接运行源码命令并使用必定不存在的浏览器路径，输出超限或超时立即终止；等待关闭另设上限，避免清理依赖悬挂管道。
 */
async function startSource(t: TestContext, root: string, inventory: unknown) {
    await writeFile(join(root, "inventory.json"), JSON.stringify(inventory), { mode: 0o600 });
    const cwd = fileURLToPath(new URL("..", import.meta.url));
    const argv = [
        "--import",
        "tsx",
        "src/cli.ts",
        "--config-dir",
        join(root, "profile"),
        "runtime",
        "start",
        "--release-dir",
        root,
        "--browser-executable",
        join(root, "absent-browser"),
        "--once",
    ];
    const started = performance.now();
    const child = spawn(process.execPath, argv, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let failure: Error | undefined;
    const stop = (error: Error) => {
        failure ??= error;
        child.kill("SIGKILL");
    };
    child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 64 * 1024) stop(new Error("CLI_OUTPUT_LIMIT"));
        else stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 64 * 1024) stop(new Error("CLI_OUTPUT_LIMIT"));
        else stderr += chunk.toString();
    });
    const deadline = setTimeout(() => stop(new Error("CLI_TIMEOUT")), 15_000);
    let closeDeadline: ReturnType<typeof setTimeout> | undefined;
    try {
        const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
            closeDeadline = setTimeout(() => {
                stop(new Error("CLI_CLOSE_TIMEOUT"));
                reject(failure);
            }, 18_000);
            child.once("error", reject);
            child.once("close", (code, signal) => resolve({ code, signal }));
        });
        t.diagnostic(
            JSON.stringify({
                argv: [process.execPath, ...argv],
                cwd,
                ...result,
                ms: performance.now() - started,
                stdout,
                stderr,
            }),
        );
        if (failure) throw failure;
        assert.equal(result.signal, null);
        assert.equal(result.code, 1);
        assert.equal(stdout, "");
        return stderr;
    } finally {
        clearTimeout(deadline);
        clearTimeout(closeDeadline);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
    }
}

/**
 * 源码登记使用现有零点一身份，启动必须选中相同批准库存才进入真实自检；缺失浏览器仍应失败关闭，不声明设备或执行已就绪。
 */
test("source CLI selects approved 0.1.0 before missing-browser doctor refusal", async (t) => {
    await inventoryFixture(async (root, inventory) => {
        const stderr = await startSource(t, root, inventory);
        assert.match(stderr, /VeriQ: DOCTOR_FAILED\./);
        assert.doesNotMatch(stderr, /ENGINE_NOT_APPROVED/);
    });
});

/**
 * 运维目录即使只批准旧错误常量也不能被自动选择，源码身份必须精确匹配零点一条目；此拒绝发生在浏览器或设备凭据访问之前。
 */
test("source CLI refuses inventory approving only 1.0.0", async (t) => {
    await inventoryFixture(async (root, inventory) => {
        const entry = inventory.engines[0];
        assert.ok(entry);
        entry.engineVersion = "1.0.0";
        const stderr = await startSource(t, root, inventory);
        assert.match(stderr, /VeriQ: ENGINE_NOT_APPROVED\./);
        assert.doesNotMatch(stderr, /DOCTOR_FAILED/);
    });
});

/**
 * 正确源码版本也必须经过完整结构校验，未知属性不能被选中条目或浏览器故障掩盖；测试只改变库存数据而不替换正式验证过程。
 */
test("source CLI refuses invalid inventory schema", async (t) => {
    await inventoryFixture(async (root, inventory) => {
        const stderr = await startSource(t, root, { ...inventory, approved: true });
        assert.match(stderr, /VeriQ: INVALID_ENGINE_INVENTORY\./);
        assert.doesNotMatch(stderr, /DOCTOR_FAILED/);
    });
});

/**
 * 已批准条目的文件字节变化时必须保留摘要拒绝，不能因为源码版本一致就直接调用自检；清单继续记录修改前的真实文件摘要。
 */
test("source CLI refuses changed approved file bytes", async (t) => {
    await inventoryFixture(async (root, inventory) => {
        await writeFile(join(root, "dependencies.json"), "{}", { mode: 0o600 });
        const stderr = await startSource(t, root, inventory);
        assert.match(stderr, /VeriQ: RELEASE_HASH_MISMATCH\./);
        assert.doesNotMatch(stderr, /DOCTOR_FAILED/);
    });
});
