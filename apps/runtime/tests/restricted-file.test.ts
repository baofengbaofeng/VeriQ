/** 文件凭据模式的普通宿主测试只验证显式配置与实际环境拒绝边界，不把合成挂载文本或内存后端称为持久卷验收；真实专用用户、文件模式与跨进程读回应由有限 Linux 目标夹具执行，桌面默认不能自动降级到该模式。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

async function factory() {
    return (await import("../src/credentials/restricted-file.ts")).managedFileCredentials;
}

test("restricted-file requires explicit managed context and unencrypted storage acknowledgement", async () => {
    const root = await mkdtemp(join(tmpdir(), "veriq-restricted-reject-"));
    try {
        const create = await factory();
        await assert.rejects(
            create({
                mode: "restricted-file",
                managedHeadless: true,
                serviceUid: process.getuid?.() ?? 1000,
                persistentVolume: root,
                profileDirectory: join(root, "profile"),
                acknowledgeUnencryptedStorage: false,
            }),
            /RESTRICTED_FILE_CONTEXT_REQUIRED|VAULT_PLATFORM_UNSUPPORTED/,
        );
        assert.deepEqual(await readdir(root), []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("restricted-file rejects an ordinary unmounted directory and never creates a fallback profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "veriq-restricted-mount-"));
    try {
        const create = await factory();
        await assert.rejects(
            create({
                mode: "restricted-file",
                managedHeadless: true,
                serviceUid: process.getuid?.() ?? 1000,
                persistentVolume: root,
                profileDirectory: join(root, "profile"),
                acknowledgeUnencryptedStorage: true,
            }),
            /RESTRICTED_FILE_(?:PERSISTENT_VOLUME_REQUIRED|CONTEXT_REQUIRED)|VAULT_PLATFORM_UNSUPPORTED/,
        );
        assert.deepEqual(await readdir(root), []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("restricted-file rejects UID mismatch before opening the selected volume", async () => {
    const create = await factory();
    await assert.rejects(
        create({
            mode: "restricted-file",
            managedHeadless: true,
            serviceUid: (process.getuid?.() ?? 1000) + 1,
            persistentVolume: "/unopened-owned-volume",
            profileDirectory: "/unopened-owned-volume/profile",
            acknowledgeUnencryptedStorage: true,
        }),
        /RESTRICTED_FILE_CONTEXT_REQUIRED|VAULT_PLATFORM_UNSUPPORTED/,
    );
});

/** 模式参数必须由真实 CLI 入口验证，非法服务 UID 在任何凭据操作之前拒绝且不创建档案；该子进程测试仅检查选择边界，不能把缺少持久挂载的宿主当作文件后端成功运行或系统保险库替代证据。 */
test("CLI restricted-file selection rejects root service UID before any credential operation", async () => {
    const root = await mkdtemp(join(tmpdir(), "veriq-restricted-cli-"));
    try {
        await assert.rejects(
            promisify(execFile)(
                process.execPath,
                [
                    "--import",
                    "tsx",
                    fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
                    "--config-dir",
                    join(root, "profile"),
                    "--credential-mode",
                    "restricted-file",
                    "--managed-service-uid",
                    "0",
                    "--persistent-volume",
                    root,
                    "--acknowledge-unencrypted-storage",
                    "secret",
                    "delete-profile",
                    "--confirm-all",
                ],
                { timeout: 15000, maxBuffer: 8192 },
            ),
            (error: unknown) => {
                assert.match(
                    (error as { stderr: string }).stderr,
                    /RESTRICTED_FILE_CONTEXT_REQUIRED|VAULT_PLATFORM_UNSUPPORTED/,
                );
                return true;
            },
        );
        assert.deepEqual(await readdir(root), []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

/** 显式选择 OS vault 的源码 CLI 不能因为没有发行能力而沿用旧无上下文明文分支，测试只调用自有空档案的 local-only 注销观察入口选择；拒绝必须发生在创建或清空文件之前，普通开发默认路径的整体迁移仍单独验证。 */
test("explicit OS-vault selection refuses missing source capability instead of using legacy files", async () => {
    const root = await mkdtemp(join(tmpdir(), "veriq-explicit-os-vault-"));
    try {
        await assert.rejects(
            promisify(execFile)(
                process.execPath,
                [
                    "--import",
                    "tsx",
                    fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
                    "--config-dir",
                    join(root, "profile"),
                    "--credential-mode",
                    "os-vault",
                    "logout",
                    "--local-only",
                ],
                { timeout: 15000, maxBuffer: 8192 },
            ),
            (error: unknown) => {
                assert.match(
                    (error as { stderr: string }).stderr,
                    /RUNTIME_VAULT_CAPABILITY_UNVERIFIED/,
                );
                return true;
            },
        );
        assert.deepEqual(await readdir(root), []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
