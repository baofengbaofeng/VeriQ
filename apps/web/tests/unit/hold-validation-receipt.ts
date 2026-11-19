/**
 * 生命周期回归使用真实本机 HTTP 与 Playwright 响应对象，仅路由分派由确定性替身控制；替身显式模拟卸载时自动继续的行为，
 * 证明正文失败后不会重复处理回执，并检查响应、上下文与编译器清理。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { request, type Page, type Route, type APIResponse } from "@playwright/test";
import { withCleanup } from "../support/case-profile-cleanup.js";
import { holdValidationReceipt } from "../support/hold-validation-receipt.js";

/**
 * 上游只发送固定非认证正文，真实响应需要读取和释放；处理计数由替身维护以复现默认卸载的自动继续，独立事件序列记录回调
 * 实际返回与编译器关闭，而不是以请求失败标志猜测生命周期。
 */
async function fixture(
    faults: {
        fulfill?: boolean;
        unroute?: boolean;
        dispose?: boolean;
        fetch?: boolean;
        compiler?: boolean;
    } = {},
) {
    const events: string[] = [];
    const receiptUrl = "/api/v1/workspaces/owned/jobs/j1/validation-receipt";
    const server = createServer((_request, response) => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end('{"receipt":"synthetic-lifecycle-only"}');
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const upstream = await request.newContext({ baseURL: `http://127.0.0.1:${address.port}` });
    const callbackError = new Error("callback failure");
    const unrouteError = new Error("unroute failure");
    const disposeError = new Error("dispose failure");
    const compilerError = new Error("compiler failure");
    let handler!: (route: Route) => Promise<void>;
    let matcher!: (url: URL) => boolean;
    let task: Promise<void> | undefined;
    let handlingCount = 0;
    let disposed = 0;
    let closed = 0;
    const route = {
        request: () => ({ failure: () => null }),
        fetch: async () => {
            if (faults.fetch) throw callbackError;
            const response = await upstream.get(receiptUrl);
            assert.equal(await response.text(), '{"receipt":"synthetic-lifecycle-only"}');
            const dispose = response.dispose.bind(response);
            response.dispose = async () => {
                disposed++;
                await dispose();
                events.push("dispose");
                if (faults.dispose) throw disposeError;
            };
            return response;
        },
        fulfill: async ({ response }: { response: APIResponse }) => {
            events.push("fulfill");
            handlingCount++;
            if (handlingCount > 1) throw new Error("Route is already handled");
            if (faults.fulfill) throw callbackError;
            assert.equal(response.status(), 200);
            events.push("fulfilled");
        },
    } as unknown as Route;
    const page: Pick<Page, "route" | "unroute"> = {
        route: async (match, callback) => {
            assert.equal(typeof match, "function");
            matcher = match as (url: URL) => boolean;
            handler = callback as (route: Route) => Promise<void>;
            return { dispose: async () => {}, [Symbol.asyncDispose]: async () => {} };
        },
        unroute: async (match, callback) => {
            assert.equal(match, matcher);
            assert.equal(callback, handler);
            events.push("unroute");
            if (task && !events.includes("callback settled")) {
                handlingCount++;
                events.push("auto-continue");
            }
            if (faults.unroute) throw unrouteError;
        },
    };
    return {
        page,
        matches: (url: URL) => url.pathname === receiptUrl,
        start: () => {
            assert.equal(matcher(new URL(`http://127.0.0.1${receiptUrl}`)), true);
            assert.equal(matcher(new URL("http://127.0.0.1/unrelated")), false);
            task = handler(route).finally(() => events.push("callback settled"));
            return task;
        },
        cancel: () => {
            route.request = () =>
                ({ failure: () => ({ errorText: "net::ERR_ABORTED" }) }) as ReturnType<Route["request"]>;
        },
        compiler: {
            close: async () => {
                closed++;
                events.push("compiler close");
                if (faults.compiler) throw compilerError;
            },
        },
        counts: () => ({ handlingCount, disposed, closed }),
        events,
        callbackError,
        unrouteError,
        disposeError,
        compilerError,
        close: async () => {
            await withCleanup(
                async () => {
                    await upstream.dispose();
                    events.push("context close");
                },
                () =>
                    new Promise<void>((resolve, reject) =>
                        server.close((error) => (error ? reject(error) : resolve())),
                    ),
            );
        },
    };
}

/**
 * 正文在真实回执被持有后故意抛出，清理必须等回调完成再精确卸载，并独立关闭编译器；此断言直接捕获旧实现的自动继续与重复
 * fulfill，不能因为请求 failure 为空就认定路由仍未被处理。
 */
test("held receipt body failure settles callback before unroute and closes compiler", async () => {
    const owned = await fixture();
    const barrier = await holdValidationReceipt(owned.page, owned.matches);
    const bodyError = new Error("body failure after held response");
    const callback = owned.start();
    try {
        await assert.rejects(
            withCleanup(
                async () => {
                    await barrier.holding();
                    throw bodyError;
                },
                () =>
                    withCleanup(
                        () => barrier.close(),
                        () => owned.compiler.close(),
                    ),
            ),
            (error: unknown) => error === bodyError,
        );
        await callback;
        assert.deepEqual(owned.events, [
            "fulfill",
            "fulfilled",
            "dispose",
            "callback settled",
            "unroute",
            "compiler close",
        ]);
        assert.deepEqual(owned.counts(), { handlingCount: 1, disposed: 1, closed: 1 });
    } finally {
        barrier.release();
        await withCleanup(
            () => callback,
            () => owned.close(),
        );
    }
    assert.equal(owned.events.at(-1), "context close");
});

/**
 * 正文和路由回调同时失败时，两者原始对象及先后次序必须保留；回调异常不能阻止精确卸载与编译器关闭，也不能逃出分派回调
 * 成为额外未处理拒绝，或让等待已交付信号的测试永久挂起。
 */
test("held body and callback failures preserve both originals while cleanup completes", async () => {
    const owned = await fixture({ fulfill: true });
    const barrier = await holdValidationReceipt(owned.page, owned.matches);
    const bodyError = new Error("body failure after held response");
    const callback = owned.start();
    try {
        await assert.rejects(
            withCleanup(
                async () => {
                    await barrier.holding();
                    throw bodyError;
                },
                () =>
                    withCleanup(
                        () => barrier.close(),
                        () => owned.compiler.close(),
                    ),
            ),
            (error: unknown) => {
                assert.ok(error instanceof AggregateError);
                assert.deepEqual(error.errors, [bodyError, owned.callbackError]);
                assert.equal(error.cause, bodyError);
                return true;
            },
        );
        await callback;
        assert.deepEqual(owned.events, ["fulfill", "dispose", "callback settled", "unroute", "compiler close"]);
        assert.deepEqual(owned.counts(), { handlingCount: 1, disposed: 1, closed: 1 });
    } finally {
        barrier.release();
        await withCleanup(
            () => callback,
            () => owned.close(),
        );
    }
});

/**
 * 正常交付、实际取消信号、获取失败及交付失败共用等待接口，失败只抛出一次而清理仍会执行；取消只回收真实响应，不调用人为
 * abort，也不把取消状态伪装成已经成功交付给页面。
 */
for (const scenario of ["success", "cancel", "fetch", "fulfill", "dispose"] as const) {
    test(`receipt ${scenario} settles delivery and releases owned resources`, async () => {
        const owned = await fixture({
            fetch: scenario === "fetch",
            fulfill: scenario === "fulfill",
            dispose: scenario === "dispose",
        });
        const barrier = await holdValidationReceipt(owned.page, owned.matches);
        const callback = owned.start();
        try {
            await withCleanup(
                async () => {
                    if (scenario === "fetch") {
                        await assert.rejects(barrier.holding(), (error: unknown) => error === owned.callbackError);
                    } else {
                        await barrier.holding();
                        if (scenario === "cancel") owned.cancel();
                    }
                    barrier.release();
                    if (scenario === "fulfill" || scenario === "dispose") {
                        const original = scenario === "fulfill" ? owned.callbackError : owned.disposeError;
                        await assert.rejects(barrier.delivered(), (error: unknown) => error === original);
                    } else await barrier.delivered();
                },
                () =>
                    withCleanup(
                        () => barrier.close(),
                        () => owned.compiler.close(),
                    ),
            );
            await callback;
            assert.ok(owned.events.indexOf("callback settled") < owned.events.indexOf("unroute"));
            assert.equal(owned.events.includes("auto-continue"), false);
            assert.deepEqual(owned.counts(), {
                handlingCount: scenario === "cancel" || scenario === "fetch" ? 0 : 1,
                disposed: scenario === "fetch" ? 0 : 1,
                closed: 1,
            });
        } finally {
            barrier.release();
            await withCleanup(
                () => callback,
                () => owned.close(),
            );
        }
    });
}

/**
 * 屏障卸载、响应释放与编译器停止也可能各自失败，嵌套结算须保留所有叶子错误的原始身份及发生顺序；正文主因仍在最外层，
 * 任一较早错误均不能使较晚资源清理失去执行机会。
 */
test("body callback disposal unroute and compiler errors retain order and original objects", async () => {
    const owned = await fixture({ fulfill: true, dispose: true, unroute: true, compiler: true });
    const barrier = await holdValidationReceipt(owned.page, owned.matches);
    const bodyError = new Error("body failure after held response");
    const callback = owned.start();
    try {
        await assert.rejects(
            withCleanup(
                async () => {
                    await barrier.holding();
                    throw bodyError;
                },
                () =>
                    withCleanup(
                        () => barrier.close(),
                        () => owned.compiler.close(),
                    ),
            ),
            (error: unknown) => {
                assert.ok(error instanceof AggregateError);
                assert.equal(error.cause, bodyError);
                const errors = (value: unknown): unknown[] =>
                    value instanceof AggregateError ? value.errors.flatMap(errors) : [value];
                assert.deepEqual(errors(error), [
                    bodyError,
                    owned.callbackError,
                    owned.disposeError,
                    owned.unrouteError,
                    owned.compilerError,
                ]);
                return true;
            },
        );
        await callback;
        assert.deepEqual(owned.events, ["fulfill", "dispose", "callback settled", "unroute", "compiler close"]);
        assert.deepEqual(owned.counts(), { handlingCount: 1, disposed: 1, closed: 1 });
    } finally {
        barrier.release();
        await withCleanup(
            () => callback,
            () => owned.close(),
        );
    }
});

test("barrier closes without a captured request and still closes compiler", async () => {
    const owned = await fixture();
    const barrier = await holdValidationReceipt(owned.page, owned.matches);
    try {
        await withCleanup(
            () => barrier.close(),
            () => owned.compiler.close(),
        );
        assert.deepEqual(owned.counts(), { handlingCount: 0, disposed: 0, closed: 1 });
    } finally {
        await owned.close();
    }
});
