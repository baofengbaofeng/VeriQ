/**
 * 真实钥匙串行为仅允许明确声明为可丢弃且已配置的独立登录会话执行，未提供操作者声明或实际会话身份不符时直接失败，不通过
 * 跳过用例把缺少系统验收包装为成功结果。
 */
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
    await fixture.settle(async () => {
        assert.equal(await fixture.status("get", profile, version), "missing");
        assert.equal(await fixture.status("set", profile, version, key), "ok");
        assert.equal(await fixture.matches(profile, version, key), true);
        assert.equal(await fixture.status("set", profile, version, key), "ok");
        assert.equal(await fixture.status("set", profile, version, different), "failed");
        assert.equal(await fixture.matches(profile, version, key), true);
        assert.equal(await fixture.status("get", profile.toUpperCase(), version), "missing");
        assert.equal(await fixture.status("get", version, profile), "missing");
        assert.equal(await fixture.race(version, version, key, key), true);
        assert.equal(await fixture.matches(version, version, key), true);
        assert.equal(await fixture.race("21234567-89ab-cdef-0123-456789abcdef", version, key, different), true);
        await fixture.control("lock");
        assert.equal(await fixture.status("get", profile, version), "locked");
        await fixture.control("unlock");
        assert.equal(await fixture.matches(profile, version, key), true);
        assert.equal(await fixture.status("delete", profile, version), "ok");
        assert.equal(await fixture.status("get", profile, version), "missing");
        for (const policy of ["broad", "empty", "any", "second", "owner", "mixed", "unknown", "denied"] as const) {
            await fixture.control("seed", {
                policy,
                profile,
                version,
                key: key.toString("base64"),
            });
            assert.equal(await fixture.status("get", profile, version), "failed");
            assert.equal(await fixture.status("set", profile, version, different), "failed");
            assert.equal(await fixture.status("delete", profile, version), "failed");
            assert.equal(await fixture.unchanged(profile, version), true);
            await fixture.control("remove", { profile, version });
        }
        assert.equal(await fixture.uncertainRecovery(profile, version, key), true);
    }, [
        () => {
            key.fill(0);
        },
        () => {
            different.fill(0);
        },
    ]);
});

/**
 * 此独立负例保留前面的生产策略拒绝测试，并额外让同一 helper 在禁止交互状态下真正请求被 ACL 拒绝的数据；成功必须包含两
 * 个主体观察的真实解锁状态和授权主体读回的未变化证明，缺少会话时仍硬失败而非跳过。
 */
test("dedicated session observes real unlocked OS secret-read denial", async () => {
    const fixture = await dedicatedFixture();
    const key = Buffer.alloc(32, 73);
    await fixture.settle(async () => {
        await fixture.control("seed", {
            policy: "denied",
            profile,
            version,
            key: key.toString("base64"),
        });
        assert.equal(await fixture.readDenial(profile, version), true);
        await fixture.control("remove", { profile, version });
    }, [
        () => {
            key.fill(0);
        },
    ]);
});
