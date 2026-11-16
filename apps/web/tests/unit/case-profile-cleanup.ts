/** 这些独立 Node 用例只验证错误结算和测试目录保留策略，受控日志不代表真实 Agent 停止证据；真实进程生命周期、浏览器发布及恢复目录释放仍必须在独立受管理引擎验收中观察。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupCaseProfile, withCleanup } from "../support/case-profile-cleanup.js";

// 四种结算组合以及抛出 undefined 的情况都必须区分错误存在性，单项失败检查原始对象身份，双失败检查错误顺序与 cause，保证清理无法覆盖首先发生的正文失败。
test("body and cleanup preserve exact outcomes including thrown undefined", async () => {
    for (const bodyFailed of [false, true]) {
        for (const cleanupFailed of [false, true]) {
            for (const bodyError of [undefined, new Error("body")]) {
                const cleanupError = new Error("cleanup");
                let cleaned = 0;
                let failed = false;
                let result: unknown;
                try {
                    await withCleanup(async () => {
                        if (bodyFailed) throw bodyError;
                    }, async () => {
                        cleaned += 1;
                        if (cleanupFailed) throw cleanupError;
                    });
                } catch (error) {
                    failed = true;
                    result = error;
                }
                assert.equal(cleaned, 1);
                assert.equal(failed, bodyFailed || cleanupFailed);
                if (bodyFailed && cleanupFailed) {
                    assert.ok(result instanceof AggregateError);
                    assert.deepEqual(result.errors, [bodyError, cleanupError]);
                    assert.equal(result.cause, bodyError);
                } else if (bodyFailed) assert.equal(result, bodyError);
                else if (cleanupFailed) assert.equal(result, cleanupError);
            }
        }
    }
    let failed = false;
    try {
        await withCleanup(async () => {}, async () => { throw undefined; });
    } catch (error) {
        failed = true;
        assert.equal(error, undefined);
    }
    assert.equal(failed, true);
});

// 文件系统回归使用本测试创建的隔离目录，分别构造没有日志、路径不可读、坏 JSON、未知停止状态和证据写入失败；任何失败都必须保留原目录，只有明确 STOPPED 才允许删除。
test("profile cleanup retains uncertain journals and failed evidence writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "veriq-web-cleanup-"));
    try {
        for (const scenario of ["absent", "not-directory", "malformed", "running", "write-failed", "stopped"]) {
            const profile = join(root, scenario);
            const processes = join(profile, "agent/processes");
            const evidence = join(root, scenario + ".json");
            await mkdir(join(profile, "agent"), { recursive: true });
            if (scenario === "not-directory") await writeFile(processes, "blocked");
            else if (scenario !== "absent") {
                await mkdir(processes);
                await writeFile(join(processes, "one.process.json"), scenario === "malformed" ? "{" : JSON.stringify({
                    attemptId: "11111111-1111-4111-8111-111111111111",
                    state: scenario === "running" ? "RUNNING" : "STOPPED",
                    pid: 123,
                    guardianPid: 456,
                    nonce: "must-not-be-copied",
                }));
            }
            if (["absent", "stopped"].includes(scenario)) {
                await cleanupCaseProfile(profile, evidence);
                await assert.rejects(stat(profile), { code: "ENOENT" });
                const summary = await readFile(evidence, "utf8");
                assert.equal(summary.includes("must-not-be-copied"), false);
                assert.equal(JSON.parse(summary).length, scenario === "absent" ? 0 : 1);
            } else {
                await assert.rejects(cleanupCaseProfile(profile, scenario === "write-failed" ? join(root, "missing/summary.json") : evidence));
                assert.equal((await stat(profile)).isDirectory(), true);
            }
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
