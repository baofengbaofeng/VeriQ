/** 集成测试直接调用生产凭据消费者并读取其真实私有文件，内存后端只替代当前宿主没有的系统密钥服务；真实加密、原子发布、锁和恢复均由生产代码执行，断言不能依赖夹具自行保存业务秘密。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VaultKeyBackend, VaultKeyScope } from "../src/credentials/backend.ts";
import { SecretStore } from "../src/credentials/store.ts";
import { DeviceStore } from "../src/enrollment.ts";

/** 测试后端仅保留按精确档案和版本分隔的随机密钥副本，并允许测试施加真实消费者可见的失败状态；它不会接触业务载荷或文件，因而不能代替生产加密读写及错误传播的被测行为。 */
class MemoryKeys implements VaultKeyBackend {
    keys = new Map<string, Buffer>();
    state: "ok" | "locked" | "unavailable" = "ok";
    writes = 0;
    uncertain = false;
    async get(scope: VaultKeyScope) {
        if (this.state !== "ok") return { status: this.state } as const;
        const key = this.keys.get(JSON.stringify(scope));
        return key
            ? { status: "ok" as const, key: Buffer.from(key) }
            : { status: "missing" as const };
    }
    async set(scope: VaultKeyScope, key: Buffer) {
        this.writes++;
        this.keys.set(JSON.stringify(scope), Buffer.from(key));
        return { status: this.uncertain ? ("mutation-unconfirmed" as const) : ("ok" as const) };
    }
    async delete(scope: VaultKeyScope) {
        return {
            status: this.keys.delete(JSON.stringify(scope))
                ? ("ok" as const)
                : ("missing" as const),
        };
    }
    async probe() {
        return { status: "ready" as const };
    }
}
const reference = {
    issuerId: "issuer",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    secretRef: "login",
    versionId: "22222222-2222-4222-8222-222222222222",
};
const device = {
    server: "https://control.example",
    runnerId: "33333333-3333-4333-8333-333333333333",
    workspaceId: reference.workspaceId,
    deviceToken: "sensitive-device-" + "d".repeat(43),
    expiresAt: "2027-12-01T00:00:00Z",
};
async function fixture(run: (directory: string, backend: MemoryKeys) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), "veriq-vault-integration-"));
    const directory = join(root, "profile");
    const { privateDirectory } = await import("../src/offline/config.ts");
    try {
        await privateDirectory(directory);
        await run(directory, new MemoryKeys());
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}
async function disk(directory: string): Promise<string> {
    const entries = await readdir(directory, { withFileTypes: true });
    return (
        await Promise.all(
            entries.map(async (entry) =>
                entry.isDirectory()
                    ? disk(join(directory, entry.name))
                    : readFile(join(directory, entry.name), "utf8"),
            ),
        )
    ).join("\n");
}

test("SecretStore persists encrypted exact references and shares one stable key after reopening", async () =>
    fixture(async (directory, backend) => {
        const store = new SecretStore(directory, { backend });
        await store.set(reference, { password: "business-secret-marker" });
        assert.equal((await disk(directory)).includes("business-secret-marker"), false);
        assert.equal(backend.writes, 1);
        assert.deepEqual(await new SecretStore(directory, { backend }).resolve(reference), {
            password: "business-secret-marker",
        });
        await assert.rejects(
            store.resolve({ ...reference, versionId: device.runnerId }),
            /LOCAL_CREDENTIAL_MISSING/,
        );
        await store.remove(reference);
        await assert.rejects(store.resolve(reference), /LOCAL_CREDENTIAL_MISSING/);
        assert.equal(backend.keys.size, 1);
    }));

test("SecretStore distinguishes locked unavailable and missing master key without replacement", async () =>
    fixture(async (directory, backend) => {
        const store = new SecretStore(directory, { backend });
        await store.set(reference, "protected");
        backend.state = "locked";
        await assert.rejects(store.resolve(reference), /VAULT_LOCKED/);
        backend.state = "unavailable";
        await assert.rejects(store.resolve(reference), /VAULT_UNAVAILABLE/);
        backend.state = "ok";
        backend.keys.clear();
        await assert.rejects(store.set(reference, "must-not-overwrite"), /VAULT_KEY_MISSING/);
        assert.equal(backend.writes, 1);
    }));

test("uncertain initial key write resumes exact version by readback without another key write", async () =>
    fixture(async (directory, backend) => {
        backend.uncertain = true;
        await assert.rejects(
            new SecretStore(directory, { backend }).set(reference, "first"),
            /VAULT_MUTATION_UNCONFIRMED/,
        );
        assert.equal(backend.writes, 1);
        const recovered = new SecretStore(directory, { backend });
        await recovered.set(reference, "after-recovery");
        assert.equal(await recovered.resolve(reference), "after-recovery");
        assert.equal(backend.writes, 1);
    }));

test("DeviceStore and business storage share profile key while remove preserves other purpose", async () =>
    fixture(async (directory, backend) => {
        const secrets = new SecretStore(directory, { backend });
        const store = new DeviceStore(directory, { backend });
        await secrets.set(reference, "retained-business-value");
        await store.save(device);
        assert.equal((await disk(directory)).includes(device.deviceToken), false);
        assert.deepEqual(await new DeviceStore(directory, { backend }).load(), device);
        await assert.rejects(store.save(device), /ALREADY_ENROLLED/);
        await store.remove();
        await assert.rejects(store.load(), { code: "ENOENT" });
        assert.equal(await secrets.resolve(reference), "retained-business-value");
        assert.equal(backend.writes, 1);
    }));

/** 丢失轮换响应必须保留同一加密候选而不是生成新令牌，真实本机 HTTP 服务记录两次请求相等；磁盘检查同时覆盖旧设备与候选中的替换秘密，恢复后业务凭据仍须可用且候选已经退休。 */
test("encrypted DeviceStore rotation resumes the same request after a lost HTTP response", async () =>
    fixture(async (directory, backend) => {
        const { createServer } = await import("node:http");
        const { RuntimeClient } = await import("../src/enrollment.ts");
        let candidate: { replacementToken: string; clientRequestId: string } | undefined;
        let requests = 0;
        const server = createServer(async (req, res) => {
            let wire = "";
            for await (const part of req) wire += part;
            const value = JSON.parse(wire);
            if (candidate) assert.deepEqual(value, candidate);
            else candidate = value;
            requests++;
            if (requests === 1) {
                req.socket.destroy();
                return;
            }
            res.end(
                JSON.stringify({
                    data: {
                        runnerId: device.runnerId,
                        workspaceId: device.workspaceId,
                        deviceToken: candidate!.replacementToken,
                        expiresAt: device.expiresAt,
                    },
                }),
            );
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        try {
            const address = server.address();
            assert(address && typeof address !== "string");
            const serverOrigin = `http://127.0.0.1:${address.port}`;
            const store = new DeviceStore(directory, { backend });
            await store.save({ ...device, server: serverOrigin });
            await assert.rejects(
                store.renew(new RuntimeClient(serverOrigin)),
                /NETWORK_UNAVAILABLE/,
            );
            assert(candidate);
            assert.equal(await store.hasPendingRotation(), true);
            const bytes = await disk(directory);
            assert.equal(bytes.includes(device.deviceToken), false);
            assert.equal(bytes.includes(candidate.replacementToken), false);
            const recovered = await new DeviceStore(directory, { backend }).renew(
                new RuntimeClient(serverOrigin),
            );
            assert.equal(recovered.deviceToken, candidate.replacementToken);
            assert.equal(await store.hasPendingRotation(), false);
            assert.equal(requests, 2);
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    }));

/** 业务容量仍按旧聚合 JSON 计算，接近一兆字节的真实 storageState 会产生超过一兆字节的密文；第二条短值与超额失败分别验证没有错误计入信封开销，也没有在拒绝后改变已确认的凭据。 */
test("large storageState keeps the original aggregate quota beyond one MiB ciphertext", async () =>
    fixture(async (directory, backend) => {
        const store = new SecretStore(directory, { backend });
        const value = { cookies: [{ value: "z".repeat(1024 * 1024 - 2048) }], origins: [] };
        await store.set(reference, value);
        await store.set({ ...reference, secretRef: "second" }, "small");
        assert.deepEqual(await store.resolve(reference), value);
        const entries = await readdir(join(directory, "vault"));
        const ciphertexts = await Promise.all(
            entries
                .filter((name) => name.startsWith("record-"))
                .map((name) => readFile(join(directory, "vault", name))),
        );
        assert(ciphertexts.some((bytes) => bytes.length > 1024 * 1024));
        await assert.rejects(
            store.set({ ...reference, secretRef: "tooBig" }, "q".repeat(4096)),
            /CONFIGURATION_LIMIT/,
        );
        assert.deepEqual(await store.resolve(reference), value);
    }));

/** 旧档案必须经明确停止迁移才可进入正常加密消费，测试先使用原公开接口建立真实明文，再检验拒绝、完整读回和退休；现有业务及设备语义保持，迁移后新实例只能依赖系统密钥与已发布密文。 */
test("explicit stopped migration covers business device and rotation before retiring plaintext", async () =>
    fixture(async (directory, backend) => {
        const { CredentialProfile } = await import("../src/credentials/profile.ts");
        const { updatePrivate } = await import("../src/offline/config.ts");
        await new SecretStore(directory).set(reference, { password: "legacy-marker" });
        await new DeviceStore(directory).save(device);
        const pending = {
            previous: device,
            clientRequestId: "44444444-4444-4444-8444-444444444444",
            replacementToken: "replacement-" + "r".repeat(43),
        };
        await updatePrivate(directory, "rotation.json", () => pending);
        await assert.rejects(
            new SecretStore(directory, { backend }).resolve(reference),
            /VAULT_MIGRATION_REQUIRED/,
        );
        const profile = new CredentialProfile(directory, { backend });
        assert.equal(typeof profile.migrate, "function");
        await profile.migrate();
        assert.deepEqual(await new SecretStore(directory, { backend }).resolve(reference), {
            password: "legacy-marker",
        });
        assert.deepEqual(await new DeviceStore(directory, { backend }).load(), device);
        assert.equal(await new DeviceStore(directory, { backend }).hasPendingRotation(), true);
        for (const name of ["local-secrets.json", "device.json", "rotation.json"])
            await assert.rejects(readFile(join(directory, name)), { code: "ENOENT" });
        const bytes = await disk(directory);
        assert.equal(bytes.includes("legacy-marker"), false);
        assert.equal(bytes.includes(device.deviceToken), false);
        assert.equal(bytes.includes(pending.replacementToken), false);
    }));

/** 真实文件权限故障发生在清单已经提交后的旧记录退休阶段，测试不模拟加密或文件接口；恢复必须完成同一删除而不是假称回滚、重新运行更新函数或重新激活仍留在磁盘上的旧密文。 */
test("post-commit retirement failure resumes cleanup without resurrecting deleted business data", async () =>
    fixture(async (directory, backend) => {
        const { chmod } = await import("node:fs/promises");
        const store = new SecretStore(directory, { backend });
        await store.set(reference, "retire-me");
        const vault = join(directory, "vault");
        const file = (await readdir(vault)).find((name) => name.startsWith("record-"))!;
        await chmod(join(vault, file), 0o400);
        try {
            await assert.rejects(
                store.clear(),
                process.platform === "win32"
                    ? /NATIVE_PRIVATE_REMOVE_FAILED/
                    : /VAULT_FILE_NOT_PRIVATE/,
            );
        } finally {
            await chmod(join(vault, file), 0o600);
        }
        await assert.rejects(
            new SecretStore(directory, { backend }).resolve(reference),
            /LOCAL_CREDENTIAL_MISSING/,
        );
        await assert.rejects(readFile(join(vault, file)), { code: "ENOENT" });
        assert.equal(backend.writes, 1);
    }));

/** 活动 Agent 的真实合作锁必须阻止整个迁移事务，失败后旧明文字节保持原样；释放停止所有权后同一个显式操作才可继续，不能把短暂检查到停止状态解释为迁移期间仍拥有排他权限。 */
test("migration refuses active Agent ownership and preserves original bytes until release", async () =>
    fixture(async (directory, backend) => {
        const { CredentialProfile } = await import("../src/credentials/profile.ts");
        const { privateDirectory } = await import("../src/offline/config.ts");
        const { default: lockfile } = await import("proper-lockfile");
        await new SecretStore(directory).set(reference, "owned-legacy");
        const before = await readFile(join(directory, "local-secrets.json"));
        const owner = join(directory, "agent-owner");
        await privateDirectory(owner);
        const release = await lockfile.lock(owner, { retries: 0 });
        try {
            await assert.rejects(
                new CredentialProfile(directory, { backend }).migrate(),
                /AGENT_RUNNING_STOP_FIRST/,
            );
        } finally {
            await release();
        }
        assert.deepEqual(await readFile(join(directory, "local-secrets.json")), before);
        await new CredentialProfile(directory, { backend }).migrate();
        assert.equal(
            await new SecretStore(directory, { backend }).resolve(reference),
            "owned-legacy",
        );
    }));

/** 清单丢失不能使现存密文被当成空档案并生成替代密钥，测试删除当前私有清单后再次调用真实消费者；原密钥写入次数和已落盘密文都必须保持，明确错误要求恢复元数据而非静默覆盖。 */
test("missing profile manifest with existing ciphertext refuses replacement initialization", async () =>
    fixture(async (directory, backend) => {
        const { unlink } = await import("node:fs/promises");
        const store = new SecretStore(directory, { backend });
        await store.set(reference, "must-survive");
        const before = await readdir(join(directory, "vault"));
        await unlink(join(directory, "vault", "profile.json"));
        await assert.rejects(
            new SecretStore(directory, { backend }).set(reference, "replacement"),
            /VAULT_PROFILE_MISSING/,
        );
        assert.equal(backend.writes, 1);
        for (const name of before.filter((value) => value.startsWith("record-")))
            assert((await readFile(join(directory, "vault", name))).length > 0);
    }));

/** 单独的 CLI 迁移必须同时排除仍持有桌面后台所有权的进程，否则在线锁空闲不能证明离线执行已经停止；真实合作锁下的拒绝必须发生在写入密钥或退休旧明文之前，保持原字节与后端状态不变。 */
test("migration refuses a separately owned Desktop Agent even when the online Agent lock is free", async () =>
    fixture(async (directory, backend) => {
        const { CredentialProfile } = await import("../src/credentials/profile.ts");
        const { privateDirectory } = await import("../src/offline/config.ts");
        const { default: lockfile } = await import("proper-lockfile");
        await new SecretStore(directory).set(reference, "desktop-owned-legacy");
        const owner = join(directory, "desktop-owner");
        await privateDirectory(owner);
        const release = await lockfile.lock(owner, { retries: 0 });
        try {
            await assert.rejects(
                new CredentialProfile(directory, { backend }).migrate(),
                /AGENT_RUNNING_STOP_FIRST/,
            );
        } finally {
            await release();
        }
        assert.equal(backend.writes, 0);
        assert.equal(await new SecretStore(directory).resolve(reference), "desktop-owned-legacy");
    }));

/** 信封文件入口必须实际容纳两兆字节但拒绝再多一个字节，一般配置入口仍保持原一兆额度；测试对已确认文件进行超额替换后核验原字节未变，不能把 JavaScript 字符长度或配置上限当作原生能力证明。 */
test("vault file boundary accepts two MiB while oversized replacement and general config remain bounded", async () =>
    fixture(async (directory) => {
        const { VaultFiles } = await import("../src/credentials/files.ts");
        const { updatePrivate } = await import("../src/offline/config.ts");
        const files = await VaultFiles.acquire(join(directory, "vault"));
        const value = "v".repeat(2 * 1024 * 1024);
        try {
            await files.write("profile-next.json", value);
            assert.equal(await files.read("profile-next.json"), value);
            await assert.rejects(
                files.write("profile-next.json", value + "x"),
                /VAULT_ENVELOPE_LIMIT/,
            );
            assert.equal(await files.read("profile-next.json"), value);
            await assert.rejects(
                updatePrivate(directory, "bounded.json", () => value),
                /CONFIGURATION_LIMIT/,
            );
            await files.remove("profile-next.json");
            assert.equal(await files.read("profile-next.json"), undefined);
        } finally {
            await files.close();
        }
    }));

/** 未知停止与正在恢复的离线占用即使没有活着的 Agent 锁也不能迁移，测试使用真实 SQLite 所有权转换后关闭连接再重新读取；拒绝发生在系统密钥创建和明文退休之前，不依据内存 Promise 或进程缺失推断停止。 */
test("migration refuses durable quarantined and recovering worker ownership", async () =>
    fixture(async (directory, backend) => {
        const { LocalStore } = await import("../src/offline/store.ts");
        const { CredentialProfile } = await import("../src/credentials/profile.ts");
        await new SecretStore(directory).set(reference, "quarantined-legacy");
        const local = await LocalStore.open(join(directory, "offline"));
        const owner = local.reserve(reference.workspaceId, device.runnerId, reference.versionId);
        local.spawning(owner.runId, owner.attemptId, owner);
        local.stopped(
            owner.runId,
            {
                attemptId: owner.attemptId,
                processStopped: false,
                reason: "UNKNOWN_PROCESS",
                stoppedAt: new Date().toISOString(),
            },
            local.active()!,
        );
        try {
            assert.equal(local.active()?.state, "QUARANTINED");
            await assert.rejects(
                new CredentialProfile(directory, { backend }).migrate(),
                /VAULT_RUNTIME_RECOVERY_REQUIRED/,
            );
            local.claimRecovery(local.active()!);
            assert.equal(local.active()?.state, "RECOVERING");
            await assert.rejects(
                new CredentialProfile(directory, { backend }).migrate(),
                /VAULT_RUNTIME_RECOVERY_REQUIRED/,
            );
            assert.equal(backend.writes, 0);
            assert.equal(await new SecretStore(directory).resolve(reference), "quarantined-legacy");
        } finally {
            local.close();
        }
    }));

/** 空闲守卫必须实际阻止同进程另一 SQLite 连接和独立 OS 进程插入执行占用，测试使用原 reserve API 与原三秒忙等待；守卫释放后同一真实子程序才能登记成功，不能仅检查一个虚构锁标志。 */
test("idle migration guard excludes concurrent reservations across connections and OS processes", async () =>
    fixture(async (directory) => {
        const { LocalStore } = await import("../src/offline/store.ts");
        const { spawnSync } = await import("node:child_process");
        const execution = join(directory, "offline");
        const holding = await LocalStore.open(execution);
        const competing = await LocalStore.open(execution);
        const release = holding.holdIdle();
        const script = `import {LocalStore} from ${JSON.stringify(new URL("../src/offline/store.ts", import.meta.url).href)};
let store;try {store=await LocalStore.open(process.argv[1]);store.reserve('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222');}
catch(error){process.exitCode=String(error.message).includes('locked')?41:42;}finally{store?.close();}`;
        const child = () =>
            spawnSync(
                process.execPath,
                ["--import", "tsx", "--input-type=module", "-e", script, execution],
                { timeout: 10000, encoding: "utf8", maxBuffer: 4096 },
            );
        try {
            assert.throws(
                () =>
                    competing.reserve(reference.workspaceId, device.runnerId, reference.versionId),
                /locked/,
            );
            const blocked = child();
            assert.equal(blocked.error, undefined);
            assert.equal(blocked.signal, null);
            assert.equal(blocked.status, 41, blocked.stderr);
            assert.equal(holding.active(), undefined);
        } finally {
            release();
            competing.close();
            holding.close();
        }
        const accepted = child();
        assert.equal(accepted.error, undefined);
        assert.equal(accepted.signal, null);
        assert.equal(accepted.status, 0, accepted.stderr);
    }));
