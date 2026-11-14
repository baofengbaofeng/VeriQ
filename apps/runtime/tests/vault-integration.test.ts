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

/** 大量短条目从真实受限旧文件一次迁移到独立认证记录，业务聚合仍小于一兆而密文总量实际超过两兆；测试核验全部引用并检查旧文件退休，防止把单文件信封上限误用作整个保险库容量或只覆盖单个大 storageState。 */
test("many short credentials preserve one MiB business quota beyond two MiB aggregate ciphertext", async () =>
    fixture(async (directory, backend) => {
        const { CredentialProfile } = await import("../src/credentials/profile.ts");
        const { updatePrivate } = await import("../src/offline/config.ts");
        const values: Record<string, string> = {};
        const refs = Array.from({ length: 4000 }, (_, index) => ({
            ...reference,
            secretRef: `entry${String(index).padStart(4, "0")}`,
        }));
        for (const ref of refs)
            values[JSON.stringify([ref.issuerId, ref.workspaceId, ref.secretRef, ref.versionId])] =
                "synthetic-short-value-".padEnd(96, "x");
        assert(Buffer.byteLength(JSON.stringify(values)) < 1024 * 1024);
        await updatePrivate(directory, "local-secrets.json", () => values);
        const profile = new CredentialProfile(directory, { backend });
        await profile.migrate();
        const records = (await readdir(join(directory, "vault"))).filter((name) =>
            name.startsWith("record-"),
        );
        assert.equal(records.length, refs.length);
        let encryptedBytes = 0;
        for (const name of records) {
            const bytes = await readFile(join(directory, "vault", name));
            encryptedBytes += bytes.length;
            assert.equal(bytes.includes(Buffer.from("synthetic-short-value-")), false);
        }
        assert(encryptedBytes > 2 * 1024 * 1024);
        await profile.transaction(async (transaction) => {
            for (const ref of refs)
                assert.equal(
                    await transaction.resolve(ref),
                    "synthetic-short-value-".padEnd(96, "x"),
                );
        });
        await assert.rejects(readFile(join(directory, "local-secrets.json")), { code: "ENOENT" });
        assert.equal(backend.writes, 1);
    }));

/** 故障注入只包裹真实持久文件写入后的返回边界，密文、清单、日志及恢复仍执行正式实现；准备态未知失败保持旧值，发布后未知失败恢复新值，两者都不得再次运行调用方回调或生成替代系统密钥。 */
test("interrupted staged and unconfirmed published transactions recover exact values without replay", async () =>
    fixture(async (directory, backend) => {
        const { mock } = await import("node:test");
        const { VaultFiles } = await import("../src/credentials/files.ts");
        const { CredentialProfile } = await import("../src/credentials/profile.ts");
        const profile = new CredentialProfile(directory, { backend });
        for (const member of ["profile-next.json", "profile.json"]) {
            await profile.transaction((tx) => tx.set(reference, "previous"));
            const original = VaultFiles.prototype.write;
            let interrupted = false;
            const fault = mock.method(
                VaultFiles.prototype,
                "write",
                async function (
                    this: Awaited<ReturnType<typeof VaultFiles.acquire>>,
                    name: string,
                    value: string,
                ) {
                    await original.call(this, name, value);
                    if (!interrupted && name === member) {
                        interrupted = true;
                        throw new Error("VAULT_COMMIT_UNCONFIRMED");
                    }
                },
            );
            let calls = 0;
            try {
                await assert.rejects(
                    profile.transaction(async (tx) => {
                        calls++;
                        await tx.set(reference, "replacement");
                    }),
                    /VAULT_COMMIT_UNCONFIRMED/,
                );
            } finally {
                fault.mock.restore();
            }
            assert.equal(interrupted, true);
            assert.equal(calls, 1);
            assert.equal(
                await profile.transaction((tx) => tx.resolve(reference)),
                member === "profile.json" ? "replacement" : "previous",
            );
            assert.equal(calls, 1);
            for (const name of ["transaction.json", "profile-next.json"])
                await assert.rejects(readFile(join(directory, "vault", name)), { code: "ENOENT" });
            assert.equal(
                (await readdir(join(directory, "vault"))).filter((name) =>
                    name.startsWith("record-"),
                ).length,
                1,
            );
        }
        assert.equal(backend.writes, 1);
    }));

/** 显式迁移在所有密文已经核验后遇到第二个明文成员退休错误，必须保留 verified 日志和仍未删除的原字节；正常消费者继续要求迁移，随后恢复只退休剩余固定成员，不重新写入主密钥或丢失已发布业务与设备数据。 */
test("partial plaintext retirement remains explicit and resumes verified migration", async () =>
    fixture(async (directory, backend) => {
        const { mock } = await import("node:test");
        const { VaultFiles } = await import("../src/credentials/files.ts");
        const { CredentialProfile } = await import("../src/credentials/profile.ts");
        const { updatePrivate } = await import("../src/offline/config.ts");
        const slot = JSON.stringify([
            reference.issuerId,
            reference.workspaceId,
            reference.secretRef,
            reference.versionId,
        ]);
        await updatePrivate(directory, "local-secrets.json", () => ({
            [slot]: "legacy-recovery-value",
        }));
        await updatePrivate(directory, "device.json", () => device);
        const before = await readFile(join(directory, "device.json"));
        const original = VaultFiles.prototype.remove;
        const fault = mock.method(
            VaultFiles.prototype,
            "remove",
            async function (this: Awaited<ReturnType<typeof VaultFiles.acquire>>, name: string) {
                if (name === "device.json") throw new Error("SYNTHETIC_RETIREMENT_FAILURE");
                return original.call(this, name);
            },
        );
        try {
            await assert.rejects(
                new CredentialProfile(directory, { backend }).migrate(),
                /SYNTHETIC_RETIREMENT_FAILURE/,
            );
        } finally {
            fault.mock.restore();
        }
        assert.equal(
            JSON.parse(await readFile(join(directory, "vault/migration.json"), "utf8")).phase,
            "verified",
        );
        await assert.rejects(readFile(join(directory, "local-secrets.json")), { code: "ENOENT" });
        assert.deepEqual(await readFile(join(directory, "device.json")), before);
        await assert.rejects(
            new DeviceStore(directory, { backend }).load(),
            /VAULT_MIGRATION_REQUIRED/,
        );
        await new CredentialProfile(directory, { backend }).migrate();
        assert.deepEqual(await new DeviceStore(directory, { backend }).load(), device);
        assert.equal(
            await new SecretStore(directory, { backend }).resolve(reference),
            "legacy-recovery-value",
        );
        await assert.rejects(readFile(join(directory, "device.json")), { code: "ENOENT" });
        await assert.rejects(readFile(join(directory, "vault/migration.json")), { code: "ENOENT" });
        assert.equal(backend.writes, 1);
    }));

/** 初始化中断且系统确实没有原版本密钥时，只有显式恢复才可建立新版本，并保持同一档案身份；原意图与精确退休事实必须留在非秘密日志，普通消费者重复访问不能自动生成新密钥或覆盖已发布凭据。 */
test("explicit empty initialization recovery changes only missing key version and preserves intent", async () =>
    fixture(async (directory, backend) => {
        const { CredentialProfile } = await import("../src/credentials/profile.ts");
        const profile = new CredentialProfile(directory, { backend });
        backend.uncertain = true;
        await assert.rejects(
            new SecretStore(directory, { backend }).set(reference, "not-published"),
            /VAULT_MUTATION_UNCONFIRMED/,
        );
        backend.keys.clear();
        backend.uncertain = false;
        const before = JSON.parse(await readFile(join(directory, "vault/profile.json"), "utf8"));
        await assert.rejects(
            new SecretStore(directory, { backend }).resolve(reference),
            /VAULT_KEY_MISSING/,
        );
        assert.equal(backend.writes, 1);
        await profile.recoverInitialization();
        const after = JSON.parse(await readFile(join(directory, "vault/profile.json"), "utf8"));
        assert.equal(after.profileId, before.profileId);
        assert.notEqual(after.keyVersion, before.keyVersion);
        assert.equal(after.state, "active");
        assert.deepEqual(after.entries, {});
        const recovery = JSON.parse(
            await readFile(join(directory, "vault/initialization.json"), "utf8"),
        );
        assert.deepEqual(recovery.previous, [
            { keyVersion: before.keyVersion, keyHash: before.keyHash, status: "absent" },
        ]);
        assert.equal(recovery.state, "active");
        assert.equal(backend.writes, 2);
        await new SecretStore(directory, { backend }).set(reference, "after-explicit-recovery");
        assert.equal(
            await new SecretStore(directory, { backend }).resolve(reference),
            "after-explicit-recovery",
        );
        assert.equal(backend.writes, 2);
    }));

/** 活动档案缺钥、系统锁定和残留密文不是空初始化，显式恢复也必须拒绝而保留现有索引与秘密文件；该测试直接操作自有测试后端或文件制造这些状态，拒绝路径不得创建替代密钥或退休旧版本。 */
test("initialization recovery refuses active missing keys locked vaults and residual ciphertext", async () =>
    fixture(async (directory, backend) => {
        const { CredentialProfile } = await import("../src/credentials/profile.ts");
        const profile = new CredentialProfile(directory, { backend });
        const store = new SecretStore(directory, { backend });
        backend.uncertain = true;
        await assert.rejects(store.set(reference, "unpublished"), /VAULT_MUTATION_UNCONFIRMED/);
        backend.uncertain = false;
        const before = await readFile(join(directory, "vault/profile.json"));
        backend.state = "locked";
        await assert.rejects(profile.recoverInitialization(), /VAULT_LOCKED/);
        assert.deepEqual(await readFile(join(directory, "vault/profile.json")), before);
        backend.state = "ok";
        const { VaultFiles } = await import("../src/credentials/files.ts");
        const files = await VaultFiles.acquire(join(directory, "vault"));
        const stray = "record-11111111-1111-4111-8111-111111111111.json";
        try {
            await files.write(stray, "synthetic residual");
            await assert.rejects(
                profile.recoverInitialization(),
                /VAULT_INITIALIZATION_DATA_PRESENT/,
            );
            assert.equal(await files.read(stray), "synthetic residual");
            await files.remove(stray);
        } finally {
            await files.close();
        }
        await store.set(reference, "active-secret");
        backend.keys.clear();
        await assert.rejects(profile.recoverInitialization(), /VAULT_INITIALIZATION_NOT_PENDING/);
        assert.equal(backend.writes, 1);
    }));

/** 新版本系统写入后旧版本才迟到时，恢复只清理同一显式日志中校验值匹配的旧钥；删除返回不确定会保留 pending 并阻断正常消费者，再次显式恢复只确认原版本缺失，不重放新钥写入或更换已验证的新版本。 */
test("initialization retirement uncertainty preserves exact late key cleanup without rewriting replacement", async () =>
    fixture(async (directory, backend) => {
        const { CredentialProfile } = await import("../src/credentials/profile.ts");
        backend.uncertain = true;
        await assert.rejects(
            new SecretStore(directory, { backend }).set(reference, "unpublished"),
            /VAULT_MUTATION_UNCONFIRMED/,
        );
        const [oldScope, oldKey] = [...backend.keys.entries()][0]!;
        backend.keys.clear();
        backend.uncertain = false;
        let uncertainDelete = true;
        const delegated: VaultKeyBackend = {
            get: (scope) => backend.get(scope),
            probe: () => backend.probe(),
            async set(scope, key) {
                const result = await backend.set(scope, key);
                backend.keys.set(oldScope, Buffer.from(oldKey));
                return result;
            },
            async delete(scope) {
                const result = await backend.delete(scope);
                if (uncertainDelete) {
                    uncertainDelete = false;
                    return { status: "mutation-unconfirmed" };
                }
                return result;
            },
        };
        try {
            const profile = new CredentialProfile(directory, { backend: delegated });
            await assert.rejects(profile.recoverInitialization(), /VAULT_MUTATION_UNCONFIRMED/);
            const pending = JSON.parse(
                await readFile(join(directory, "vault/initialization.json"), "utf8"),
            );
            assert.equal(pending.state, "pending");
            assert.equal(pending.previous[0].status, "pending");
            assert.equal(backend.keys.has(oldScope), false);
            await assert.rejects(
                new SecretStore(directory, { backend: delegated }).resolve(reference),
                /VAULT_INITIALIZATION_RECOVERY_REQUIRED/,
            );
            await profile.recoverInitialization();
            const completed = JSON.parse(
                await readFile(join(directory, "vault/initialization.json"), "utf8"),
            );
            assert.deepEqual(completed.next, pending.next);
            assert.equal(completed.previous[0].status, "absent");
            assert.equal(completed.state, "active");
            assert.equal(backend.writes, 2);
        } finally {
            oldKey.fill(0);
        }
    }));

/** 恢复意图已经落盘而下一清单发布未执行时，重启必须保留两个确切旧意图并另建未激活版本，不能复用已丢失随机密钥的摘要；测试在真实日志写回后注入中断，最后核验每个退休范围与唯一可用系统密钥。 */
test("initialization recovery resumes a durable intent interrupted before manifest publication", async () =>
    fixture(async (directory, backend) => {
        const { CredentialProfile } = await import("../src/credentials/profile.ts");
        const { VaultFiles } = await import("../src/credentials/files.ts");
        const { mock } = await import("node:test");
        backend.uncertain = true;
        await assert.rejects(
            new SecretStore(directory, { backend }).set(reference, "unpublished"),
            /VAULT_MUTATION_UNCONFIRMED/,
        );
        backend.keys.clear();
        backend.uncertain = false;
        const original = VaultFiles.prototype.write;
        let injected = false;
        const fault = mock.method(
            VaultFiles.prototype,
            "write",
            async function (
                this: Awaited<ReturnType<typeof VaultFiles.acquire>>,
                name: string,
                value: string,
            ) {
                await original.call(this, name, value);
                if (name === "initialization.json" && !injected) {
                    injected = true;
                    throw new Error("VAULT_COMMIT_UNCONFIRMED");
                }
            },
        );
        try {
            await assert.rejects(
                new CredentialProfile(directory, { backend }).recoverInitialization(),
                /VAULT_COMMIT_UNCONFIRMED/,
            );
        } finally {
            fault.mock.restore();
        }
        const intent = JSON.parse(
            await readFile(join(directory, "vault/initialization.json"), "utf8"),
        );
        assert.equal(backend.writes, 1);
        await new CredentialProfile(directory, { backend }).recoverInitialization();
        const completed = JSON.parse(
            await readFile(join(directory, "vault/initialization.json"), "utf8"),
        );
        assert.equal(completed.previous.length, 2);
        assert.deepEqual(completed.previous[1], { ...intent.next, status: "absent" });
        assert.equal(completed.state, "active");
        assert.equal(backend.keys.size, 1);
        assert.equal(backend.writes, 2);
    }));
