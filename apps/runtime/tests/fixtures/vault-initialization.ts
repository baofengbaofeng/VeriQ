/** 真实 OS 后端的空初始化恢复验收只为本测试新建的随机档案写入非秘密未激活意图，首先确认该确切版本实际缺失；之后经正式恢复与消费者写入读回，并在 finally 精确删除本测试旧新版本，绝不枚举或触碰用户其他系统凭据。 */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CredentialProfile, type CredentialOptions } from "../../src/credentials/profile.ts";
import { VaultFiles } from "../../src/credentials/files.ts";
import { SecretStore } from "../../src/credentials/store.ts";

/** 调用者必须提供目标测试已经核验的正式 helper 后端，夹具只准备确实没有业务数据的初始化边界而不替代系统调用；返回值限于非秘密验证事实，任何恢复、读取或清理失败都会使原目标用例失败，不能把 fixture 构造当作 OS 验收结果。 */
export async function verifyEmptyInitialization(directory: string, options: CredentialOptions) {
    const material = randomBytes(32);
    const pending = {
        version: 1,
        profileId: randomUUID(),
        keyVersion: randomUUID(),
        keyHash: createHash("sha256").update(material).digest("hex"),
        state: "initializing",
        entries: {},
    };
    material.fill(0);
    const files = await VaultFiles.acquire(join(directory, "vault"));
    try {
        await files.write("profile.json", JSON.stringify(pending));
    } finally {
        await files.close();
    }
    const original = { profileId: pending.profileId, keyVersion: pending.keyVersion };
    const ref = {
        issuerId: "owned",
        workspaceId: randomUUID(),
        secretRef: "recovered",
        versionId: randomUUID(),
    };
    try {
        assert.equal(
            (await options.backend.get(original, AbortSignal.timeout(5000))).status,
            "missing",
        );
        await assert.rejects(new SecretStore(directory, options).resolve(ref), /VAULT_KEY_MISSING/);
        await new CredentialProfile(directory, options).recoverInitialization();
        const active = JSON.parse(await readFile(join(directory, "vault/profile.json"), "utf8"));
        assert.equal(active.profileId, pending.profileId);
        assert.notEqual(active.keyVersion, pending.keyVersion);
        assert.equal(active.state, "active");
        await new SecretStore(directory, options).set(ref, "synthetic-recovered-secret");
        assert.equal(
            await new SecretStore(directory, options).resolve(ref),
            "synthetic-recovered-secret",
        );
        const history = JSON.parse(
            await readFile(join(directory, "vault/initialization.json"), "utf8"),
        );
        assert.equal(history.previous[0].keyVersion, original.keyVersion);
        assert.equal(history.previous[0].status, "absent");
        return {
            originalActuallyMissing: true,
            stableProfile: true,
            newExactVersion: true,
            consumerReadback: true,
            priorIntentRetained: true,
        };
    } finally {
        const current = JSON.parse(await readFile(join(directory, "vault/profile.json"), "utf8"));
        for (const scope of [
            original,
            { profileId: current.profileId, keyVersion: current.keyVersion },
        ]) {
            assert(
                ["ok", "missing"].includes(
                    (await options.backend.delete(scope, AbortSignal.timeout(5000))).status,
                ),
                "VAULT_RECOVERY_KEY_CLEANUP_FAILED",
            );
            assert.equal(
                (await options.backend.get(scope, AbortSignal.timeout(5000))).status,
                "missing",
            );
        }
    }
}
