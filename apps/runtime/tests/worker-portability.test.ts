import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { offlineWorkerEnvironment } from "../src/offline/worker-environment.ts";

/** 本例实际启动既有 worker 并提供带空格与中文路径的 npm JavaScript 入口，检查它通过当前角色 Node 执行而不误用系统 shell 或相邻 npm 脚本；随后缺失编译归档应停在提取阶段。 */
test("worker executes the supplied npm JavaScript with its role Node", async () => {
    const root = await mkdtemp(join(tmpdir(), "veriq npm 中文 "));
    try {
        const cli = join(root, "npm cli.cjs");
        await mkdir(join(root, "tmp"));
        await writeFile(
            cli,
            "require('fs').writeFileSync('npm-observed.json', JSON.stringify({execPath:process.execPath,args:process.argv.slice(2)}));",
        );
        await writeFile(
            join(root, "invocation.json"),
            JSON.stringify({ kind: "TEST", work: root, tmp: join(root, "tmp"), npmCli: cli }),
        );
        const child = fork(
            fileURLToPath(new URL("../src/execution/worker.mjs", import.meta.url)),
            [join(root, "invocation.json")],
            { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] },
        );
        const exit = new Promise<number | null>((resolve, reject) => {
            child.once("error", reject);
            child.once("exit", resolve);
        });
        child.send({ type: "START" });
        assert.equal(await exit, 1);
        const result = await readFile(join(root, "npm-observed.json"), "utf8").catch(() => "null");
        assert.notEqual(result, "null", "the supplied npm CLI must run before archive extraction");
        const observed = JSON.parse(result);
        assert.equal(observed.execPath, process.execPath);
        assert.deepEqual(observed.args.slice(0, 3), ["ci", "--offline", "--ignore-scripts"]);
        assert.equal(
            JSON.parse(await readFile(join(root, "worker-failure.json"), "utf8")).failureCode,
            "COMPILER_EXTRACTION_FAILED",
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

/** Windows 环境构造在任何开发宿主上都可验证纯路径和白名单规则，真正系统进程及 ACL 验收仍属于后续目标机器；该检查防止复用 Linux 冒号 PATH 或复制设备令牌到业务子进程。 */
test("Windows worker environment uses bounded native paths without host secrets", () => {
    const result = offlineWorkerEnvironment(
        "C:\\工作\\tmp",
        "C:\\工作\\provider.mjs",
        true,
        { SystemRoot: "C:\\Windows", VERIQ_DEVICE_TOKEN: "secret", PATH: "unsafe" },
        { platform: "win32", runnerExecutable: "C:\\Program Files\\VeriQ\\veriq_runner.exe" },
    );
    assert.equal(result.PATH, "C:\\Program Files\\VeriQ;C:\\Windows\\System32");
    assert.equal(result.TEMP, "C:\\工作\\tmp");
    assert.equal(result.SystemRoot, "C:\\Windows");
    assert.equal(result.VERIQ_DEVICE_TOKEN, undefined);
    assert.throws(
        () =>
            offlineWorkerEnvironment(
                "C:\\tmp",
                "C:\\provider.mjs",
                true,
                { SystemRoot: "relative" },
                { platform: "win32", runnerExecutable: "C:\\veriq_runner.exe" },
            ),
        /WINDOWS_SYSTEM_ROOT_INVALID/,
    );
});
