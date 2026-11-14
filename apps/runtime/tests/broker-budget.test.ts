import assert from "node:assert/strict";
import test from "node:test";
import { connect } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { AttemptBroker } from "../src/execution/broker.ts";

/** 使用真正的私有 Unix socket 观察后台控制命令回执，测试只缩短可配置的连接预算而不调整业务执行时限；服务器故意等待可控闸门，以区分已断开的客户端和仍在执行的命令。 */
async function observe(timeout: number | undefined, delayed: boolean) {
    const root = await mkdtemp("/tmp/veriq-broker-budget-");
    let finish!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
        entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
        finish = resolve;
    });
    let executed = false;
    const broker = new AttemptBroker(
        join(root, "broker.sock"),
        async () => {
            entered();
            if (delayed) await gate;
            executed = true;
            return { executed };
        },
        timeout,
    );
    await broker.open();
    try {
        const result = new Promise<string>((resolve) => {
            const socket = connect(broker.path);
            let data = "";
            socket.on("connect", () =>
                socket.write(JSON.stringify({ nonce: broker.nonce }) + "\n"),
            );
            socket.on("data", (chunk) => {
                data += chunk;
            });
            socket.on("close", () => resolve(data));
        });
        await started;
        if (delayed && timeout !== 20) setTimeout(finish, 100);
        const received = await result;
        const beforeRelease = executed;
        finish();
        await gate;
        return { received, beforeRelease, afterRelease: executed };
    } finally {
        finish();
        await broker.close();
        await rm(root, { recursive: true, force: true });
    }
}

/** 旧调用方不传第三参数时仍能收到原有封套，显式较长预算同样不会改变命令的认证或响应结构；只有短预算连接在命令闸门释放前关闭，连接关闭本身不表示命令被取消。 */
test("broker budget preserves existing calls and distinguishes timeout from cancellation", async () => {
    assert.equal(JSON.parse((await observe(undefined, false)).received).value.executed, true);
    assert.equal(JSON.parse((await observe(1000, true)).received).value.executed, true);
    const start = performance.now();
    const timed = await observe(20, true);
    assert.ok(
        performance.now() - start < 1000,
        "Explicit short socket budget must override the legacy 15-second default",
    );
    assert.equal(timed.received, "");
    assert.equal(timed.beforeRelease, false);
    assert.equal(timed.afterRelease, true);
    assert.throws(() => new AttemptBroker("unused", async () => null, 0), /IPC_TIMEOUT_INVALID/);
});
