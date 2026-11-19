import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ExecutionSupervisor } from "../src/execution/supervisor.ts";
test("an exhausted granted lease cannot start an execution process even if the wall clock is skewed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "veriq-t10-expired-"));
    try {
        const supervisor = new ExecutionSupervisor({ root: directory } as ConstructorParameters<
            typeof ExecutionSupervisor
        >[0]);
        await assert.rejects(
            supervisor.runAttempt(
                {
                    claim: {
                        attemptId: "11111111-1111-4111-8111-111111111111",
                        expiresAt: "2026-01-01T00:01:00Z",
                        serverTime: "2026-01-01T00:00:00Z",
                        leaseDurationMs: 60000,
                    },
                    requestStarted: 0,
                    responseReceived: 60000,
                } as Parameters<ExecutionSupervisor["runAttempt"]>[0],
                new AbortController().signal,
            ),
            /LEASE_BUDGET_EXHAUSTED/,
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("historical reconciliation preserves the exact newer lost claim request", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { claimLoop } = await import("../src/agent/claim-loop.ts");
    const directory = await mkdtemp(join(tmpdir(), "veriq-t10-claim-recovery-"));
    const runnerId = "11111111-1111-4111-8111-111111111111",
        requestId = "22222222-2222-4222-8222-222222222222",
        attemptId = "33333333-3333-4333-8333-333333333333";
    const capabilities = {
        engineVersion: "0.1.0",
        os: "linux",
        arch: "x64",
        browsers: ["chromium"],
    };
    const claimed: string[] = [];
    const client = {
        request: async (path: string, _method: string, data: Record<string, unknown>) => {
            if (path.endsWith("/reconcile")) return {};
            assert.equal(path, "/internal/v1/jobs/claim");
            claimed.push(String(data.clientRequestId));
            return undefined;
        },
    } as unknown as import("../src/agent/transport.ts").AgentClient;
    try {
        await mkdir(join(directory, "attempts"), { mode: 0o700 });
        await writeFile(
            join(directory, "attempts", attemptId + ".json"),
            JSON.stringify({
                state: "ALLOCATED",
                work: directory,
                claim: { attemptId, fencingToken: 1 },
            }),
            { mode: 0o600 },
        );
        await writeFile(
            join(directory, "claim-request.json"),
            JSON.stringify({
                runnerId,
                clientRequestId: requestId,
                capabilities,
                availableSlots: 1,
            }),
        );
        const supervisor = new ExecutionSupervisor({
            root: directory,
            client,
            minimumFreeBytes: 1,
        } as ConstructorParameters<typeof ExecutionSupervisor>[0]);
        await claimLoop({
            root: directory,
            client,
            supervisor,
            runnerId,
            capabilities: capabilities as never,
            signal: new AbortController().signal,
            once: true,
        });
        assert.deepEqual(claimed, [requestId]);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("only the correlated acknowledged recovery clears its own pending claim request", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { claimLoop } = await import("../src/agent/claim-loop.ts");
    const directory = await mkdtemp(join(tmpdir(), "veriq-t10-claim-recovery-"));
    const runnerId = "11111111-1111-4111-8111-111111111111",
        requestId = "22222222-2222-4222-8222-222222222222",
        attemptId = "33333333-3333-4333-8333-333333333333";
    const capabilities = {
        engineVersion: "0.1.0",
        os: "linux",
        arch: "x64",
        browsers: ["chromium"],
    };
    const claimed: string[] = [];
    const client = {
        request: async (path: string, _method: string, data: Record<string, unknown>) => {
            if (path.endsWith("/reconcile")) return {};
            assert.equal(path, "/internal/v1/jobs/claim");
            claimed.push(String(data.clientRequestId));
            return undefined;
        },
    } as unknown as import("../src/agent/transport.ts").AgentClient;
    try {
        await mkdir(join(directory, "attempts"), { mode: 0o700 });
        await writeFile(
            join(directory, "attempts", attemptId + ".json"),
            JSON.stringify({
                claimRequestId: requestId,
                state: "ALLOCATED",
                work: directory,
                claim: { attemptId, fencingToken: 1 },
            }),
            { mode: 0o600 },
        );
        await writeFile(
            join(directory, "claim-request.json"),
            JSON.stringify({
                runnerId,
                clientRequestId: requestId,
                capabilities,
                availableSlots: 1,
            }),
        );
        const supervisor = new ExecutionSupervisor({
            root: directory,
            client,
            minimumFreeBytes: 1,
        } as ConstructorParameters<typeof ExecutionSupervisor>[0]);
        await claimLoop({
            root: directory,
            client,
            supervisor,
            runnerId,
            capabilities: capabilities as never,
            signal: new AbortController().signal,
            once: true,
        });
        assert.equal(claimed.length, 1);
        assert.notEqual(claimed[0], requestId);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("an installation missing its native launcher fails closed without compiling or spawning", async () => {
    const { cp, symlink, writeFile, readdir } = await import("node:fs/promises");
    const { pathToFileURL, fileURLToPath } = await import("node:url");
    const root = await mkdtemp(join(tmpdir(), "veriq-t10-no-launcher-"));
    try {
        /**
         * 缺守护程序的安装夹具仍保留完整真实源码布局与外部依赖解析，避免单独复制入口后先因其间接模块缺失而失败；仅不提
         * 供 build 下的原生 launcher，断言必须实际到达业务派生前的正式能力检查。
         */
        await cp(new URL("../src", import.meta.url), join(root, "src"), { recursive: true });
        await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(root, "node_modules"), "dir");
        await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
        const { ProcessSupervisor } = await import(pathToFileURL(join(root, "src/execution/processes.ts")).href);
        const supervisor = new ProcessSupervisor(join(root, "journal"));
        await assert.rejects(
            supervisor.start("missing", {
                executable: process.execPath,
                args: ["-e", "process.exit(0)"],
                cwd: root,
            }),
            /NATIVE_LAUNCHER_REQUIRED/,
        );
        assert.deepEqual(supervisor.active(), []);
        assert.deepEqual(await readdir(root), ["node_modules", "package.json", "src"]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

/**
 * 真实本机套接字保留旧运行标志和进程号，并接收有限暂停及处置状态；通过同一带随机 nonce 的连接仍可发起停止。
 */
test("nonce status carries maintenance fields without changing the stop operation", async (t) => {
    const { agentControl, serveAgentControl } = await import("../src/agent/control.ts");
    const directory = await mkdtemp(join(tmpdir(), "vq-ctl-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const stop = new AbortController();
    let state: ReturnType<NonNullable<Parameters<typeof serveAgentControl>[2]>> = {};
    const close = await serveAgentControl(
        directory,
        () => stop.abort(),
        () => state,
    );
    try {
        const legacy = { running: true, pid: process.pid };
        assert.deepEqual(await agentControl(directory, "status"), legacy);
        state = { pausedReason: "RUNTIME_STORAGE_LOW", scratchCleanupPending: true };
        assert.deepEqual(await agentControl(directory, "status"), { ...legacy, ...state });
        await agentControl(directory, "stop");
        assert.equal(stop.signal.aborted, true);
    } finally {
        await close();
    }
});

test("nonce client accepts legacy status and rejects invalid optional fields", async (t) => {
    const { writeFile } = await import("node:fs/promises");
    const { agentControl } = await import("../src/agent/control.ts");
    const { AttemptBroker } = await import("../src/execution/broker.ts");
    const directory = await mkdtemp(join(tmpdir(), "vq-ctl-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const legacy = { running: true, pid: process.pid };
    let state: unknown = legacy;
    const broker = new AttemptBroker(join(directory, "test.sock"), async () => state);
    await broker.open();
    try {
        await writeFile(
            join(directory, "agent-control.json"),
            JSON.stringify({ socket: broker.path, nonce: broker.nonce }),
        );
        assert.deepEqual(await agentControl(directory, "status"), legacy);
        for (const value of [
            { ...legacy, pausedReason: "/private/path" },
            { ...legacy, scratchCleanupPending: "true" },
            { ...legacy, running: "yes" },
            { ...legacy, pid: -1 },
        ]) {
            state = value;
            await assert.rejects(agentControl(directory, "status"), { message: "INVALID_AGENT_RESPONSE" });
        }
        state = { ...legacy, rawError: "/private/path" };
        assert.deepEqual(await agentControl(directory, "status"), legacy);
        await writeFile(join(directory, "agent-control.json"), JSON.stringify({ socket: broker.path, nonce: "wrong" }));
        await assert.rejects(agentControl(directory, "status"), { message: "AGENT_UNAVAILABLE" });
    } finally {
        await broker.close();
    }
});

test("CLI status prints fixed English disk and scratch guidance through the nonce channel", async (t) => {
    const { spawn } = await import("node:child_process");
    const { serveAgentControl } = await import("../src/agent/control.ts");
    const profile = await mkdtemp(join(tmpdir(), "vq-ctl-"));
    t.after(() => rm(profile, { recursive: true, force: true }));
    const close = await serveAgentControl(
        join(profile, "agent"),
        () => {},
        () => ({ pausedReason: "RUNTIME_STORAGE_LOW", scratchCleanupPending: true }),
    );
    try {
        const args = ["--import", "tsx", "src/cli.ts", "--config-dir", profile, "runtime", "status"];
        const cli = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        let errors = "";
        cli.stdout.on("data", (chunk: Buffer) => {
            output += chunk.toString();
        });
        cli.stderr.on("data", (chunk: Buffer) => {
            errors += chunk.toString();
        });
        const code = await new Promise<number | null>((resolve, reject) => {
            cli.once("error", reject);
            cli.once("close", resolve);
        });
        assert.equal(code, 0, errors);
        assert.match(output, /Agent running: true; PID [1-9][0-9]*/);
        assert.match(output, /Insufficient disk space; claiming is paused/);
        assert.match(output, /Scratch was retained; ask an administrator/);
        assert.equal(output.includes(profile), false);
    } finally {
        await close();
    }
});
