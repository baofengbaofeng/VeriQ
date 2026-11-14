/** 此跨平台测试以真实 Electron 子进程运行生产保护门闩，退出后用独立 Node24 SQLite 检查实际 Cookie 行并再启动读回；Linux 必须来自自有非空密码 Secret Service，Windows 使用真实 DPAPI，所有结果只代表该目标运行而不冒充用户登录或安装验收。 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const executable = process.env.VERIQ_TEST_ELECTRON;
const evidence = process.env.VERIQ_DESKTOP_EVIDENCE ?? process.env.VERIQ_NATIVE_EVIDENCE;
assert(executable && evidence, "COOKIE_TARGET_CONTEXT_REQUIRED");
assert(["linux", "win32"].includes(process.platform), "COOKIE_TARGET_PLATFORM_REQUIRED");
const value = "VeriQ-public-synthetic-cookie-native-check-2026";

/** 测试驱动只启动工作流已核验的独立 Electron 副本与固定夹具入口，不从档案选择代码或可执行文件；每次调用在有限期限内要求真实退出零且记录非秘密结果，失败不会重试或把没有窗口解释为 Cookie 已受保护。 */
async function launch(profile: string, phase: string) {
    await promisify(execFile)(
        executable!,
        [resolve("tests/native/cookie-app.cjs"), profile, phase],
        {
            timeout: 15000,
            maxBuffer: 65536,
            windowsHide: true,
        },
    );
    return JSON.parse(await readFile(join(profile, `${phase}.json`), "utf8"));
}

test("real Electron protects Cookie database and restores through exact OS provider", async () => {
    const profile = await mkdtemp(join(tmpdir(), "veriq-cookie-native-"));
    try {
        const written = await launch(profile, "write");
        assert.equal(written.electron, "45.3.1");
        assert.equal(written.chrome, "156.0.8078.96");
        assert.equal(written.encrypted, true);
        assert.equal(written.path, join(profile, "Partitions", "veriq-host"));
        const directories = [written.path, join(written.path, "Network")];
        const databases: string[] = [];
        for (const directory of directories) {
            try {
                const path = join(directory, "Cookies");
                const info = await stat(path);
                assert(info.isFile() && info.size < 64 * 1024 * 1024);
                databases.push(path);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
        }
        assert.equal(databases.length, 1);
        const database = new DatabaseSync(databases[0]!, { readOnly: true, timeout: 3000 });
        try {
            const rows = database
                .prepare("SELECT value, encrypted_value FROM cookies WHERE host_key=? AND name=?")
                .all("cookie.veriq.invalid", "veriq_cookie_protection_test");
            assert.equal(rows.length, 1);
            assert.equal(rows[0]!.value, "");
            const ciphertext = Buffer.from(rows[0]!.encrypted_value as Uint8Array);
            assert.equal(ciphertext.subarray(0, 3).toString("ascii"), written.provider);
            assert(ciphertext.length > 32);
            assert.equal(ciphertext.includes(Buffer.from(value)), false);
        } finally {
            database.close();
        }
        assert.equal((await readFile(databases[0]!)).includes(Buffer.from(value)), false);
        const reopened = await launch(profile, "read");
        assert.equal(reopened.provider, written.provider);
        assert.equal(reopened.restored, true);
        await writeFile(
            join(evidence!, "cookie-native-database.json"),
            JSON.stringify(
                {
                    platform: process.platform,
                    electron: written.electron,
                    chrome: written.chrome,
                    provider: written.provider,
                    backend: written.backend,
                    cookieRows: 1,
                    plaintextColumnEmpty: true,
                    plaintextAbsentFromDatabase: true,
                    restoredAfterRestart: true,
                },
                null,
                4,
            ) + "\n",
        );
    } finally {
        await rm(profile, { recursive: true, force: true });
    }
});

if (process.platform === "linux") {
    test("real Linux fixed-key fallback is refused before persistent Cookie Session", async () => {
        const profile = await mkdtemp(join(tmpdir(), "veriq-cookie-fallback-"));
        try {
            assert.deepEqual(await launch(profile, "fallback"), {
                rejected: true,
                code: "COOKIE_OS_PROTECTION_REQUIRED",
            });
            await assert.rejects(stat(join(profile, "Partitions/veriq-host/Cookies")), {
                code: "ENOENT",
            });
        } finally {
            await rm(profile, { recursive: true, force: true });
        }
    });
}
