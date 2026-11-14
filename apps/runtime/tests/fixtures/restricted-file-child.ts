/** 此有限子程序只在临时 Linux CI 的自有专用账户和 bind 卷内运行，实际跨进程创建、读取与退休凭据并检查权限拒绝；所有业务值均为公开合成标记，随机原始密钥绝不写入输出，测试不声称 OS vault、机器掉电或正式部署持久性验收。 */
import assert from "node:assert/strict";
import { chmod, lstat, readFile, readdir, rename, symlink, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir, userInfo } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { VaultFiles } from "../../src/credentials/files.ts";
import { managedFileCredentials } from "../../src/credentials/restricted-file.ts";
import { CredentialProfile } from "../../src/credentials/profile.ts";
import { SecretStore } from "../../src/credentials/store.ts";
import { DeviceStore } from "../../src/enrollment.ts";
import { updatePrivate } from "../../src/offline/config.ts";

assert.equal(process.platform, "linux");
assert.equal(process.versions.node, "24.22.1");
const [phase, volume, uid] = process.argv.slice(2);
assert(volume && uid && ["seed", "restart", "retired"].includes(phase!));
const codeRoot = resolve(import.meta.dirname, "../..");
const code = await lstat(codeRoot),
    source = await lstat(import.meta.filename);
assert.equal(process.cwd(), codeRoot);
assert.equal(code.uid, 0);
assert.equal(code.mode & 0o777, 0o755);
assert.equal(source.uid, 0);
assert.equal(source.mode & 0o777, 0o644);
const directory = join(volume, "profile");
const policy = {
    mode: "restricted-file" as const,
    managedHeadless: true,
    serviceUid: Number(uid),
    persistentVolume: volume,
    profileDirectory: directory,
    acknowledgeUnencryptedStorage: true,
};
const options = await managedFileCredentials(policy),
    backend = options.backend;
const profile = new CredentialProfile(directory, options);
const ref = {
    issuerId: "owned",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    secretRef: "service",
    versionId: "22222222-2222-4222-8222-222222222222",
};
const device = {
    server: "https://control.example",
    runnerId: "33333333-3333-4333-8333-333333333333",
    workspaceId: ref.workspaceId,
    deviceToken: "synthetic-owned-restricted-device",
    expiresAt: "2027-01-01T00:00:00Z",
};
const facts: Record<string, unknown> = {
    phase,
    codeRoot,
    cwd: process.cwd(),
    sourceOwnerUid: source.uid,
    sourceMode: source.mode & 0o777,
    uid: process.getuid!(),
    euid: process.geteuid!(),
    gid: process.getgid!(),
    egid: process.getegid!(),
    passwdHome: userInfo().homedir,
    observedHome: homedir(),
    homeEnvironmentProvided: process.env.HOME !== undefined,
    pid: process.pid,
    node: process.versions.node,
    executable: process.execPath,
    mode: "restricted-file",
    encryptionAtRest: false,
};
const status = await readFile("/proc/self/status", "utf8");
const procUid = /^Uid:\s+([0-9\s]+)$/m.exec(status)?.[1]?.trim().split(/\s+/).map(Number);
const procGid = /^Gid:\s+([0-9\s]+)$/m.exec(status)?.[1]?.trim().split(/\s+/).map(Number);
assert.equal(procUid?.length, 4);
assert.equal(procGid?.length, 4);
assert(procUid!.every((value) => value === Number(uid)));
assert(procGid!.every((value) => value === process.getgid!()));
assert.equal(/^NoNewPrivs:\s+(\d+)$/m.exec(status)?.[1], "1");
Object.assign(facts, { procUid, procGid, noNewPrivileges: true });
assert.equal(process.getuid!(), Number(uid));
assert.equal((await backend.probe(AbortSignal.timeout(5000))).status, "ready");
if (phase === "seed") {
    await profile.transaction(async (tx) => {
        await tx.set(ref, "synthetic-owned-restricted-value");
        await tx.saveDevice(device, true);
        await tx.saveRotation({
            previous: device,
            clientRequestId: ref.versionId,
            replacementToken: "synthetic-owned-restricted-replacement",
        });
    });
    await updatePrivate(directory, "public-marker.json", () => ({ retained: true }));
    facts.threePurposesCreated = true;
} else if (phase === "restart") {
    assert.equal(
        await new SecretStore(directory, options).resolve(ref),
        "synthetic-owned-restricted-value",
    );
    assert.equal(
        (await new DeviceStore(directory, options).load()).deviceToken,
        device.deviceToken,
    );
    assert.equal(
        (await profile.transaction((tx) => tx.rotation()))?.replacementToken,
        "synthetic-owned-restricted-replacement",
    );
    const manifest = JSON.parse(await readFile(join(directory, "vault/profile.json"), "utf8"));
    const scope = { profileId: manifest.profileId, keyVersion: manifest.keyVersion };
    const member = `raw-key-${scope.profileId}-${scope.keyVersion}.json`,
        keyPath = join(directory, "restricted-keys", member);
    const file = await lstat(keyPath),
        parent = await lstat(join(directory, "restricted-keys"));
    assert.equal(file.uid, Number(uid));
    assert.equal(file.mode & 0o777, 0o600);
    assert.equal(parent.uid, Number(uid));
    assert.equal(parent.mode & 0o777, 0o700);
    const raw = JSON.parse(await readFile(keyPath, "utf8"));
    assert.equal(Buffer.from(raw.key, "base64url").length, 32);
    await chmod(keyPath, 0o644);
    try {
        assert.equal((await backend.get(scope, AbortSignal.timeout(5000))).status, "failed");
    } finally {
        await chmod(keyPath, 0o600);
    }
    await rename(keyPath, `${keyPath}.held`);
    try {
        await symlink(`${keyPath}.held`, keyPath);
        assert.equal((await backend.get(scope, AbortSignal.timeout(5000))).status, "failed");
    } finally {
        await unlink(keyPath);
        await rename(`${keyPath}.held`, keyPath);
    }
    const concurrentScope = { profileId: randomUUID(), keyVersion: randomUUID() };
    const left = randomBytes(32),
        right = randomBytes(32);
    try {
        const other = await managedFileCredentials(policy);
        const results = await Promise.all([
            backend.set(concurrentScope, left, AbortSignal.timeout(5000)),
            other.backend.set(concurrentScope, right, AbortSignal.timeout(5000)),
        ]);
        assert.deepEqual(results.map((result) => result.status).sort(), ["failed", "ok"]);
        const actual = await backend.get(concurrentScope, AbortSignal.timeout(5000));
        assert.equal(actual.status, "ok");
        if (actual.status === "ok") {
            try {
                assert.equal(actual.key.equals(results[0]!.status === "ok" ? left : right), true);
            } finally {
                actual.key.fill(0);
            }
        }
    } finally {
        left.fill(0);
        right.fill(0);
        assert(
            ["ok", "missing"].includes(
                (await backend.delete(concurrentScope, AbortSignal.timeout(5000))).status,
            ),
        );
        assert.equal(
            (await backend.get(concurrentScope, AbortSignal.timeout(5000))).status,
            "missing",
        );
    }
    /** 这里注入发生在真实文件发布及真实 unlink 已完成后的返回错误，验证生产后端不会把清理异常误报成未修改；故障是明确的测试缝，不声称内核真实失败，后续仍用正式读取确认精确密钥存在或缺失。 */
    const uncertainScope = { profileId: randomUUID(), keyVersion: randomUUID() },
        uncertainMaterial = randomBytes(32);
    const originalClose = VaultFiles.prototype.close,
        originalRemove = VaultFiles.prototype.remove;
    try {
        let injected = false;
        VaultFiles.prototype.close = async function () {
            await originalClose.call(this);
            if (!injected && this.directory === join(directory, "restricted-keys")) {
                injected = true;
                throw new Error("INJECTED_POST_PUBLISH_CLOSE");
            }
        };
        assert.equal(
            (await backend.set(uncertainScope, uncertainMaterial, AbortSignal.timeout(5000)))
                .status,
            "mutation-unconfirmed",
        );
        VaultFiles.prototype.close = originalClose;
        const actual = await backend.get(uncertainScope, AbortSignal.timeout(5000));
        assert.equal(actual.status, "ok");
        if (actual.status === "ok") {
            try {
                assert.equal(actual.key.equals(uncertainMaterial), true);
            } finally {
                actual.key.fill(0);
            }
        }
        VaultFiles.prototype.remove = async function (member) {
            await originalRemove.call(this, member);
            if (this.directory === join(directory, "restricted-keys"))
                throw new Error("INJECTED_POST_UNLINK_RETURN");
        };
        assert.equal(
            (await backend.delete(uncertainScope, AbortSignal.timeout(5000))).status,
            "mutation-unconfirmed",
        );
        VaultFiles.prototype.remove = originalRemove;
        assert.equal(
            (await backend.get(uncertainScope, AbortSignal.timeout(5000))).status,
            "missing",
        );
    } finally {
        VaultFiles.prototype.close = originalClose;
        VaultFiles.prototype.remove = originalRemove;
        uncertainMaterial.fill(0);
        assert(
            ["ok", "missing"].includes(
                (await backend.delete(uncertainScope, AbortSignal.timeout(5000))).status,
            ),
        );
    }
    Object.assign(facts, {
        threePurposesReadAfterRestart: true,
        privateFileMode: file.mode & 0o777,
        privateDirectoryMode: parent.mode & 0o777,
        rawKeyFileConfirmed: true,
        publicModeRefused: true,
        symlinkRefused: true,
        concurrentOverwriteRefused: true,
        postPublishCloseUnconfirmed: true,
        postUnlinkUnconfirmed: true,
    });
} else {
    await assert.rejects(new DeviceStore(directory, options).load(), /VAULT_PROFILE_DELETED/);
    assert.deepEqual(await readdir(join(directory, "restricted-keys")), []);
    assert.deepEqual(await readdir(join(directory, "vault")), ["deletion.json"]);
    assert.equal(
        JSON.parse(await readFile(join(directory, "public-marker.json"), "utf8")).retained,
        true,
    );
    Object.assign(facts, {
        exactKeysRemoved: true,
        tombstoneRetained: true,
        publicDataRetained: true,
        restartCannotReinitialize: true,
    });
}
process.stdout.write(JSON.stringify(facts) + "\n");
