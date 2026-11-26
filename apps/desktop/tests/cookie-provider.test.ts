/**
 * 提供者测试仅使用有限合成对象和受控时钟检查已锁 Electron 的平台策略，公开探针不含用户数据；这里不会初始化 Electron、
 * 读取真实 Keychain、创建 Cookie 或把合成成功当成 Mac 原生验收。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { probeCookieProvider, type CookieSafeStorage } from "../src/main/cookie-provider.ts";

const publicProbe = "VeriQ public Cookie protection probe 45.3.1";
const required = { message: "COOKIE_OS_PROTECTION_REQUIRED" };
const unavailable = { message: "COOKIE_OS_PROTECTION_UNAVAILABLE" };

function storage(tag = "v10") {
    const calls: string[] = [];
    let plaintext = "";
    const safe: CookieSafeStorage = {
        isAsyncEncryptionAvailable: async () => {
            calls.push("available");
            return true;
        },
        encryptStringAsync: async (value) => {
            calls.push("encrypt");
            plaintext = value;
            assert.equal(value, publicProbe);
            return Buffer.concat([Buffer.from(tag), Buffer.alloc(64, 7)]);
        },
        decryptStringAsync: async () => {
            calls.push("decrypt");
            return { result: plaintext, shouldReEncrypt: false };
        },
    };
    return { safe, calls };
}

test("Darwin without Linux backend API proves keychain/v10 exact roundtrip", async () => {
    const { safe, calls } = storage();
    assert.equal("getSelectedStorageBackend" in safe, false);
    assert.deepEqual(await probeCookieProvider(safe, "darwin"), {
        platform: "darwin",
        backend: "keychain",
        provider: "v10",
        encrypted: true,
    });
    assert.deepEqual(calls, ["available", "encrypt", "decrypt"]);
});

test("Windows without Linux backend API proves dpapi/v10", async () => {
    assert.deepEqual(await probeCookieProvider(storage().safe, "win32"), {
        platform: "win32",
        backend: "dpapi",
        provider: "v10",
        encrypted: true,
    });
});

test("Darwin and Windows never read even an exposed Linux backend getter", async () => {
    for (const platform of ["darwin", "win32"] as const) {
        const { safe } = storage();
        Object.defineProperty(safe, "getSelectedStorageBackend", {
            get: () => assert.fail("Linux backend getter was accessed"),
        });
        assert.equal((await probeCookieProvider(safe, platform)).provider, "v10");
    }
});

test("Linux reads its backend and accepts only v11/v12 protected providers", async () => {
    for (const tag of ["v11", "v12"]) {
        const { safe, calls } = storage(tag);
        safe.getSelectedStorageBackend = () => {
            calls.push("backend");
            return "gnome_libsecret";
        };
        assert.deepEqual(await probeCookieProvider(safe, "linux"), {
            platform: "linux",
            backend: "gnome_libsecret",
            provider: tag,
            encrypted: true,
        });
        assert.deepEqual(calls, ["available", "backend", "encrypt", "decrypt"]);
    }
});

test("Linux rejects fixed fallback and fails closed without its backend API", async () => {
    const fallback = storage("v11");
    fallback.safe.getSelectedStorageBackend = () => "basic_text";
    await assert.rejects(probeCookieProvider(fallback.safe, "linux"), required);
    assert.deepEqual(fallback.calls, ["available"]);
    await assert.rejects(probeCookieProvider(storage("v11").safe, "linux"), unavailable);
    for (const tag of ["v10", "v99"]) {
        const { safe } = storage(tag);
        safe.getSelectedStorageBackend = () => "unknown";
        await assert.rejects(probeCookieProvider(safe, "linux"), required);
    }
});

test("Darwin refuses v11/v12/unknown and Windows refuses non-DPAPI tags", async () => {
    for (const platform of ["darwin", "win32"] as const) {
        for (const tag of ["v11", "v12", "v99"]) {
            const { safe, calls } = storage(tag);
            await assert.rejects(probeCookieProvider(safe, platform), required);
            assert.deepEqual(calls, ["available", "encrypt"]);
        }
    }
});

test("Unavailable storage stops before encryption", async () => {
    const { safe, calls } = storage();
    safe.isAsyncEncryptionAvailable = async () => false;
    await assert.rejects(probeCookieProvider(safe, "darwin"), unavailable);
    assert.deepEqual(calls, []);
});

test("Native errors at every OS stage are sanitized including policy-like text", async () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
        const stages =
            platform === "linux" ? ["available", "backend", "encrypt", "decrypt"] : ["available", "encrypt", "decrypt"];
        for (const stage of stages) {
            for (const message of ["PRIVATE_NATIVE_ACCOUNT_PATH", "COOKIE_OS_PROTECTION_REQUIRED"]) {
                const { safe } = storage(platform === "linux" ? "v11" : "v10");
                safe.getSelectedStorageBackend = () => "gnome_libsecret";
                const fail = () => {
                    throw new Error(message);
                };
                if (stage === "available") safe.isAsyncEncryptionAvailable = fail;
                if (stage === "backend") safe.getSelectedStorageBackend = fail;
                if (stage === "encrypt") safe.encryptStringAsync = fail;
                if (stage === "decrypt") safe.decryptStringAsync = fail;
                await assert.rejects(probeCookieProvider(safe, platform), unavailable);
            }
        }
    }
});

test("Darwin rejects mismatched plaintext or any re-encryption request", async () => {
    for (const decoded of [
        { result: "different", shouldReEncrypt: false },
        { result: publicProbe, shouldReEncrypt: true },
        { result: publicProbe, shouldReEncrypt: undefined },
    ]) {
        const { safe } = storage();
        safe.decryptStringAsync = async () => decoded as { result: string; shouldReEncrypt: boolean };
        await assert.rejects(probeCookieProvider(safe, "darwin"), required);
    }
});

test("Darwin rejects malformed ciphertext and high-bit tag aliases before decryption", async () => {
    for (const encoded of [
        new Uint8Array(32),
        "v10",
        Buffer.alloc(15),
        Buffer.alloc(1025),
        Buffer.concat([Buffer.from([0xf6, 0xb1, 0xb0]), Buffer.alloc(16)]),
    ]) {
        const { safe, calls } = storage();
        safe.encryptStringAsync = async () => encoded as Buffer;
        await assert.rejects(probeCookieProvider(safe, "darwin"), required);
        assert.equal(calls.includes("decrypt"), false);
    }
});

test("Darwin accepts the finite ciphertext length endpoints", async () => {
    for (const length of [16, 1024]) {
        const { safe } = storage();
        safe.encryptStringAsync = async (value) => {
            assert.equal(value, publicProbe);
            return Buffer.concat([Buffer.from("v10"), Buffer.alloc(length - 3)]);
        };
        safe.decryptStringAsync = async () => ({ result: publicProbe, shouldReEncrypt: false });
        assert.equal((await probeCookieProvider(safe, "darwin")).encrypted, true);
    }
});

test("Unknown platforms reject before accessing any OS capability", async () => {
    const safe = new Proxy({} as CookieSafeStorage, {
        get: () => assert.fail("Unexpected OS capability access"),
    });
    for (const platform of ["aix", "freebsd", "openbsd"] as const) {
        await assert.rejects(probeCookieProvider(safe, platform), {
            message: "COOKIE_PLATFORM_UNSUPPORTED",
        });
    }
});

test("Deadline bounds waiting at 5000ms and late OS settlement cannot change rejection", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const clear = t.mock.method(globalThis, "clearTimeout");
    const { safe, calls } = storage();
    let release!: (available: boolean) => void;
    safe.isAsyncEncryptionAvailable = () => new Promise((resolve) => (release = resolve));
    let settled = false;
    const pending = probeCookieProvider(safe, "darwin");
    const rejected = assert.rejects(pending, unavailable).then(() => (settled = true));
    t.mock.timers.tick(4999);
    await Promise.resolve();
    assert.equal(settled, false);
    t.mock.timers.tick(1);
    await rejected;
    assert.equal(clear.mock.callCount(), 1);
    release(true);
    await Promise.resolve();
    await Promise.resolve();
    await assert.rejects(pending, unavailable);
    assert.deepEqual(calls, ["encrypt", "decrypt"]);
    assert.equal(clear.mock.callCount(), 1);
});

test("Successful and policy/native failed probes each clear their deadline timer", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const scheduled = t.mock.method(globalThis, "setTimeout");
    const cleared = t.mock.method(globalThis, "clearTimeout");
    await probeCookieProvider(storage().safe, "darwin");
    await assert.rejects(probeCookieProvider(storage("v12").safe, "darwin"), required);
    const { safe } = storage();
    safe.encryptStringAsync = async () => {
        throw new Error("PRIVATE_NATIVE_MESSAGE");
    };
    await assert.rejects(probeCookieProvider(safe, "darwin"), unavailable);
    assert.equal(scheduled.mock.callCount(), 3);
    assert.equal(cleared.mock.callCount(), 3);
    for (let index = 0; index < 3; index++) {
        assert.equal(scheduled.mock.calls[index]?.arguments[1], 5000);
        assert.equal(cleared.mock.calls[index]?.arguments[0], scheduled.mock.calls[index]?.result);
    }
});
