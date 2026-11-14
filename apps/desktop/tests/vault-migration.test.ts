/** 桌面迁移测试通过实际有限派发器和真实私有文件验证用户入口，内存后端只替代宿主缺失的系统服务；结果仅包含完成与模式摘要，秘密必须继续由生产密文消费者读取，不能回传给渲染界面。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDesktopProfileOwner } from "../../runtime/src/credentials/ownership.ts";
import { DesktopAgent } from "../src/agent/service.ts";
import { SecretStore } from "../../runtime/src/credentials/store.ts";
import type { VaultKeyBackend } from "../../runtime/src/credentials/backend.ts";
import { assertAgentReconfigurationAllowed } from "../src/shared/credential-status.ts";

/** 控制源切换保护从主进程提取后仍须保留原有三个拒绝条件及固定错误，空后台才允许后续设置操作；测试直接调用被主进程消费的同一策略，不导入带窗口和进程启动副作用的 Electron 入口。 */
test("Agent reconfiguration preserves existing active online and enrolled guards", () => {
    assert.doesNotThrow(() => assertAgentReconfigurationAllowed({ active: null, online: false }));
    for (const state of [
        { active: { state: "UNKNOWN" } },
        { online: true },
        { device: { id: "bound" } },
    ])
        assert.throws(() => assertAgentReconfigurationAllowed(state), {
            message: "UNBIND_DEVICE_BEFORE_ORIGIN_CHANGE",
        });
});

/** 未传入保险库上下文的源码档案仍使用 device.json 的真实缺文件结果表示尚未绑定，收紧系统异常分类不能阻止首次登记；后续缺失引擎库存的明确路径证明请求已越过凭据前检，而不是把设备缺席异常直接抛回。 */
test("DesktopAgent preserves a genuinely unenrolled source profile", async () => {
    const directory = await mkdtemp(join(tmpdir(), "veriq-desktop-unenrolled-"));
    try {
        const agent = new DesktopAgent(directory, {
            origin: "https://control.example",
            engineDirectory: join(directory, "engine"),
            browserExecutable: join(directory, "absent-browser"),
        });
        const status = (await agent.dispatch({ operation: "status" })) as {
            credentialError?: string;
            device?: unknown;
        };
        assert.equal(status.credentialError, undefined);
        assert.equal(status.device, undefined);
        assert.doesNotThrow(() => assertAgentReconfigurationAllowed(status));
        await assert.rejects(agent.dispatch({ operation: "enroll", name: "first-device" }), {
            code: "ENOENT",
            path: join(directory, "engine/inventory.json"),
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("DesktopAgent exposes explicit migration through its guarded finite dispatch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "veriq-desktop-vault-"));
    const keys = new Map<string, Buffer>();
    const backend: VaultKeyBackend = {
        async get(scope) {
            const key = keys.get(JSON.stringify(scope));
            return key ? { status: "ok", key: Buffer.from(key) } : { status: "missing" };
        },
        async set(scope, key) {
            keys.set(JSON.stringify(scope), Buffer.from(key));
            return { status: "ok" };
        },
        async delete(scope) {
            return { status: keys.delete(JSON.stringify(scope)) ? "ok" : "missing" };
        },
        async probe() {
            return { status: "ready" };
        },
    };
    const ref = {
        issuerId: "owned",
        workspaceId: "11111111-1111-4111-8111-111111111111",
        secretRef: "login",
        versionId: "22222222-2222-4222-8222-222222222222",
    };
    const ownership = await acquireDesktopProfileOwner(directory);
    try {
        await new SecretStore(directory).set(ref, "desktop-legacy-value");
        const agent = new DesktopAgent(
            directory,
            {
                origin: "https://control.example",
                engineDirectory: join(directory, "engine"),
                browserExecutable: join(directory, "absent-browser"),
            },
            { backend, desktopOwner: ownership.owner },
        );
        const before = await readFile(join(directory, "local-secrets.json"));
        const status = (await agent.dispatch({ operation: "status" })) as {
            credentialError?: string;
            device?: unknown;
        };
        assert.equal(status.credentialError, "VAULT_MIGRATION_REQUIRED");
        assert.throws(() => assertAgentReconfigurationAllowed(status), {
            message: "UNBIND_DEVICE_BEFORE_ORIGIN_CHANGE",
        });
        assert.equal(status.device, undefined);
        assert.deepEqual(await readFile(join(directory, "local-secrets.json")), before);
        assert.equal(keys.size, 0);
        await assert.rejects(agent.dispatch({ operation: "enroll", name: "replacement" }), {
            message: "VAULT_MIGRATION_REQUIRED",
        });
        assert.deepEqual(await agent.dispatch({ operation: "migrateCredentials" }), {
            migrated: true,
            credentialMode: "os-vault",
        });
        assert.equal(
            await new SecretStore(directory, { backend }).resolve(ref),
            "desktop-legacy-value",
        );
    } finally {
        await ownership.release();
        await rm(directory, { recursive: true, force: true });
    }
});

/** GUI 的初始化恢复必须经过同一个有限命令门闩，测试后端首写确实丢失且未产生业务密文；派发完成仅返回非秘密模式摘要，再用真实消费者验证新版本可用，不能靠按钮回显声称缺失主密钥已恢复。 */
test("DesktopAgent exposes explicit empty key initialization recovery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "veriq-desktop-initialization-"));
    const keys = new Map<string, Buffer>();
    let failFirst = true;
    const backend: VaultKeyBackend = {
        async get(scope) {
            const key = keys.get(JSON.stringify(scope));
            return key ? { status: "ok", key: Buffer.from(key) } : { status: "missing" };
        },
        async set(scope, key) {
            if (failFirst) {
                failFirst = false;
                return { status: "mutation-unconfirmed" };
            }
            keys.set(JSON.stringify(scope), Buffer.from(key));
            return { status: "ok" };
        },
        async delete(scope) {
            return { status: keys.delete(JSON.stringify(scope)) ? "ok" : "missing" };
        },
        async probe() {
            return { status: "ready" };
        },
    };
    const ownership = await acquireDesktopProfileOwner(directory);
    try {
        const { DeviceStore } = await import("../../runtime/src/enrollment.ts");
        const device = new DeviceStore(directory, { backend });
        await assert.rejects(device.load(), /VAULT_MUTATION_UNCONFIRMED/);
        const agent = new DesktopAgent(
            directory,
            {
                origin: "https://control.example",
                engineDirectory: join(directory, "engine"),
                browserExecutable: join(directory, "absent-browser"),
            },
            { backend, desktopOwner: ownership.owner },
        );
        const status = (await agent.dispatch({ operation: "status" })) as {
            credentialError?: string;
            device?: unknown;
        };
        assert.equal(status.credentialError, "VAULT_KEY_MISSING");
        assert.equal(status.device, undefined);
        assert.equal(keys.size, 0);
        assert.deepEqual(await agent.dispatch({ operation: "recoverCredentialInitialization" }), {
            recovered: true,
            credentialMode: "os-vault",
        });
        await assert.rejects(device.load(), { code: "ENOENT" });
        const recovered = (await agent.dispatch({ operation: "status" })) as {
            credentialError?: string;
            device?: unknown;
            history: unknown[];
        };
        assert.equal(recovered.credentialError, undefined);
        assert.equal(recovered.device, undefined);
        assert.deepEqual(recovered.history, []);
        assert.doesNotThrow(() => assertAgentReconfigurationAllowed(recovered));
        await assert.rejects(agent.dispatch({ operation: "enroll", name: "first-device" }), {
            code: "ENOENT",
            path: join(directory, "engine/inventory.json"),
        });
        await assert.rejects(
            agent.dispatch({ operation: "recoverCredentialInitialization", force: true }),
            /AGENT_OPERATION_DENIED|INVALID/,
        );
    } finally {
        await ownership.release();
        await rm(directory, { recursive: true, force: true });
    }
});

/** 状态可达不意味着凭据可消费，真实密文档案在后端锁定、不可用或未知异常时必须保持原密钥与文件；测试逐次轮询验证有限错误投影及秘密不外泄，再恢复同一后端读取原设备，不能用新建空档案把失败伪装为未绑定。 */
test("DesktopAgent keeps credential failures visible without exposing secrets or replacing keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "veriq-desktop-locked-"));
    const keys = new Map<string, Buffer>();
    let blocked:
        | "locked"
        | "unavailable"
        | "failed"
        | "unexpected"
        | "enoent"
        | "null"
        | "undefined"
        | undefined;
    let sets = 0;
    const backend: VaultKeyBackend = {
        async get(scope) {
            if (blocked === "enoent")
                throw Object.assign(new Error("backend service entry missing"), { code: "ENOENT" });
            if (blocked === "null") throw null;
            if (blocked === "undefined") throw undefined;
            if (blocked === "unexpected")
                throw new Error("private-path-and-secret-must-not-be-rendered");
            if (blocked) return { status: blocked };
            const key = keys.get(JSON.stringify(scope));
            return key ? { status: "ok", key: Buffer.from(key) } : { status: "missing" };
        },
        async set(scope, key) {
            sets++;
            keys.set(JSON.stringify(scope), Buffer.from(key));
            return { status: "ok" };
        },
        async delete(scope) {
            return { status: keys.delete(JSON.stringify(scope)) ? "ok" : "missing" };
        },
        async probe() {
            return { status: "ready" };
        },
    };
    const ownership = await acquireDesktopProfileOwner(directory);
    try {
        const { DeviceStore } = await import("../../runtime/src/enrollment.ts");
        const store = new DeviceStore(directory, { backend });
        const config = {
            server: "https://control.example",
            runnerId: "33333333-3333-4333-8333-333333333333",
            workspaceId: "11111111-1111-4111-8111-111111111111",
            deviceToken: "synthetic-secret-not-for-status",
            expiresAt: "2027-01-01T00:00:00Z",
        };
        await store.save(config);
        const before = await readFile(join(directory, "vault/profile.json"));
        const agent = new DesktopAgent(
            directory,
            {
                origin: config.server,
                engineDirectory: join(directory, "engine"),
                browserExecutable: join(directory, "absent-browser"),
            },
            { backend, desktopOwner: ownership.owner },
        );
        for (const [mode, code] of [
            ["locked", "VAULT_LOCKED"],
            ["unavailable", "VAULT_UNAVAILABLE"],
            ["failed", "VAULT_FAILED"],
            ["unexpected", "CREDENTIAL_ACCESS_FAILED"],
            ["enoent", "CREDENTIAL_ACCESS_FAILED"],
            ["null", "CREDENTIAL_ACCESS_FAILED"],
            ["undefined", "CREDENTIAL_ACCESS_FAILED"],
        ] as const) {
            blocked = mode;
            const status = (await agent.dispatch({ operation: "status" })) as {
                credentialError?: string;
                device?: unknown;
            };
            /** 后端服务自身的条目缺失不能证明设备登记不存在，必须同时核对公开状态、控制源保护和登记前检的真实结果；引擎故意缺失以识别越过凭据前检的路径，不能把后续诊断失败当作安全拒绝。 */
            if (mode === "enoent") {
                let reconfigurationAllowed = true;
                try {
                    assertAgentReconfigurationAllowed(status);
                } catch {
                    reconfigurationAllowed = false;
                }
                const enrollmentError = await agent
                    .dispatch({ operation: "enroll", name: "replacement" })
                    .then(
                        () => undefined,
                        (error: unknown) => error,
                    );
                assert.deepEqual(
                    {
                        credentialError: status.credentialError,
                        reconfigurationAllowed,
                        enrollmentError:
                            enrollmentError instanceof Error
                                ? enrollmentError.message
                                : enrollmentError,
                    },
                    {
                        credentialError: "CREDENTIAL_ACCESS_FAILED",
                        reconfigurationAllowed: false,
                        enrollmentError: "CREDENTIAL_ACCESS_FAILED",
                    },
                );
                assert(!JSON.stringify(status).includes("backend service entry missing"));
            }
            assert.equal(status.credentialError, code);
            assert.throws(() => assertAgentReconfigurationAllowed(status), {
                message: "UNBIND_DEVICE_BEFORE_ORIGIN_CHANGE",
            });
            assert.equal(status.device, undefined);
            assert(!JSON.stringify(status).includes(config.deviceToken));
            assert(!JSON.stringify(status).includes("private-path-and-secret"));
            await assert.rejects(store.load());
            await assert.rejects(agent.dispatch({ operation: "device" }));
            if (["locked", "unavailable", "failed"].includes(mode))
                await assert.rejects(agent.dispatch({ operation: "enroll", name: "replacement" }), {
                    message: code,
                });
            assert.deepEqual(await readFile(join(directory, "vault/profile.json")), before);
            assert.equal(sets, 1);
            assert.equal(keys.size, 1);
        }
        blocked = undefined;
        assert.deepEqual(await store.load(), config);
        const status = (await agent.dispatch({ operation: "status" })) as {
            credentialError?: string;
            device?: unknown;
        };
        assert.equal(status.credentialError, undefined);
        assert.deepEqual(status.device, { id: config.runnerId, workspaceId: config.workspaceId });
        await assert.rejects(agent.dispatch({ operation: "enroll", name: "replacement" }), {
            message: "ALREADY_ENROLLED",
        });
        /** 活跃档案丢失外部密钥之后仍保留登记密文和原代际，显式空初始化恢复必须拒绝并保持零次新写钥；重新提供原密钥才可读回同一身份，不能把恢复按钮作为业务凭据重建入口。 */
        const originalKeys = new Map(keys);
        keys.clear();
        assert.equal(
            ((await agent.dispatch({ operation: "status" })) as { credentialError: string })
                .credentialError,
            "VAULT_KEY_MISSING",
        );
        await assert.rejects(agent.dispatch({ operation: "device" }), /VAULT_KEY_MISSING/);
        await assert.rejects(
            agent.dispatch({ operation: "enroll", name: "replacement" }),
            /VAULT_KEY_MISSING/,
        );
        await assert.rejects(
            agent.dispatch({ operation: "recoverCredentialInitialization" }),
            /VAULT_INITIALIZATION_NOT_PENDING/,
        );
        assert.equal(sets, 1);
        assert.equal(keys.size, 0);
        assert.deepEqual(await readFile(join(directory, "vault/profile.json")), before);
        for (const [scope, key] of originalKeys) keys.set(scope, key);
        assert.deepEqual(await store.load(), config);

        /** 凭据故障投影的捕获范围不得扩展到资源目录或执行数据库，真实损坏必须继续拒绝整个状态读取；这些场景只改当前测试的私有临时档案，验证完成由外层清理而不触碰任何宿主证据。 */
        await writeFile(join(directory, "desktop-bundles.json"), "{", { mode: 0o600 });
        await assert.rejects(agent.dispatch({ operation: "status" }), SyntaxError);
        await rm(join(directory, "desktop-bundles.json"));
        const database = new DatabaseSync(join(directory, "offline/veriq.sqlite"));
        try {
            database.exec(
                "ALTER TABLE veriq_local_runs RENAME COLUMN created_at TO damaged_created_at",
            );
        } finally {
            database.close();
        }
        await assert.rejects(agent.dispatch({ operation: "status" }), /no such column/);
        const unsupported = new DatabaseSync(join(directory, "offline/veriq.sqlite"));
        try {
            unsupported.exec("PRAGMA user_version=3");
        } finally {
            unsupported.close();
        }
        await assert.rejects(
            agent.dispatch({ operation: "status" }),
            /LOCAL_STORE_VERSION_UNSUPPORTED/,
        );
    } finally {
        await ownership.release();
        await rm(directory, { recursive: true, force: true });
    }
});
