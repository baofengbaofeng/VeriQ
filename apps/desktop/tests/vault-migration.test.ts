/** 桌面迁移测试通过实际有限派发器和真实私有文件验证用户入口，内存后端只替代宿主缺失的系统服务；结果仅包含完成与模式摘要，秘密必须继续由生产密文消费者读取，不能回传给渲染界面。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDesktopProfileOwner } from "../../runtime/src/credentials/ownership.ts";
import { DesktopAgent } from "../src/agent/service.ts";
import { SecretStore } from "../../runtime/src/credentials/store.ts";
import type { VaultKeyBackend } from "../../runtime/src/credentials/backend.ts";

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
        assert.deepEqual(await agent.dispatch({ operation: "recoverCredentialInitialization" }), {
            recovered: true,
            credentialMode: "os-vault",
        });
        await assert.rejects(device.load(), { code: "ENOENT" });
        await assert.rejects(
            agent.dispatch({ operation: "recoverCredentialInitialization", force: true }),
            /AGENT_OPERATION_DENIED|INVALID/,
        );
    } finally {
        await ownership.release();
        await rm(directory, { recursive: true, force: true });
    }
});
