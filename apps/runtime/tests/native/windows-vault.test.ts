/** Windows Credential Manager 测试仅操作随机测试档案的当前用户通用凭据，通过真实库存 helper 和公开生产消费者执行；不会枚举用户真实保险库、修改登录策略或令牌，也不把构建服务器结果称为 Windows11 桌面安装验收。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { windowsVaultDistribution } from "../fixtures/windows-vault.ts";
import { installedCredentials } from "../../src/credentials/host.ts";
import type { VaultKeyBackend, VaultKeyScope } from "../../src/credentials/backend.ts";
import { CredentialProfile } from "../../src/credentials/profile.ts";
import { SecretStore } from "../../src/credentials/store.ts";
import { DeviceStore } from "../../src/enrollment.ts";

assert.equal(process.platform, "win32");
const signal = () => AbortSignal.timeout(5000);
const helper = () => readFile(new URL("../../build/vault/veriq_agent.exe", import.meta.url));
async function fixture(
    run: (
        root: string,
        backend: VaultKeyBackend,
        distribution: Awaited<ReturnType<typeof windowsVaultDistribution>>["distribution"],
    ) => Promise<void>,
) {
    const own = await windowsVaultDistribution(await helper());
    try {
        await run(own.root, installedCredentials(own.distribution).backend, own.distribution);
    } finally {
        await own.cleanup();
    }
}
async function clean(backend: VaultKeyBackend, scopes: VaultKeyScope[]) {
    for (const scope of scopes) {
        const result = await backend.delete(scope, signal());
        assert(["ok", "missing"].includes(result.status), "VAULT_OWNED_KEY_CLEANUP_FAILED");
    }
}

test("Windows vault requires verified inventory capability and refuses copied objects", async () => {
    const absent = await windowsVaultDistribution();
    try {
        assert.throws(
            () => installedCredentials(absent.distribution),
            /RUNTIME_VAULT_CAPABILITY_UNVERIFIED/,
        );
    } finally {
        await absent.cleanup();
    }
    await fixture(async (_root, backend, distribution) => {
        assert.throws(
            () => installedCredentials({ ...distribution }),
            /RUNTIME_VAULT_CAPABILITY_UNVERIFIED/,
        );
        assert.equal((await backend.probe(signal())).status, "ready");
    });
});

test("real Credential Manager preserves binary key bytes across helpers and refuses conflicting writes", async () =>
    fixture(async (_root, backend, distribution) => {
        const scope = { profileId: randomUUID(), keyVersion: randomUUID() };
        const other = { ...scope, keyVersion: randomUUID() };
        const key = randomBytes(32);
        key[0] = 0;
        key[31] = 255;
        try {
            assert.equal((await backend.get(scope, signal())).status, "missing");
            assert.equal((await backend.set(scope, key, signal())).status, "ok");
            assert.equal((await backend.set(scope, Buffer.from(key), signal())).status, "ok");
            assert.equal((await backend.set(scope, randomBytes(32), signal())).status, "failed");
            const fresh = installedCredentials(distribution).backend;
            const value = await fresh.get(scope, signal());
            assert.equal(value.status, "ok");
            if (value.status === "ok") assert(value.key.equals(key), "VAULT_KEY_BYTES_CHANGED");
            assert.equal((await fresh.get(other, signal())).status, "missing");
            assert.equal((await fresh.delete(scope, signal())).status, "ok");
            assert.equal((await fresh.get(scope, signal())).status, "missing");
        } finally {
            await clean(backend, [scope, other]);
            key.fill(0);
        }
    }));

test("Credential Manager case-insensitive target lookup cannot merge exact UUID scope identities", async () =>
    fixture(async (_root, backend) => {
        const upper = {
            profileId: randomUUID().toUpperCase(),
            keyVersion: "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF",
        };
        const lower = {
            profileId: upper.profileId.toLowerCase(),
            keyVersion: upper.keyVersion.toLowerCase(),
        };
        const otherProfile = { ...upper, profileId: randomUUID() };
        const keys = [randomBytes(32), randomBytes(32)];
        try {
            assert.equal((await backend.set(upper, keys[0]!, signal())).status, "ok");
            assert.equal((await backend.get(lower, signal())).status, "missing");
            assert.equal((await backend.set(lower, keys[1]!, signal())).status, "ok");
            for (const [index, scope] of [upper, lower].entries()) {
                const value = await backend.get(scope, signal());
                assert.equal(value.status, "ok");
                if (value.status === "ok")
                    assert(value.key.equals(keys[index]!), "VAULT_SCOPE_COLLISION");
            }
            assert.equal((await backend.get(otherProfile, signal())).status, "missing");
        } finally {
            await clean(backend, [upper, lower, otherProfile]);
            for (const key of keys) key.fill(0);
        }
    }));

test("production profile migration and reopen use real Windows credentials without disk plaintext", async () =>
    fixture(async (root, backend, distribution) => {
        const profile = join(root, "owned-profile");
        const ref = {
            issuerId: "owned",
            workspaceId: randomUUID(),
            secretRef: "login",
            versionId: randomUUID(),
        };
        const device = {
            server: "https://control.example",
            workspaceId: ref.workspaceId,
            runnerId: randomUUID(),
            deviceToken: "synthetic-windows-vault-device",
            expiresAt: "2027-12-01T00:00:00Z",
        };
        const context = installedCredentials(distribution);
        let scope: VaultKeyScope | undefined;
        try {
            await new SecretStore(profile).set(ref, "synthetic-windows-vault-password");
            await new DeviceStore(profile).save(device);
            await new CredentialProfile(profile, context).migrate();
            const manifest = JSON.parse(
                await readFile(join(profile, "vault/profile.json"), "utf8"),
            );
            scope = { profileId: manifest.profileId, keyVersion: manifest.keyVersion };
            assert.equal(
                await new SecretStore(profile, installedCredentials(distribution)).resolve(ref),
                "synthetic-windows-vault-password",
            );
            assert.deepEqual(await new DeviceStore(profile, context).load(), device);
            for (const name of await readdir(join(profile, "vault"))) {
                const bytes = await readFile(join(profile, "vault", name), "utf8");
                assert.equal(bytes.includes(device.deviceToken), false);
                assert.equal(bytes.includes("synthetic-windows-vault-password"), false);
            }
            await new DeviceStore(profile, context).remove();
            assert.equal(
                await new SecretStore(profile, context).resolve(ref),
                "synthetic-windows-vault-password",
            );
            await new SecretStore(profile, context).clear();
        } finally {
            if (!scope) {
                try {
                    const value = JSON.parse(
                        await readFile(join(profile, "vault/profile.json"), "utf8"),
                    );
                    scope = { profileId: value.profileId, keyVersion: value.keyVersion };
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                }
            }
            if (scope) await clean(backend, [scope]);
        }
    }));

/** 默认关闭的等待目标只用于观察宿主期限和真实子进程退出，正式 helper 字节另行核验且不包含等待命令；已经发送的写入超时必须保持不确定，释放同一路径 fence 需要实际退出，测试不会暂停系统凭据服务。 */
test("Windows helper deadline observes real exit and retains mutation uncertainty", async () => {
    const { WindowsVaultBackend } = await import("../../src/credentials/windows.ts");
    const driver = await readFile(
        new URL("../../build/native-tests/veriq_vault_wait.exe", import.meta.url),
    );
    assert(!driver.equals(await helper()));
    const own = await windowsVaultDistribution(driver);
    const observations: import("../../src/credentials/helper.ts").VaultHelperObservation[] = [];
    try {
        const backend = new WindowsVaultBackend(own.distribution, {
            timeoutMs: 250,
            observe: (value) => observations.push(value),
        });
        const start = performance.now();
        assert.equal(
            (
                await backend.set(
                    { profileId: randomUUID(), keyVersion: randomUUID() },
                    randomBytes(32),
                    signal(),
                )
            ).status,
            "mutation-unconfirmed",
        );
        assert(performance.now() - start < 2000, "VAULT_HELPER_STOP_BUDGET");
        assert.equal(observations.length, 1);
        assert.equal(observations[0]!.exitConfirmed, true);
        assert.equal(observations[0]!.reason, "timeout");
        const controller = new AbortController();
        const pending = backend.probe(controller.signal);
        setTimeout(() => controller.abort(), 100);
        assert.equal((await pending).status, "failed");
        assert.equal(observations.at(-1)!.reason, "cancelled");
        assert.equal(observations.at(-1)!.exitConfirmed, true);
    } finally {
        await own.cleanup();
    }
});

/** 正式 helper 的输入协议只接受单个有界版本帧，测试通过真实匿名管道保留输入直到程序自然退出；未知命令不能成为诊断后门，父端提前关闭时必须看到明确的控制关闭退出而非无限残留进程。 */
test("formal Windows helper refuses malformed frames and exits on owned control EOF", async () => {
    const { spawn } = await import("node:child_process");
    const own = await windowsVaultDistribution(await helper());
    async function invoke(frame?: string) {
        const child = spawn(join(own.distribution.root, "native/vault/veriq_agent.exe"), [], {
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        });
        let stdout = "",
            stderr = "";
        let excess = false;
        child.stdout.on("data", (bytes: Buffer) => {
            if (stdout.length + bytes.length > 512) {
                excess = true;
                child.kill("SIGKILL");
            } else stdout += String(bytes);
        });
        child.stderr.on("data", (bytes: Buffer) => {
            if (stderr.length + bytes.length > 4096) {
                excess = true;
                child.kill("SIGKILL");
            } else stderr += String(bytes);
        });
        child.stdin.on("error", () => child.stdin.destroy());
        const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
        try {
            if (frame === undefined) child.stdin.destroy();
            else child.stdin.write(frame);
            const result = await new Promise<{ code: number | null; signal: string | null }>(
                (resolve, reject) => {
                    child.once("error", reject);
                    child.once("close", (code, signal) => resolve({ code, signal }));
                },
            );
            assert.equal(excess, false, "VAULT_HELPER_OUTPUT_LIMIT");
            assert.equal(result.signal, null);
            assert.equal(stdout, "");
            assert.equal(stderr, "");
            return result.code;
        } finally {
            clearTimeout(timer);
            child.stdin.destroy();
        }
    }
    try {
        assert.equal(await invoke("V1 wait\n"), 2);
        assert.equal(await invoke("V1 get invalid invalid\n"), 2);
        assert.equal(await invoke("x".repeat(512)), 2);
        assert.equal(await invoke(), 125);
    } finally {
        await own.cleanup();
    }
});

/** 父进程死亡测试让真实 Node 宿主持有等待 helper 的匿名输入，再仅终止本测试拥有的宿主；观察 helper 的当前 SID 与完整创建时间后确认原进程已退出，不用同名枚举或向一个重新查到的数字 PID 发送终止。 */
test("Windows helper exits when its actual owning parent dies with control open", async () => {
    const { spawn } = await import("node:child_process");
    const { setTimeout: delay } = await import("node:timers/promises");
    const { windowsNative } = await import("../../src/native/windows.ts");
    const own = await windowsVaultDistribution(
        await readFile(new URL("../../build/native-tests/veriq_vault_wait.exe", import.meta.url)),
    );
    const executable = join(own.distribution.root, "native/vault/veriq_agent.exe");
    const script = `import {spawn} from 'node:child_process';const child=spawn(process.argv[1],[],{stdio:['pipe','pipe','pipe'],windowsHide:true});child.stdin.write('V1 probe\\n');let output='';child.stdout.on('data',part=>{output+=part;if(output==='V1 test-ready\\n')process.stdout.write(JSON.stringify({pid:child.pid})+'\\n');});child.once('error',()=>{process.exitCode=2;});`;
    const parent = spawn(process.execPath, ["--input-type=module", "-e", script, executable], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
    });
    let output = "",
        stderr = "",
        closed = false;
    let excess = false;
    parent.stdout.on("data", (part: Buffer) => {
        if (output.length + part.length > 512) {
            excess = true;
            parent.kill("SIGKILL");
        } else output += String(part);
    });
    parent.stderr.on("data", (part: Buffer) => {
        if (stderr.length + part.length > 4096) {
            excess = true;
            parent.kill("SIGKILL");
        } else stderr += String(part);
    });
    const close = new Promise<void>((resolve, reject) => {
        parent.once("error", reject);
        parent.once("close", () => {
            closed = true;
            resolve();
        });
    });
    try {
        const deadline = performance.now() + 5000;
        while (!output.includes("\n")) {
            assert(!closed && performance.now() < deadline, "VAULT_PARENT_READY_TIMEOUT");
            assert(output.length < 512 && stderr.length < 4096);
            await delay(10);
        }
        const pid = Number(JSON.parse(output.trim()).pid);
        assert(Number.isSafeInteger(pid) && pid > 0);
        const initial = windowsNative().identity(pid);
        assert(initial?.running);
        assert.equal(initial.sid, windowsNative().sid);
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const observed = await promisify(execFile)(
            join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
            [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                `$ErrorActionPreference='Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-Process -Id ${pid} | Select-Object Id,ProcessName,Path | ConvertTo-Json -Compress`,
            ],
            { timeout: 10000, maxBuffer: 4096, windowsHide: true },
        );
        const physical = JSON.parse(observed.stdout);
        assert.equal(observed.stderr, "");
        assert.equal(physical.Id, pid);
        assert.equal(physical.ProcessName, "veriq_agent");
        assert.equal(physical.Path.toLowerCase(), executable.toLowerCase());
        assert.equal(windowsNative().identity(pid)?.startTime, initial.startTime);
        console.log(
            "VAULT_WINDOWS_OWNED_HELPER",
            JSON.stringify({
                pid,
                startTime: initial.startTime,
                sid: initial.sid,
                name: physical.ProcessName,
                path: physical.Path,
            }),
        );
        assert.equal(parent.kill("SIGKILL"), true);
        await close;
        const stop = performance.now() + 3000;
        for (;;) {
            const current = windowsNative().identity(pid);
            if (!current || current.startTime !== initial.startTime || !current.running) break;
            assert(performance.now() < stop, "VAULT_PARENT_DEATH_HELPER_RETAINED");
            await delay(10);
        }
        assert.equal(excess, false, "VAULT_PARENT_OUTPUT_LIMIT");
        assert.equal(stderr, "");
    } finally {
        if (!closed) {
            parent.kill("SIGKILL");
            await close;
        }
        await own.cleanup();
    }
});
