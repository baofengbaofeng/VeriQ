import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { openTrace } from "../src/trace.ts";

/** 原生入口使用官方 Trace 服务器但不启动默认浏览器，测试先由匹配的真实 Chromium 生成可读取 Trace，再检查私有副本目录之外的读取被拒绝、关闭停止监听且原始证据字节不变。 */
test(
    "native trace callback owns its file root and closes without launching an OS viewer",
    { timeout: 30000 },
    async () => {
        const root = await mkdtemp("/tmp/veriq-native-trace-test-");
        const path = join(root, "original.zip"),
            controller = new AbortController();
        const browser = await chromium.launch({
            executablePath: resolve(
                "../../.superpowers/cache/playwright/chromium_headless_shell-1254/chrome-headless-shell-linux64/chrome-headless-shell",
            ),
            headless: true,
        });
        let opened: Promise<void> | undefined;
        try {
            const context = await browser.newContext();
            await context.tracing.start({ snapshots: true });
            const page = await context.newPage();
            await page.setContent("<h1>Native Trace proof</h1>");
            await context.tracing.stop({ path });
            await context.close();
            const original = await readFile(path);
            let ready!: (url: string) => void;
            const address = new Promise<string>((resolve) => {
                ready = resolve;
            });
            opened = openTrace(path, controller.signal, (url) => ready(url));
            const origin = await Promise.race([
                address,
                opened.then(() => {
                    throw new Error("Trace stopped before ready");
                }),
            ]);
            const response = await fetch(origin);
            assert.equal(response.status, 200);
            const actual = new URL(response.url);
            assert.match(actual.pathname, /^\/[0-9a-f]{32}\/trace\/index.html$/);
            const trace = new URL(actual.searchParams.get("trace")!, actual);
            const served = await fetch(trace);
            assert.equal(served.status, 200);
            assert.deepEqual(Buffer.from(await served.arrayBuffer()), original);
            const rootResponse = await fetch(actual.origin);
            assert.equal(rootResponse.status, 404);
            assert.equal((await rootResponse.text()).includes("trace.zip"), false);
            assert.equal((await fetch(actual.origin + "/invalid/trace/index.html")).status, 404);
            const outside = new URL("file?path=" + encodeURIComponent("/etc/passwd"), actual);
            assert.equal((await fetch(outside)).status, 403);
            controller.abort();
            await opened;
            await assert.rejects(fetch(origin));
            assert.deepEqual(await readFile(path), original);
        } finally {
            controller.abort();
            await opened;
            await browser.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);
