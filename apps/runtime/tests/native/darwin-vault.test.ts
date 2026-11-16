/** 普通 Mac 流水线只观察有界协议、真实子进程退出及内存中的权限模板，这组测试绝不发送能够触及默认钥匙串的合法生产请求，
 * 因而不能代替独立登录会话中的持久存储验收。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { nativeCall, nativePaths, requireMac, runMemoryChecks } from "../fixtures/darwin-vault.ts";

requireMac();
const scope = "01234567-89ab-cdef-0123-456789abcdef 11234567-89ab-cdef-0123-456789abcdef";

test("production refuses argv and malformed frames before store access", async () => {
    for (const frame of [
        "V2 probe\n",
        "V1 unknown\n",
        "V1 get bad bad\n",
        "V1 probe extra\n",
        "V1  probe\n",
        "V1 probe\r\n",
        "x".repeat(513) + "\n",
        `V1 set ${scope} invalid\n`,
    ]) {
        const result = await nativeCall(nativePaths.production, frame);
        assert.equal(result.exitConfirmed && result.bytes.length === 0 && result.code !== 0, true);
        result.bytes.fill(0);
    }
    const result = await nativeCall(nativePaths.production, "V1 probe\n", { args: ["invalid"] });
    assert.equal(result.exitConfirmed && result.code !== 0 && result.bytes.length === 0, true);
});

test("test helper refuses absent and counterfeit store capability", async () => {
    for (const capability of [undefined, { mode: "store", path: "/tmp/not-authorized" }]) {
        const result = await nativeCall(nativePaths.test, "V1 probe\n", { capability });
        assert.equal(result.exitConfirmed && result.code !== 0 && result.bytes.length === 0, true);
    }
});

test("EOF before a frame never reaches Security operations", async () => {
    const result = await nativeCall(nativePaths.production, "V1 pro", { closeInput: true });
    assert.equal(result.exitConfirmed && result.code !== 0 && result.bytes.length === 0, true);
});

test("gate observes EOF and extra bytes after watcher readiness", async () => {
    for (const afterReady of ["eof", "extra"] as const) {
        const result = await nativeCall(nativePaths.test, "V1 probe\n", {
            capability: { mode: "gate" },
            afterReady,
        });
        assert.equal(result.exitConfirmed && result.code === 125 && result.ready, true);
    }
});

test("deadline and cancellation report actual termination", async () => {
    for (const cancel of [false, true]) {
        const result = await nativeCall(nativePaths.test, "V1 probe\n", {
            capability: { mode: "gate" },
            timeoutMs: 250,
            cancel,
        });
        assert.equal(
            result.exitConfirmed &&
                result.ready &&
                result.reason === (cancel ? "cancelled" : "timeout"),
            true,
        );
    }
});

test("valid binary frames are accepted without store access in the protocol driver", async () => {
    const key = Buffer.from(Array.from({ length: 32 }, (_, index) => (index === 31 ? 255 : index)));
    try {
        const result = await nativeCall(
            nativePaths.test,
            `V1 set ${scope} ${key.toString("base64url")}\n`,
            { capability: { mode: "validate" } },
        );
        assert.equal(
            result.exitConfirmed &&
                result.code === 0 &&
                result.bytes.equals(Buffer.from("V1 ok\n")),
            true,
        );
        result.bytes.fill(0);
    } finally {
        key.fill(0);
    }
});

test("public ACL templates and adversarial typed trees remain nonpersistent", async () => {
    assert.equal(await runMemoryChecks(), true);
});
