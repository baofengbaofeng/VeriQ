/** 这个可信夹具只隔离 Agent 组件的实际所有权边界，命令仍由生产 C2a2 所有者派生并通过真实 preload 记录；页面由固定
 * Playwright 公共连接实际创建，夹具不写业务成功报告，也不把组件结果冒充完整引擎验收
 * 。
 */
import { readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createControlledCommandOwner } from "../../src/execution/controlled-command.mjs";

const invocation = JSON.parse(readFileSync(process.argv[3] ?? process.argv[2], "utf8"));
if (process.argv[2] === "cli") {
    const browser = await chromium.connect(invocation.wsEndpoint);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent("<title>VeriQ actual source component</title><main>native Chrome</main>");
    if ((await page.title()) !== "VeriQ actual source component") process.exitCode = 41;
    const child = spawn(process.execPath, ["-e", "process.exitCode=0"], { stdio: "ignore" });
    await new Promise((resolve, reject) => {
        child.once("exit", resolve);
        child.once("error", reject);
    });
    if (invocation.scenario === "cancel") {
        let finish;
        const stopped = new Promise((resolve) => {
            finish = resolve;
        });
        process.on("SIGINT", () => {
            process.exitCode = 130;
            finish();
        });
        const socket = connect(invocation.port, "127.0.0.1", () => socket.write("CLI_READY"));
        await stopped;
        socket.end();
    }
    await context.close();
    await browser.close();
    if (invocation.scenario === "business-failure") process.exitCode = 1;
    if (invocation.scenario === "cli-fault") process.exitCode = 73;
} else {
    const owner = createControlledCommandOwner({ ...invocation.controlled, kind: invocation.kind });
    let cancelled = false,
        disconnecting = false;
    let gateReleased = false;
    const trace = (type) =>
        appendFileSync(join(invocation.work, "gate.jsonl"), JSON.stringify({ type }) + "\n", {
            mode: 0o600,
        });
    process.on("disconnect", () => {
        if (!disconnecting) owner.fail();
    });
    let begin;
    const started = new Promise((resolve) => {
        begin = resolve;
    });
    process.on("message", (message) => {
        if (message?.type === "START") {
            trace("START_RECEIVED");
            begin();
        }
        if (message?.type === "TEST_GATE_STATUS")
            process.send({ type: "TEST_GATE_STATUS", released: gateReleased, cancelled });
        if (message?.type === "CANCEL") {
            owner.requestStop(message.binding);
            cancelled = true;
            trace("CANCEL_INSTALLED");
            if (invocation.scenario !== "missing-ack") {
                process.send({
                    type: "CANCEL_ACK",
                    binding:
                        invocation.scenario === "stale-ack"
                            ? { ...invocation.controlled.commandBinding, ownerGeneration: 999 }
                            : invocation.controlled.commandBinding,
                });
                trace("ACK_SENT");
            }
        }
    });
    if (invocation.scenario !== "no-ready")
        process.send({
            type: "CONTROLLED_READY",
            binding:
                invocation.scenario === "stale-ready"
                    ? { ...invocation.controlled.commandBinding, ownerGeneration: 999 }
                    : invocation.controlled.commandBinding,
            pid: process.pid,
        });
    await started;
    gateReleased = true;
    trace("GATE_RELEASED");
    try {
        for (const role of ["npm", "compiler", ...(invocation.kind === "TEST" ? ["cli"] : [])]) {
            if (cancelled) break;
            const args =
                role === "cli"
                    ? [fileURLToPath(import.meta.url), "cli", process.argv[2]]
                    : ["-e", "process.exitCode=0"];
            const held = owner.start(role, {
                args,
                cwd: invocation.work,
                env: process.env,
                timeoutMs: 15000,
            });
            const result = await held.result;
            await held.exited;
            if (role === "cli") process.exitCode = result.exitCode;
        }
        if (cancelled) process.exitCode = 130;
        if (invocation.scenario !== "missing-seal") owner.seal();
    } catch {
        owner.fail();
        process.exitCode = 73;
    }
    if (invocation.scenario === "outer-signal") process.kill(process.pid, "SIGTERM");
    disconnecting = true;
    process.disconnect();
}
