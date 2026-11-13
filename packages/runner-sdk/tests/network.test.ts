import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import { createServer, type Server, type ServerResponse } from "node:http";
import * as sdk from "../src/index.js";

let onHeld: ((response: ServerResponse) => void) | undefined;
let server: Server, browser: Browser, page: Page, origin: string;
beforeAll(async () => {
    server = createServer(async (req, res) => {
        if (req.url === "/held" && onHeld) {
            res.writeHead(200, { "content-type": "application/json" });
            res.flushHeaders();
            onHeld(res);
            return;
        }
        if (req.url === "/") {
            res.setHeader("content-type", "text/html");
            res.end(
                `<button data-testid="save" onclick="fetch('/save',{method:'POST',body:JSON.stringify({code:'background'})});fetch('/save',{method:'POST',body:JSON.stringify({code:'attempt-1'})})">Save</button>`,
            );
        } else {
            res.setHeader("content-type", "application/json");
            res.end('{"code":0,"id":"saved-1"}');
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browser = await chromium.launch({
        // 测试默认交由已锁定 Playwright 选择匹配浏览器，仅当操作员明确指定路径时覆盖；系统安装的 Chromium 不能成为未记录的正式门禁输入。
        ...(process.env.VERIQ_TEST_CHROMIUM
            ? { executablePath: process.env.VERIQ_TEST_CHROMIUM }
            : {}),
        headless: true,
        args: ["--no-sandbox"],
        env: {
            ...process.env,
            XDG_CACHE_HOME: "/tmp/veriq-t06-cache",
            XDG_CONFIG_HOME: "/tmp/veriq-t06-config",
        },
    });
    page = await browser.newPage();
    await page.goto(origin);
});
afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
});
it("prearms fast responses and correlates the attempt body rather than same-path background traffic", async () => {
    expect(sdk).toHaveProperty("armObserver");
    const registry = new sdk.ObserverRegistry();
    const handle = sdk.armObserver(
        {
            id: "save",
            method: "POST",
            path: "/save",
            bodyMatch: { code: "attempt-1" },
            window: { mode: "UNTIL_ACTION_SETTLED", quietMs: 10 },
        },
        { page, apiBaseURL: origin, allowedOrigins: [origin], registry },
    );
    await page.getByTestId("save").click();
    const saved = await handle.waitFirst();
    expect(saved.request.body).toEqual({ code: "attempt-1" });
    expect(saved.response.body).toEqual({ code: 0, id: "saved-1" });
    expect((await handle.finalize()).matchedCount).toBe(1);
    handle.dispose();
    expect(registry.activeCount()).toBe(0);
});
it.each([
    {
        retryPolicy: "FORBID" as const,
        bodies: [{ code: "x" }, { code: "x" }],
        count: 2,
        error: "AMBIGUOUS_REQUEST",
    },
    {
        retryPolicy: "ALLOW_MATCHING_RETRIES" as const,
        bodies: [{ code: "x" }, { code: "x" }],
        count: 2,
    },
    {
        retryPolicy: "ALLOW_MATCHING_RETRIES" as const,
        bodies: [
            { code: "x", n: 1 },
            { code: "x", n: 2 },
        ],
        count: 2,
        error: "AMBIGUOUS_REQUEST",
    },
    {
        retryPolicy: "ALLOW_MATCHING_RETRIES" as const,
        bodies: [{ code: "x" }],
        count: 2,
        error: "REQUEST_COUNT_MISMATCH",
    },
])(
    "checks the complete fixed window and identical retry policy: $retryPolicy/$error",
    async ({ retryPolicy, bodies, count, error }) => {
        expect(sdk).toHaveProperty("armObserver");
        const registry = new sdk.ObserverRegistry();
        const h = sdk.armObserver(
            {
                id: "save",
                method: "POST",
                path: "/save",
                bodyMatch: { code: "x" },
                retryPolicy,
                expectedCount: count,
                window: { mode: "FIXED", durationMs: 150 },
            },
            { page, apiBaseURL: origin, allowedOrigins: [origin], registry },
        );
        await page.evaluate(async (bodies) => {
            for (const body of bodies)
                await fetch("/save", { method: "POST", body: JSON.stringify(body) });
        }, bodies);
        if (error) await expect(h.finalize()).rejects.toThrow(error);
        else expect((await h.finalize()).matchedCount).toBe(2);
        h.dispose();
        expect(registry.activeCount()).toBe(0);
    },
);
it("disposal settles pending consumers and removes listeners even before the first request", async () => {
    expect(sdk).toHaveProperty("armObserver");
    const registry = new sdk.ObserverRegistry();
    const h = sdk.armObserver(
        { id: "save", method: "GET", path: "/never" },
        { page, apiBaseURL: origin, allowedOrigins: [origin], registry },
    );
    const waiting = h.waitFirst();
    h.dispose();
    await expect(waiting).rejects.toThrow("OBSERVER_DISPOSED");
    expect(registry.activeCount()).toBe(0);
});
it("proves zero matches over a fixed window without requiring a first response", async () => {
    const registry = new sdk.ObserverRegistry();
    const h = sdk.armObserver(
        {
            id: "none",
            method: "GET",
            path: "/never",
            expectedCount: 0,
            window: { mode: "FIXED", durationMs: 100 },
        },
        { page, apiBaseURL: origin, allowedOrigins: [origin], registry },
    );
    const result = await h.finalize();
    expect(result.matchedCount).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(100);
    h.dispose();
    expect(registry.activeCount()).toBe(0);
});
it("detects a late candidate after a first response through the full fixed window", async () => {
    const registry = new sdk.ObserverRegistry();
    const h = sdk.armObserver(
        {
            id: "late",
            method: "POST",
            path: "/save",
            window: { mode: "FIXED", durationMs: 500 },
        },
        { page, apiBaseURL: origin, allowedOrigins: [origin], registry },
    );
    await page.evaluate(() => fetch("/save", { method: "POST", body: "first" }));
    await h.waitFirst();
    const finalized = h.finalize();
    await page.evaluate(() => fetch("/save", { method: "POST", body: "second" }));
    await expect(finalized).rejects.toThrow("AMBIGUOUS_REQUEST");
    h.dispose();
});
it("cancellation rejects pending response consumers and releases listeners", async () => {
    const registry = new sdk.ObserverRegistry(),
        controller = new AbortController();
    const h = sdk.armObserver(
        { id: "cancel", method: "GET", path: "/never" },
        {
            page,
            apiBaseURL: origin,
            allowedOrigins: [origin],
            registry,
            signal: controller.signal,
        },
    );
    const waiting = h.waitFirst();
    controller.abort();
    await expect(waiting).rejects.toThrow("CANCELLED");
    h.dispose();
    expect(registry.activeCount()).toBe(0);
});
it("response duration records completion rather than a later consumer read", async () => {
    const registry = new sdk.ObserverRegistry();
    const h = sdk.armObserver(
        { id: "timed", method: "GET", path: "/timed" },
        { page, apiBaseURL: origin, allowedOrigins: [origin], registry },
    );
    await page.evaluate(() => fetch("/timed"));
    const first = await h.waitFirst();
    await page.evaluate(async () => {
        await fetch("/other");
        await fetch("/other");
    });
    expect((await h.waitFirst()).durationMs).toBe(first.durationMs);
    h.dispose();
});
it("normalizes typed browser query matches without coercing JSON bodies", async () => {
    const registry = new sdk.ObserverRegistry();
    const h = sdk.armObserver(
        {
            id: "typed",
            method: "POST",
            path: "/save",
            queryMatch: { enabled: true, n: 42, tag: [true, 42] },
            bodyMatch: { enabled: true },
            timeoutMs: 500,
            window: { mode: "UNTIL_ACTION_SETTLED", quietMs: 0 },
        },
        { page, apiBaseURL: origin, allowedOrigins: [origin], registry },
    );
    try {
        await page.evaluate(async () => {
            for (const body of [{ enabled: "true" }, { enabled: true }])
                await fetch("/save?enabled=true&n=42&tag=true&tag=42&extra=ignored", {
                    method: "POST",
                    body: JSON.stringify(body),
                });
        });
        const response = await h.waitFirst();
        expect(response.request.body).toEqual({ enabled: true });
        expect((await h.finalize()).matchedCount).toBe(1);
    } finally {
        h.dispose();
    }
});
it("ordinary request-only finalization accepts a candidate while its response body is still pending", async () => {
    const registry = new sdk.ObserverRegistry();
    const h = sdk.armObserver(
        {
            id: "held",
            method: "GET",
            path: "/held",
            timeoutMs: 500,
            window: { mode: "UNTIL_ACTION_SETTLED", quietMs: 0 },
        },
        { page, apiBaseURL: origin, allowedOrigins: [origin], registry },
    );
    let response: ServerResponse | undefined;
    try {
        const received = new Promise<ServerResponse>((resolve) => {
            onHeld = resolve;
        });
        await page.evaluate(() => {
            void fetch("/held").then((r) => r.text());
        });
        response = await received;
        let resolved = false;
        const waiting = h.waitFirst().then((result) => {
            resolved = true;
            return result;
        });
        expect((await h.finalize()).matchedCount).toBe(1);
        expect(resolved).toBe(false);
        response.end('{"code":0}');
        expect((await waiting).response.body).toEqual({ code: 0 });
    } finally {
        response?.end();
        onHeld = undefined;
        h.dispose();
    }
});
it.each(["dispose", "cancel"] as const)(
    "pending first-candidate acquisition responds to %s",
    async (mode) => {
        const registry = new sdk.ObserverRegistry(),
            controller = new AbortController();
        const h = sdk.armObserver(
            {
                id: "pending",
                method: "GET",
                path: "/never",
                window: { mode: "UNTIL_ACTION_SETTLED", quietMs: 0 },
            },
            {
                page,
                apiBaseURL: origin,
                allowedOrigins: [origin],
                registry,
                signal: controller.signal,
            },
        );
        const pending = h.finalize();
        if (mode === "dispose") h.dispose();
        else controller.abort();
        await expect(pending).rejects.toThrow(
            mode === "dispose" ? "OBSERVER_DISPOSED" : "CANCELLED",
        );
        h.dispose();
        expect(registry.activeCount()).toBe(0);
    },
);
it("a request arriving after the acquisition deadline cannot satisfy an ordinary observer", async () => {
    const registry = new sdk.ObserverRegistry();
    const h = sdk.armObserver(
        {
            id: "late-first",
            method: "GET",
            path: "/late-first",
            timeoutMs: 50,
            window: { mode: "UNTIL_ACTION_SETTLED", quietMs: 0 },
        },
        { page, apiBaseURL: origin, allowedOrigins: [origin], registry },
    );
    try {
        await expect(h.finalize()).rejects.toThrow("NETWORK_TIMEOUT");
        await page.evaluate(() => fetch("/late-first"));
        await expect(h.finalize()).rejects.toThrow("NETWORK_TIMEOUT");
    } finally {
        h.dispose();
    }
});
