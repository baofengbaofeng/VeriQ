/** 这些测试只用显式受控 Promise 验证文件模式观察期限、未知修改结果与未完成操作隔离，不构造虚假持久挂载或替代 OS 正向验收；挂起与失败均是本用例注入的契约故障，真实私有文件行为仍由独立 Linux 目标验证。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { observeRestrictedOperation } from "../src/credentials/restricted-operation.ts";

function deferred() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { promise, release };
}

test("post-mutation operation and cleanup errors remain unconfirmed while preflight failures remain failed", async () => {
    const signal = new AbortController().signal;
    assert.deepEqual(
        await observeRestrictedOperation("owned-close", signal, async (_signal, mark) => {
            mark();
            try {
                return { status: "ok" };
            } finally {
                throw new Error("INJECTED_CLOSE_AFTER_COMMIT");
            }
        }),
        { status: "mutation-unconfirmed" },
    );
    assert.deepEqual(
        await observeRestrictedOperation("owned-release", signal, async (_signal, mark) => {
            mark();
            throw new Error("INJECTED_RELEASE_AFTER_COMMIT");
        }),
        { status: "mutation-unconfirmed" },
    );
    assert.deepEqual(
        await observeRestrictedOperation("owned-preflight", signal, async () => {
            throw new Error("INJECTED_PREFLIGHT_ERROR");
        }),
        { status: "failed" },
    );
});

test("aborted mutation retains its shared fence until the real cleanup promise settles", async () => {
    const held = deferred(),
        entered = deferred(),
        controller = new AbortController();
    const operation = observeRestrictedOperation(
        "owned-pending-write",
        controller.signal,
        async (_signal, mark) => {
            mark();
            entered.release();
            await held.promise;
            return { status: "ok" };
        },
    );
    await entered.promise;
    controller.abort();
    assert.deepEqual(await operation, { status: "mutation-unconfirmed" });
    let reopened = false;
    assert.deepEqual(
        await observeRestrictedOperation(
            "owned-pending-write",
            new AbortController().signal,
            async () => {
                reopened = true;
                return { status: "ready" };
            },
        ),
        { status: "failed" },
    );
    assert.equal(reopened, false);
    held.release();
    await nextTurn();
    assert.deepEqual(
        await observeRestrictedOperation(
            "owned-pending-write",
            new AbortController().signal,
            async () => ({ status: "ready" }),
        ),
        { status: "ready" },
    );
});

test("late read material is erased and a cancelled preflight cannot start a new mutation", async () => {
    const held = deferred(),
        controller = new AbortController(),
        material = Buffer.alloc(32, 71);
    const operation = observeRestrictedOperation("owned-late-read", controller.signal, async () => {
        await held.promise;
        return { status: "ok", key: material };
    });
    controller.abort();
    assert.deepEqual(await operation, { status: "failed" });
    held.release();
    await nextTurn();
    assert.equal(
        material.every((byte) => byte === 0),
        true,
    );
    const later = deferred(),
        cancellation = new AbortController();
    let rejected = false,
        modified = false;
    const pending = observeRestrictedOperation(
        "owned-cancelled-preflight",
        cancellation.signal,
        async (_signal, mark) => {
            await later.promise;
            try {
                mark();
                modified = true;
            } catch {
                rejected = true;
            }
            return { status: "failed" };
        },
    );
    cancellation.abort();
    assert.deepEqual(await pending, { status: "failed" });
    later.release();
    await nextTurn();
    assert.equal(rejected, true);
    assert.equal(modified, false);
});

/** 独立五秒期限必须在调用者从未取消时仍结束观察，模拟未完成 I/O 的引用保持事件循环存活；观察返回后测试才释放实际工作 Promise，因此通过不代表取消了内核请求，也不允许隔离在真实完成之前提前消失。 */
test(
    "restricted operation has its own five-second observation deadline",
    { timeout: 7000 },
    async () => {
        const held = deferred(),
            keepAlive = setInterval(() => {}, 1000);
        try {
            const result = await observeRestrictedOperation(
                "owned-deadline",
                new AbortController().signal,
                async () => {
                    await held.promise;
                    return { status: "ready" };
                },
            );
            assert.deepEqual(result, { status: "failed" });
            assert.deepEqual(
                await observeRestrictedOperation(
                    "owned-deadline",
                    new AbortController().signal,
                    async () => ({ status: "ready" }),
                ),
                { status: "failed" },
            );
        } finally {
            held.release();
            clearInterval(keepAlive);
            await nextTurn();
        }
    },
);
