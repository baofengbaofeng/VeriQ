import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { updatePrivate } from "../../runtime/src/offline/config.ts";
import { stopTestAgent } from "../../../tests/e2e/agent-owner.ts";
import { bindAgentControl } from "../../../tests/e2e/agent-wire.ts";

/**
 * 原始超时必须保留在框架报告中，独占文件锁仍要在同一轮回收，迟到的启动只进入清理流程且没有机会向后继步骤交付句柄。
 */
test("a timed out Playwright body releases its server lock and retires its late launch", async () => {
    const root = await mkdtemp(join(tmpdir(), "veriq-owner-timeout-"));
    const config = join(root, "playwright.config.cjs");
    const testDir = fileURLToPath(new URL("./fixtures", import.meta.url));
    try {
        await writeFile(
            config,
            "module.exports=" +
                JSON.stringify({
                    testDir,
                    testMatch: "recovery-timeout.spec.ts",
                    timeout: 6000,
                    workers: 1,
                    retries: 0,
                    outputDir: join(root, "results"),
                    reporter: "line",
                }),
        );
        const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");
        await assert.rejects(
            promisify(execFile)(process.execPath, [cli, "test", "--config", config], {
                env: { ...process.env, VERIQ_TEST_RECOVERY_DIRECTORY: root },
                timeout: 30000,
            }),
            (error: Error & { code?: number; stdout?: string }) =>
                error.code === 1 && !!error.stdout?.includes("Test timeout of 1500ms exceeded"),
        );
        assert.deepEqual((await readFile(join(root, "events"), "utf8")).trim().split("\n").sort(), [
            "late-disposed",
            "revoked",
            "server-closed",
            "started",
        ]);
        const db = new DatabaseSync(join(root, "held.db"));
        try {
            db.exec("BEGIN EXCLUSIVE; COMMIT");
        } finally {
            db.close();
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

/**
 * 同一受控套接字先后要求不同实例凭据，状态查询完成以后替换描述文件，停止请求仍须使用最初凭据并由新实例拒绝派发。
 */
test("a replacement agent at the same private socket receives no authorized stop", async () => {
    const profile = await realpath(await mkdtemp("/tmp/veriq-owner-"));
    const socket = join(profile, "desktop-agent.sock");
    let nonce = "1".repeat(64);
    let stops = 0;
    const broker = createServer((peer) =>
        peer.once("data", (raw) => {
            const request = JSON.parse(String(raw));
            const accepted = request.nonce === nonce;
            if (accepted && request.command.operation === "stop") stops++;
            peer.end(
                JSON.stringify(
                    accepted ? { ok: true, value: { ok: true, value: { pid: process.pid } } } : { ok: false },
                ) + "\n",
            );
        }),
    );
    try {
        await new Promise<void>((resolve, reject) => {
            broker.once("error", reject);
            broker.listen(socket, () => {
                broker.off("error", reject);
                resolve();
            });
        });
        await updatePrivate(profile, "desktop-agent.json", () => ({ socket, nonce }));
        const bound = await bindAgentControl(profile);
        assert.equal((await bound.call({ operation: "status" })).pid, process.pid);
        nonce = "2".repeat(64);
        await updatePrivate(profile, "desktop-agent.json", () => ({ socket, nonce }));
        await assert.rejects(bound.call({ operation: "stop" }), /TEST_AGENT_CONTROL_FAILED/);
        assert.equal(stops, 0);
    } finally {
        if (broker.listening) await new Promise<void>((ok) => broker.close(() => ok()));
        await rm(profile, { recursive: true, force: true });
    }
});

test("changed agent identity cannot dispatch cleanup control", async () => {
    let calls = 0;
    const profile = "/unopened-recovery-profile";
    const captured = {
        profile,
        pid: process.platform === "linux" ? process.pid : process.pid + 1,
        uid: process.getuid?.() ?? 0,
        start: "not-the-observed-start",
        control: {
            call: async () => {
                calls++;
                return { pid: process.pid, stopped: true };
            },
        },
    };
    await assert.rejects(stopTestAgent(profile, process.pid, captured), /TEST_AGENT_IDENTITY_MISMATCH/);
    assert.equal(calls, 0);
});
