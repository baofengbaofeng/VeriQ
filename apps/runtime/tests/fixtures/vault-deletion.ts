/** 真实系统凭据退休验收为本测试创建随机独立档案，通过正式消费者写入三种秘密用途后调用生产整体删除；所有 OS 观察均针对该档案的精确版本，finally 再读实际缺失事实，不能把内存夹具或 helper 退出当作系统服务删除完成。 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { CredentialProfile, type CredentialOptions } from "../../src/credentials/profile.ts";
import type { VaultKeyScope } from "../../src/credentials/backend.ts";
import { updatePrivate } from "../../src/offline/config.ts";

/** 调用者提供目标环境真实后端与本次独立目录，返回的有限事实不含密钥和业务载荷；测试保留本机退役与控制平台撤销的边界，真实系统密钥清理无论主断言是否成功都必须执行并核验结果。 */
export async function verifyCredentialDeletion(directory: string, options: CredentialOptions) {
    const profile = new CredentialProfile(directory, options);
    const ref = {
        issuerId: "owned",
        workspaceId: randomUUID(),
        secretRef: "deletion",
        versionId: randomUUID(),
    };
    const device = {
        server: "https://control.example",
        workspaceId: ref.workspaceId,
        runnerId: randomUUID(),
        deviceToken: "synthetic-owned-deletion-device-token",
        expiresAt: "2027-01-01T00:00:00Z",
    };
    let scope: VaultKeyScope | undefined;
    try {
        await profile.transaction(async (tx) => {
            await tx.set(ref, "synthetic-owned-deletion-value");
            await tx.saveDevice(device, true);
            await tx.saveRotation({
                previous: device,
                clientRequestId: randomUUID(),
                replacementToken: "synthetic-owned-replacement-token",
            });
        });
        const manifest = JSON.parse(await readFile(join(directory, "vault/profile.json"), "utf8"));
        scope = { profileId: manifest.profileId, keyVersion: manifest.keyVersion };
        assert.equal(Object.keys(manifest.entries).length, 3);
        const present = await options.backend.get(scope, AbortSignal.timeout(5000));
        assert.equal(present.status, "ok");
        if (present.status === "ok") present.key.fill(0);
        await updatePrivate(directory, "public-marker.json", () => ({ public: "retained" }));
        const marker = await readFile(join(directory, "public-marker.json"));
        await profile.deleteCredentials();
        assert.equal(
            (await options.backend.get(scope, AbortSignal.timeout(5000))).status,
            "missing",
        );
        assert.deepEqual(await readdir(join(directory, "vault")), ["deletion.json"]);
        assert.deepEqual(await readFile(join(directory, "public-marker.json")), marker);
        const journal = JSON.parse(await readFile(join(directory, "vault/deletion.json"), "utf8"));
        assert.equal(journal.profileId, scope.profileId);
        assert.equal(journal.state, "deleted");
        assert.equal(journal.keys[0].keyVersion, scope.keyVersion);
        assert.equal(journal.keys[0].status, "absent");
        await assert.rejects(
            new CredentialProfile(directory, options).transaction((tx) => tx.device()),
            /VAULT_PROFILE_DELETED/,
        );
        await profile.deleteCredentials();
        return {
            threePurposesRetired: true,
            exactKeyActuallyMissing: true,
            publicDataRetained: true,
            tombstoneRetained: true,
            restartCannotReinitialize: true,
        };
    } finally {
        if (!scope) {
            try {
                const manifest = JSON.parse(
                    await readFile(join(directory, "vault/profile.json"), "utf8"),
                );
                scope = { profileId: manifest.profileId, keyVersion: manifest.keyVersion };
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
        }
        if (scope) {
            assert(
                ["ok", "missing"].includes(
                    (await options.backend.delete(scope, AbortSignal.timeout(5000))).status,
                ),
                "VAULT_DELETION_FIXTURE_CLEANUP_FAILED",
            );
            assert.equal(
                (await options.backend.get(scope, AbortSignal.timeout(5000))).status,
                "missing",
            );
        }
    }
}
