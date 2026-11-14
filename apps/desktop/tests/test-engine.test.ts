import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { testEngine } from "../../../tests/e2e/engine.ts";

/** 候选参数在任何平台夹具启动前必须完整且可校验，实际选定库存用于验证默认身份或本轮新候选以及错误规范摘要拒绝；这些测试不生产新候选、不写发行批准文件，也不依赖 renderer 提供版本来绕过库存验证。 */
test("trusted engine selection verifies the selected inventory and rejects incomplete or wrong identities", async () => {
    const root = resolve("../..");
    const existing = await testEngine(root);
    assert.equal(existing.version, process.env.VERIQ_TEST_ENGINE_VERSION ?? "1.0.0");
    await assert.rejects(
        testEngine(root, { VERIQ_TEST_ENGINE_DIRECTORY: existing.directory }),
        /INCOMPLETE_TEST_ENGINE/,
    );
    const override = {
        VERIQ_TEST_ENGINE_DIRECTORY: existing.directory,
        VERIQ_TEST_ENGINE_VERSION: existing.version,
        VERIQ_TEST_ENGINE_HASH: existing.hash,
    };
    assert.deepEqual(await testEngine(root, override), existing);
    await assert.rejects(
        testEngine(root, { ...override, VERIQ_TEST_ENGINE_HASH: "0".repeat(64) }),
        /TEST_ENGINE_HASH_MISMATCH/,
    );
    await assert.rejects(
        testEngine(root, { ...override, VERIQ_TEST_ENGINE_VERSION: "9.9.9" }),
        /ENGINE_NOT_APPROVED/,
    );
});
