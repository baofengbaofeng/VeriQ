/** Cookie 保护门闩测试使用有限的合成平台观察来检验持久 Session 创建前的拒绝行为，固定探针不携带用户凭据；真实 fuse、OS 密钥与 Cookie 数据库证据另由目标 Electron 验证，不能把这里的替身结果当作系统加密验收。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { requireCookieProtection } from "../src/main/cookie-protection.ts";

function platform(tag = "v11", backend = "gnome_libsecret") {
    let probe = "";
    return {
        isAsyncEncryptionAvailable: async () => true,
        getSelectedStorageBackend: () => backend,
        encryptStringAsync: async (value: string) => {
            probe = value;
            return Buffer.concat([Buffer.from(tag), Buffer.alloc(64, 7)]);
        },
        decryptStringAsync: async () => ({ result: probe, shouldReEncrypt: false }),
    };
}
const enabled = async () => ({ version: "1", 1: 49 });

test("Cookie persistence refuses a disabled fuse before touching the OS vault", async () => {
    const storage = platform();
    storage.isAsyncEncryptionAvailable = async () => {
        throw new Error("UNEXPECTED_OS_ACCESS");
    };
    await assert.rejects(
        requireCookieProtection(storage, "linux", async () => ({ version: "1", 1: 48 })),
        /COOKIE_ENCRYPTION_FUSE_REQUIRED/,
    );
});

test("Linux available encryption still refuses basic_text and known fallback key", async () => {
    await assert.rejects(
        requireCookieProtection(platform("v10", "basic_text"), "linux", enabled),
        /COOKIE_OS_PROTECTION_REQUIRED/,
    );
    await assert.rejects(
        requireCookieProtection(platform("v10"), "linux", enabled),
        /COOKIE_OS_PROTECTION_REQUIRED/,
    );
    await assert.rejects(
        requireCookieProtection(platform("v99"), "linux", enabled),
        /COOKIE_OS_PROTECTION_REQUIRED/,
    );
});

test("Cookie protection requires a successful exact roundtrip from an approved current provider", async () => {
    assert.deepEqual(await requireCookieProtection(platform(), "linux", enabled), {
        platform: "linux",
        backend: "gnome_libsecret",
        provider: "v11",
        encrypted: true,
    });
    assert.equal(
        (await requireCookieProtection(platform("v12", "unknown"), "linux", enabled)).provider,
        "v12",
    );
    assert.equal(
        (await requireCookieProtection(platform("v10"), "win32", enabled)).provider,
        "v10",
    );
    const failed = platform();
    failed.decryptStringAsync = async () => ({ result: "different", shouldReEncrypt: false });
    await assert.rejects(
        requireCookieProtection(failed, "linux", enabled),
        /COOKIE_OS_PROTECTION_REQUIRED/,
    );
});

test("OS unavailability and native errors never become an encrypted Cookie claim", async () => {
    const absent = platform();
    absent.isAsyncEncryptionAvailable = async () => false;
    await assert.rejects(
        requireCookieProtection(absent, "linux", enabled),
        /COOKIE_OS_PROTECTION_UNAVAILABLE/,
    );
    const rejected = platform();
    rejected.encryptStringAsync = async () => {
        throw new Error("PRIVATE_NATIVE_MESSAGE");
    };
    await assert.rejects(
        requireCookieProtection(rejected, "linux", enabled),
        (error: unknown) =>
            error instanceof Error && error.message === "COOKIE_OS_PROTECTION_UNAVAILABLE",
    );
    await assert.rejects(
        requireCookieProtection(platform(), "darwin", enabled),
        /COOKIE_PLATFORM_UNSUPPORTED/,
    );
});
