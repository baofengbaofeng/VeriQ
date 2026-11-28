import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, writeFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeBrowserMode, requireBrowserExecutableMode } from "../src/browser-policy.ts";
import { updatePrivate } from "../src/offline/config.ts";
import { doctor } from "../src/doctor.ts";

/**
 * 诊断实际启动一个记录 argv 的受信测试可执行文件，验证 Playwright 最终生成参数没有禁用沙箱；它本身启动失败，所以不能
 * 申报浏览器可用，真实操作系统沙箱仍由各平台完整业务测试负责验收。
 */
for (const browserMode of ["headless", "headed"] as const) {
    test(`doctor ${browserMode} preserves sandbox and does not inherit host secrets`, async () => {
        const root = await mkdtemp(join(await realpath(tmpdir()), "veriq-browser-policy-"));
        const executablePath = join(root, "chrome");
        const argvPath = join(root, "argv");
        const envPath = join(root, "env");
        const previous = {
            VERIQ_DEVICE_TOKEN: process.env.VERIQ_DEVICE_TOKEN,
            DISPLAY: process.env.DISPLAY,
            XAUTHORITY: process.env.XAUTHORITY,
        };
        process.env.VERIQ_DEVICE_TOKEN = "must-not-reach-browser";
        process.env.DISPLAY = ":123.0";
        process.env.XAUTHORITY = "/tmp/veriq-policy-authority";
        try {
            await writeFile(
                executablePath,
                `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvPath}'\n` +
                    `printf '%s|%s|%s' "$VERIQ_DEVICE_TOKEN" "$DISPLAY" "$XAUTHORITY" > '${envPath}'\nexit 1\n`,
                { mode: 0o700 },
            );
            const result = await doctor({ executablePath, browserMode } as Parameters<typeof doctor>[0]);
            const args = (await readFile(argvPath, "utf8")).split("\n");
            assert.equal(args.includes("--no-sandbox"), false);
            assert.equal(
                args.some((arg) => arg.startsWith("--headless")),
                browserMode === "headless",
            );
            assert.equal(
                await readFile(envPath, "utf8"),
                process.platform === "linux" && browserMode === "headed" ? "|:123.0|/tmp/veriq-policy-authority" : "||",
            );
            assert.equal(result.checks.find((check) => check.name === "browser launch")?.ok, false);
            assert.equal(result.capabilities, undefined);
        } finally {
            for (const [key, value] of Object.entries(previous)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
            await rm(root, { recursive: true, force: true });
        }
    });
}

/**
 * 实际私有配置读写覆盖首次默认、显式选择和省略选项的重启读取，非法已存档案不得被误读为无头默认或被启动过程静默覆盖。
 */
test("private Runtime browser mode persists explicit choices across restarts", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "veriq-browser-config-"));
    try {
        assert.equal(await runtimeBrowserMode(root), "headless");
        assert.equal(await runtimeBrowserMode(root, "headed"), "headed");
        assert.equal(await runtimeBrowserMode(root), "headed");
        await assert.rejects(runtimeBrowserMode(root, "headless\n"), /INVALID_BROWSER_MODE/);
        assert.equal(await runtimeBrowserMode(root), "headed");
        assert.equal(await runtimeBrowserMode(root, "headless"), "headless");
        assert.equal(await runtimeBrowserMode(root), "headless");
        for (const value of [{}, [], { browserMode: false }, { browserMode: "headed", extra: true }]) {
            await updatePrivate(root, "runtime-browser.json", () => value);
            await assert.rejects(runtimeBrowserMode(root), /INVALID_BROWSER_MODE/);
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

/**
 * 真实 CLI 子进程覆盖选项解析、持久化及重启读取的完整链路，Doctor 的失败探针仍记录最终参数；省略选项必须保留有头，
 * 非法显式选项必须在浏览器启动之前拒绝并保留上一代有效配置。
 */
test("CLI browser-mode persists explicit mode and reuses it when the option is omitted", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "veriq-browser-cli-"));
    const executablePath = join(root, "chrome");
    const argvPath = join(root, "argv");
    try {
        await writeFile(executablePath, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvPath}'\nexit 1\n`, { mode: 0o700 });
        for (const [explicit, expected] of [
            ["headed", "headed"],
            [undefined, "headed"],
            ["headless", "headless"],
        ] as const) {
            const child = spawnSync(
                process.execPath,
                [
                    "--import",
                    "tsx",
                    fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
                    "--config-dir",
                    root,
                    ...(explicit ? ["--browser-mode", explicit] : []),
                    "doctor",
                    "--browser-executable",
                    executablePath,
                ],
                { encoding: "utf8", env: { ...process.env, DISPLAY: ":123.0" } },
            );
            assert.equal(child.error, undefined);
            assert.equal(child.status, 1, "The diagnostic observer is not a browser");
            assert.equal(await runtimeBrowserMode(root), expected);
            assert.equal((await readFile(argvPath, "utf8")).includes("--headless"), expected === "headless");
            assert.equal((await readFile(argvPath, "utf8")).includes("--no-sandbox"), false);
        }
        await writeFile(argvPath, "");
        const rejected = spawnSync(
            process.execPath,
            [
                "--import",
                "tsx",
                fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
                "--config-dir",
                root,
                "--browser-mode",
                "HEADLESS",
                "doctor",
                "--browser-executable",
                executablePath,
            ],
            { encoding: "utf8" },
        );
        assert.equal(rejected.status, 1);
        assert.match(rejected.stderr, /INVALID_BROWSER_MODE/);
        assert.equal(await runtimeBrowserMode(root), "headless");
        assert.equal(await readFile(argvPath, "utf8"), "");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

/**
 * 无头专用可执行文件即使存在且可运行，也不能在选择有头模式时被 Doctor 启动；相同文件的无头路径仍保持既有诊断行为，
 * 真实启动标记确保拒绝发生在派生之前，而不是渲染失败后的分类或静默回退。
 */
test("doctor rejects a known headless shell in headed mode before spawning it", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "veriq-headed-shell-"));
    const executablePath = join(root, "chrome-headless-shell");
    const marker = join(root, "launched");
    try {
        await writeFile(executablePath, `#!/bin/sh\nprintf launched > '${marker}'\nexit 1\n`, { mode: 0o700 });
        const headed = await doctor({ executablePath, browserMode: "headed" });
        assert.equal(headed.checks.find((check) => check.name === "browser launch")?.ok, false);
        await assert.rejects(readFile(marker), { code: "ENOENT" });
        const headless = await doctor({ executablePath, browserMode: "headless" });
        assert.equal(headless.checks.find((check) => check.name === "browser launch")?.ok, false);
        assert.equal(await readFile(marker, "utf8"), "launched");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

/**
 * 浏览器模式只是启动配置意图，凭据模式及无头服务兼容性尚未通过时不能提交到私有档案；真实 CLI 拒绝后逐字节核对上一代
 * 配置，防止失败启动永久改变后续 Runtime 的执行模式。
 */
test("rejected CLI credential configuration preserves the previous private browser mode bytes", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "veriq-mode-reject-"));
    try {
        await runtimeBrowserMode(root, "headless");
        const previous = await readFile(join(root, "runtime-browser.json"));
        for (const [credentialOptions, expected] of [
            [["--credential-mode", "unsupported"], /CREDENTIAL_MODE_INVALID/],
            [["--credential-mode", "os-vault"], /RUNTIME_VAULT_CAPABILITY_UNVERIFIED/],
            [
                [
                    "--credential-mode",
                    "restricted-file",
                    "--managed-service-uid",
                    "1",
                    "--persistent-volume",
                    root,
                    "--acknowledge-unencrypted-storage",
                ],
                /VAULT_PLATFORM_UNSUPPORTED|RESTRICTED_FILE_CONTEXT_REQUIRED/,
            ],
        ] as const) {
            const child = spawnSync(
                process.execPath,
                [
                    "--import",
                    "tsx",
                    fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
                    "--config-dir",
                    root,
                    "--browser-mode",
                    "headed",
                    ...credentialOptions,
                    "doctor",
                ],
                { encoding: "utf8" },
            );
            assert.equal(child.status, 1);
            assert.match(child.stderr, expected);
            assert.deepEqual(await readFile(join(root, "runtime-browser.json")), previous);
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

/**
 * 工具目录中的普通 chrome 别名不能遮蔽实际无头专用目标，Doctor 必须在真实派生前拒绝；指向完整 Chrome 形态的正常别名
 * 仍被解析为同一实际目标，不能通过全面禁止软链接来掩盖有头准入错误。
 */
test("headed admission resolves browser aliases and rejects a headless-only target before doctor spawn", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "veriq-browser-alias-"));
    const shell = join(root, "chrome-headless-shell");
    const alias = join(root, "chrome");
    const marker = join(root, "launched");
    try {
        await writeFile(shell, `#!/bin/sh\nprintf launched > '${marker}'\nexit 1\n`, { mode: 0o700 });
        await symlink(shell, alias);
        const result = await doctor({ executablePath: alias, browserMode: "headed" });
        assert.equal(result.checks.find((check) => check.name === "browser launch")?.ok, false);
        await assert.rejects(readFile(marker), { code: "ENOENT" });
        await assert.rejects(requireBrowserExecutableMode(alias, "headed"), /HEADED_BROWSER_REQUIRED/);
        const full = join(root, "chromium");
        const fullAlias = join(root, "chrome.exe");
        await writeFile(full, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
        await symlink(full, fullAlias);
        assert.equal(await requireBrowserExecutableMode(fullAlias, "headed"), full);
        assert.equal(await requireBrowserExecutableMode(alias, "headless"), alias);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
