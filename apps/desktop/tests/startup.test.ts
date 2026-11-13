import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { DesktopAgent } from "../src/agent/service.ts";

const uuid = "11111111-1111-4111-8111-111111111111";
const run = { operation: "run", bundleId: uuid, headed: false, retry: false };

/** 启动阶段复用真实 DesktopAgent 与私有文件状态，只把第一次目录读取延迟到测试明确释放；目录内容仍由原方法取得，不伪造签名包、业务结果或浏览器回执，以确定覆盖首个 await 期间的竞争。 */
async function pendingStart() {
    const root = await mkdtemp("/tmp/veriq-startup-");
    const agent = new DesktopAgent(root, {
        origin: "http://127.0.0.1:8888",
        engineDirectory: "/missing/engine",
        browserExecutable: "/missing/browser",
    });
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const started = new Promise<void>((resolve) => {
        entered = resolve;
    });
    const original = Reflect.get(agent, "catalog");
    assert.equal(typeof original, "function");
    let delayed = false;
    Reflect.set(agent, "catalog", async () => {
        if (!delayed) {
            delayed = true;
            entered();
            await gate;
        }
        return original.call(agent);
    });
    const first = agent.dispatch(run).then(
        (value) => ({ value }),
        (error) => ({ error }),
    );
    await started;
    return {
        root,
        agent,
        first,
        release,
        dispose: async () => {
            release();
            await first;
            await rm(root, { recursive: true, force: true });
        },
    };
}

/** 两个启动请求以及工作区、在线模式切换不能同时占有尚未完成的启动事务，读取状态却应继续返回；第一个真实目录读取失败之后，预留必须释放，后续请求不得永远停留在 BUSY。 */
test("pending startup rejects competing mutations and releases after failure", async () => {
    const fixture = await pendingStart();
    try {
        for (const command of [
            run,
            { operation: "select", workspaceId: uuid },
            { operation: "onlineStart" },
        ])
            await assert.rejects(fixture.agent.dispatch(command), /AGENT_BUSY/);
        const status = (await fixture.agent.dispatch({ operation: "status" })) as {
            preparing?: { id: string; operation: string };
        };
        assert.equal(status.preparing?.operation, "run");
        fixture.release();
        assert.match(
            String(((await fixture.first) as { error: Error }).error),
            /BUNDLE_WORKSPACE_MISMATCH/,
        );
        await assert.rejects(fixture.agent.dispatch(run), /BUNDLE_WORKSPACE_MISMATCH/);
    } finally {
        await fixture.dispose();
    }
});

/** 取消引用状态中那一次启动的独立标识，陈旧标识必须拒绝而不能伤及当前启动；取消成功仅说明该启动已收敛，不能伪造 Run 或进程停止回执，之后允许用户重新发起新的操作。 */
test("startup cancellation targets its operation and waits for release", async () => {
    const fixture = await pendingStart();
    try {
        const status = (await fixture.agent.dispatch({ operation: "status" })) as {
            preparing: { id: string };
        };
        await assert.rejects(
            fixture.agent.dispatch({ operation: "cancel", startupId: uuid }),
            /STARTUP_NOT_FOUND/,
        );
        let finished = false;
        const cancelled = fixture.agent
            .dispatch({ operation: "cancel", startupId: status.preparing.id })
            .then((value) => {
                finished = true;
                return value;
            });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(finished, false);
        await assert.rejects(fixture.agent.dispatch(run), /AGENT_BUSY/);
        fixture.release();
        await cancelled;
        assert.match(
            String(((await fixture.first) as { error: Error }).error),
            /AGENT_START_CANCELLED/,
        );
        await assert.rejects(fixture.agent.dispatch(run), /BUNDLE_WORKSPACE_MISMATCH/);
        const { LocalStore } = await import("../../runtime/src/offline/store.ts");
        const { DatabaseSync } = await import("node:sqlite");
        const current = "22222222-2222-4222-8222-222222222222";
        const store = await LocalStore.open(fixture.root + "/offline");
        store.reserve(uuid, current, "33333333-3333-4333-8333-333333333333");
        store.close();
        const db = new DatabaseSync(fixture.root + "/offline/veriq.sqlite");
        db.prepare(
            "INSERT INTO veriq_local_runs(id,workspace_id,created_at,state) VALUES(?,?,?,?)",
        ).run(uuid, uuid, new Date().toISOString(), "FINISHED");
        db.close();
        const controller = new AbortController();
        Reflect.set(fixture.agent, "selectedWorkspace", uuid);
        Reflect.set(fixture.agent, "runController", controller);
        await assert.rejects(
            fixture.agent.dispatch({ operation: "cancel", runId: uuid }),
            /RUN_NOT_ACTIVE/,
        );
        assert.equal(controller.signal.aborted, false);
        await fixture.agent.dispatch({ operation: "cancel", runId: current });
        assert.equal(controller.signal.aborted, true);
    } finally {
        await fixture.dispose();
    }
});

/** 停止后台先撤销已经预留的启动并等待它退出，不允许在等待间隙接受新启动；实例关闭后继续收到的旧 IPC 也应失败，以覆盖 broker 发完停止回执到实际关闭 socket 之间的小窗口。 */
test("stop drains the reserved startup and prevents later work", async () => {
    const fixture = await pendingStart();
    try {
        const stopped = fixture.agent.dispatch({ operation: "stop" });
        await new Promise<void>((resolve) => setImmediate(resolve));
        await assert.rejects(fixture.agent.dispatch(run), /AGENT_BUSY|AGENT_STOPPED/);
        fixture.release();
        assert.deepEqual(await stopped, { stopped: true });
        assert.match(
            String(((await fixture.first) as { error: Error }).error),
            /AGENT_START_CANCELLED/,
        );
        await assert.rejects(fixture.agent.dispatch(run), /AGENT_STOPPED/);
    } finally {
        await fixture.dispose();
    }
});
