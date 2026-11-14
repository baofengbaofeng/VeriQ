/** 真实钥匙串行为仅允许明确声明为可丢弃且已配置的独立登录会话执行，未提供操作者声明或实际会话身份不符时直接失败，不通过跳过用例把缺少系统验收包装为成功结果。 */
import test from "node:test";
import assert from "node:assert/strict";
import { dedicatedFixture, requireMac } from "../fixtures/darwin-vault.ts";

requireMac();
const profile = "01234567-89ab-cdef-0123-456789abcdef";
const version = "11234567-89ab-cdef-0123-456789abcdef";

test("dedicated session proves persistent exact-scope storage and refusal behavior", async () => {
    const fixture = await dedicatedFixture();
    const key = Buffer.from(Array.from({ length: 32 }, (_, index) => (index === 31 ? 255 : index)));
    const different = Buffer.alloc(32, 91);
    try {
        assert.equal(await fixture.status("get", profile, version), "missing");
        assert.equal(await fixture.status("set", profile, version, key), "ok");
        assert.equal(await fixture.matches(profile, version, key), true);
        assert.equal(await fixture.status("set", profile, version, key), "ok");
        assert.equal(await fixture.status("set", profile, version, different), "failed");
        assert.equal(await fixture.matches(profile, version, key), true);
        assert.equal(await fixture.status("get", profile.toUpperCase(), version), "missing");
        assert.equal(await fixture.status("get", version, profile), "missing");
        const raced = await Promise.all([
            fixture.status("set", version, version, key),
            fixture.status("set", version, version, key),
        ]);
        assert.equal(
            raced.every((value) => value === "ok"),
            true,
        );
        await fixture.control("lock");
        assert.equal(await fixture.status("get", profile, version), "locked");
        await fixture.control("unlock");
        assert.equal(await fixture.matches(profile, version, key), true);
        assert.equal(await fixture.status("delete", profile, version), "ok");
        assert.equal(await fixture.status("get", profile, version), "missing");
        for (const policy of ["broad", "empty", "any", "second", "owner", "denied"] as const) {
            await fixture.control("seed", {
                policy,
                profile,
                version,
                key: key.toString("base64"),
            });
            assert.equal(await fixture.status("get", profile, version), "failed");
            assert.equal(await fixture.status("set", profile, version, different), "failed");
            assert.equal(await fixture.status("delete", profile, version), "failed");
            assert.equal(await fixture.unchanged(profile, version, key), true);
            await fixture.control("remove", { profile, version });
        }
        assert.equal(await fixture.uncertainRecovery(profile, version, key), true);
    } finally {
        key.fill(0);
        different.fill(0);
        await fixture.cleanup();
    }
});
