/** 整体凭据删除测试用真实私有文件和正式事务创建各用途载荷，只把系统密钥服务替换为显式受控夹具；验证删除意图先持久化、未知结果保留可恢复事实，以及其他公开配置和历史不会被误当秘密一并移除。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { CredentialProfile } from "../src/credentials/profile.ts";
import { VaultFiles } from "../src/credentials/files.ts";
import { privateDirectory, updatePrivate } from "../src/offline/config.ts";
import type { VaultKeyBackend, VaultKeyScope } from "../src/credentials/backend.ts";

class Keys implements VaultKeyBackend {
    values = new Map<string, Buffer>();
    writes = 0;
    deletes = 0;
    uncertain = false;
    locked = false;
    async get(scope: VaultKeyScope) {
        if (this.locked) return { status: "locked" as const };
        const key = this.values.get(JSON.stringify(scope));
        return key
            ? { status: "ok" as const, key: Buffer.from(key) }
            : { status: "missing" as const };
    }
    async set(scope: VaultKeyScope, key: Buffer) {
        this.writes++;
        this.values.set(JSON.stringify(scope), Buffer.from(key));
        return { status: "ok" as const };
    }
    async delete(scope: VaultKeyScope) {
        this.deletes++;
        if (this.uncertain) return { status: "mutation-unconfirmed" as const };
        return {
            status: this.values.delete(JSON.stringify(scope))
                ? ("ok" as const)
                : ("missing" as const),
        };
    }
    async probe() {
        return { status: "ready" as const };
    }
}
const ref = {
    issuerId: "owned",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    secretRef: "login",
    versionId: "22222222-2222-4222-8222-222222222222",
};
const device = {
    server: "https://control.example",
    runnerId: "33333333-3333-4333-8333-333333333333",
    workspaceId: ref.workspaceId,
    deviceToken: "synthetic-private-token-for-owned-deletion",
    expiresAt: "2027-01-01T00:00:00Z",
};
async function fixture(
    run: (directory: string, profile: CredentialProfile, keys: Keys) => Promise<void>,
) {
    const root = await mkdtemp(join(tmpdir(), "veriq-delete-")),
        directory = join(root, "profile");
    const keys = new Keys(),
        profile = new CredentialProfile(directory, { backend: keys });
    try {
        await privateDirectory(directory);
        await profile.transaction(async (tx) => {
            await tx.set(ref, "synthetic-owned-secret");
            await tx.saveDevice(device, true);
            await tx.saveRotation({
                previous: device,
                clientRequestId: ref.versionId,
                replacementToken: "synthetic-replacement-for-owned-deletion",
            });
        });
        await run(directory, profile, keys);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

test("whole credential deletion retires all purposes and exact key but preserves public profile data", async () =>
    fixture(async (directory, profile, keys) => {
        await updatePrivate(directory, "trust.json", () => ({ public: "keep" }));
        const preserved = await readFile(join(directory, "trust.json"));
        await profile.deleteCredentials();
        assert.equal(keys.values.size, 0);
        assert.deepEqual(await readdir(join(directory, "vault")), ["deletion.json"]);
        assert.deepEqual(await readFile(join(directory, "trust.json")), preserved);
        const tombstone = JSON.parse(
            await readFile(join(directory, "vault", "deletion.json"), "utf8"),
        );
        assert.equal(tombstone.state, "deleted");
        assert.equal(tombstone.keys[0].status, "absent");
        await assert.rejects(
            profile.transaction((tx) => tx.set(ref, "must-not-recreate")),
            /VAULT_PROFILE_DELETED/,
        );
        await assert.rejects(profile.recoverInitialization(), /VAULT_PROFILE_DELETED/);
        await profile.deleteCredentials();
        assert.equal(keys.writes, 1);
        assert.equal(keys.deletes, 1);
    }));

test("uncertain key retirement remains pending and explicit resume reads exact scope before any repeat mutation", async () =>
    fixture(async (directory, profile, keys) => {
        const [scope, key] = [...keys.values][0]!;
        keys.uncertain = true;
        await assert.rejects(profile.deleteCredentials(), /VAULT_MUTATION_UNCONFIRMED/);
        assert.equal(
            JSON.parse(await readFile(join(directory, "vault", "deletion.json"), "utf8")).state,
            "pending",
        );
        await assert.rejects(
            profile.transaction((tx) => tx.device()),
            /VAULT_PROFILE_DELETION_REQUIRED/,
        );
        keys.values.delete(scope);
        await profile.deleteCredentials();
        assert.equal(keys.deletes, 1);
        assert.equal(keys.writes, 1);
        keys.values.set(scope, key);
        keys.uncertain = false;
        await profile.deleteCredentials();
        assert.equal(keys.values.size, 0);
        assert.equal(keys.deletes, 2);
    }));

test("local retirement uncertainty retains the key and exact remaining file intentions", async () =>
    fixture(async (directory, profile, keys) => {
        const original = VaultFiles.prototype.remove;
        let injected = false;
        VaultFiles.prototype.remove = async function (name) {
            await original.call(this, name);
            if (!injected && name.startsWith("record-")) {
                injected = true;
                throw new Error("VAULT_COMMIT_UNCONFIRMED");
            }
        };
        try {
            await assert.rejects(profile.deleteCredentials(), /VAULT_COMMIT_UNCONFIRMED/);
        } finally {
            VaultFiles.prototype.remove = original;
        }
        assert.equal(keys.deletes, 0);
        assert.equal(keys.values.size, 1);
        assert.equal(
            JSON.parse(await readFile(join(directory, "vault", "deletion.json"), "utf8")).state,
            "pending",
        );
        await profile.deleteCredentials();
        assert.equal(keys.values.size, 0);
    }));

test("locked or conflicting keys cannot be deleted as a guessed profile scope", async () =>
    fixture(async (directory, profile, keys) => {
        keys.locked = true;
        await assert.rejects(profile.deleteCredentials(), /VAULT_LOCKED/);
        keys.locked = false;
        const [scope, actual] = [...keys.values][0]!;
        keys.values.set(scope, randomBytes(32));
        await assert.rejects(profile.deleteCredentials(), /VAULT_KEY_CONFLICT/);
        assert.equal(keys.deletes, 0);
        keys.values.set(scope, actual);
        await profile.deleteCredentials();
        assert.equal(
            JSON.parse(await readFile(join(directory, "vault", "deletion.json"), "utf8")).state,
            "deleted",
        );
    }));

/** 旧初始化意图即使先前记录缺失，也可能在外部服务延迟完成后重新出现；此例保留实际旧版本摘要并模拟该迟到密钥，整体退役必须按原范围再次核验和清理，不能只删除当前 active 版本就宣称完成。 */
test("whole credential deletion retains and rechecks late old initialization scopes", async () =>
    fixture(async (directory, profile, keys) => {
        const manifest = JSON.parse(
            await readFile(join(directory, "vault", "profile.json"), "utf8"),
        );
        const old = randomBytes(32),
            oldVersion = randomUUID();
        const files = await VaultFiles.acquire(join(directory, "vault"));
        try {
            await files.write(
                "initialization.json",
                JSON.stringify({
                    version: 1,
                    profileId: manifest.profileId,
                    state: "active",
                    previous: [
                        {
                            keyVersion: oldVersion,
                            keyHash: createHash("sha256").update(old).digest("hex"),
                            status: "absent",
                        },
                    ],
                    next: { keyVersion: manifest.keyVersion, keyHash: manifest.keyHash },
                }),
            );
        } finally {
            await files.close();
        }
        keys.values.set(
            JSON.stringify({ profileId: manifest.profileId, keyVersion: oldVersion }),
            old,
        );
        await profile.deleteCredentials();
        const journal = JSON.parse(
            await readFile(join(directory, "vault", "deletion.json"), "utf8"),
        );
        assert.equal(journal.keys.length, 2);
        assert.equal(journal.keys[0].keyVersion, oldVersion);
        assert(journal.keys.every((entry: { status: string }) => entry.status === "absent"));
        assert.equal(keys.values.size, 0);
        assert.equal(keys.deletes, 2);
    }));

test("whole deletion refuses a separately owned Desktop and leaves all credentials readable", async () =>
    fixture(async (directory, profile, keys) => {
        const { acquireDesktopProfileOwner } = await import("../src/credentials/ownership.ts");
        const owner = await acquireDesktopProfileOwner(directory);
        try {
            await assert.rejects(profile.deleteCredentials(), /AGENT_RUNNING_STOP_FIRST/);
        } finally {
            await owner.release();
        }
        assert.equal(keys.deletes, 0);
        assert.equal(await profile.transaction((tx) => tx.resolve(ref)), "synthetic-owned-secret");
        assert.equal((await readdir(join(directory, "vault"))).includes("deletion.json"), false);
    }));

/** 命令行的永久退役必须带明确确认标志，测试用真实 CLI 子进程检查拒绝发生在创建凭据目录之前；失败输出只包含稳定错误，不写入令牌、不依赖系统保险库可用性，也不通过测试专用环境变量选择后端。 */
test("CLI whole-profile deletion requires explicit confirmation before touching a profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "veriq-delete-cli-"));
    try {
        await assert.rejects(
            promisify(execFile)(
                process.execPath,
                [
                    "--import",
                    "tsx",
                    fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
                    "--config-dir",
                    join(root, "untouched"),
                    "secret",
                    "delete-profile",
                ],
                { timeout: 15000, maxBuffer: 8192 },
            ),
            (error: unknown) => {
                assert.match(
                    (error as { stderr: string }).stderr,
                    /CREDENTIAL_PROFILE_DELETE_CONFIRMATION_REQUIRED/,
                );
                return true;
            },
        );
        assert.deepEqual(await readdir(root), []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
