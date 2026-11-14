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
        requestId = "22222222-2222-4222-8222-222222222222";
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
            join(directory, "attempts/old.json"),
            JSON.stringify({
                state: "ALLOCATED",
                work: directory,
                claim: { attemptId: "33333333-3333-4333-8333-333333333333", fencingToken: 1 },
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
        requestId = "22222222-2222-4222-8222-222222222222";
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
            join(directory, "attempts/old.json"),
            JSON.stringify({
                claimRequestId: requestId,
                state: "ALLOCATED",
                work: directory,
                claim: { attemptId: "33333333-3333-4333-8333-333333333333", fencingToken: 1 },
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
        /** 缺守护程序的安装夹具仍保留完整真实源码布局与外部依赖解析，避免单独复制入口后先因其间接模块缺失而失败；仅不提供 build 下的原生 launcher，断言必须实际到达业务派生前的正式能力检查。 */
        await cp(new URL("../src", import.meta.url), join(root, "src"), { recursive: true });
        await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(root, "node_modules"), "dir");
        await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
        const { ProcessSupervisor } = await import(
            pathToFileURL(join(root, "src/execution/processes.ts")).href
        );
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
