/**
 * 使用原生 Promise 与监听器验证观测全过程，显式检查返回身份、原接收者及异常保持一致。
 * 注入浏览器协议之外的字段并制造容量溢出，确保失败报告只包含本轮允许输出的固定枚举。
 */
import { EventEmitter } from "node:events";
import { Buffer } from "node:buffer";
import type { BrowserContext } from "@playwright/test";
import { expect, test } from "vitest";
import { createSsoObservation } from "./sso-observation.js";

const privateText = "unreportable-observation-input";

class ProtocolSession extends EventEmitter {
    calls: { receiver: ProtocolSession; args: unknown[] }[] = [];
    next: Promise<unknown> = Promise.resolve();
    send(...args: unknown[]) {
        this.calls.push({ receiver: this, args });
        return this.next;
    }
}

function fixture() {
    const session = new ProtocolSession();
    const pending = Promise.resolve(session);
    const seen: unknown[] = [];
    class Context {
        newCDPSession(...args: unknown[]) {
            seen.push(this, ...args);
            return pending;
        }
    }
    const context = new Context();
    const trace = createSsoObservation("https://app.test", "https://idp.test");
    trace.attach(context as unknown as BrowserContext);
    return { trace, context, seen, session, pending };
}

test("forwards the same receiver, arguments, Promise and rejection and restores protocol listeners", async () => {
    const { trace, context, seen, session, pending } = fixture();
    const page = {};
    expect(context.newCDPSession(page)).toBe(pending);
    await pending;
    expect(seen).toEqual([context, page]);
    expect(seen[1]).toBe(page);
    const params = { requestId: privateText };
    const failure = Object.assign(new Error(privateText), { name: privateText });
    const rejected = Promise.reject(failure);
    session.next = rejected;
    expect(session.send("Fetch.continueRequest", params)).toBe(rejected);
    await expect(rejected).rejects.toBe(failure);
    expect(session.calls).toHaveLength(1);
    expect(session.calls[0]?.receiver).toBe(session);
    expect(session.calls[0]?.args[1]).toBe(params);
    // 观测读取异常结果时故意让属性抛错，调用者仍应完整获得同一个对象且没有额外协议请求。
    const bad = Object.defineProperty({}, "frameTree", {
        get() {
            throw new Error(privateText);
        },
    });
    session.next = Promise.resolve(bad);
    await expect(session.send("Page.getFrameTree")).resolves.toBe(bad);
    trace.dispose();
    expect(Object.hasOwn(context, "newCDPSession")).toBe(false);
    expect(Object.hasOwn(session, "send")).toBe(false);
    expect(session.listenerCount("Fetch.requestPaused")).toBe(0);
    expect(session.listenerCount("Page.frameNavigated")).toBe(0);
    const output = trace.report();
    expect(output).not.toContain(privateText);
    const report = JSON.parse(output);
    expect(report.observationErrors).toBe(1);
    expect(report.events).toContainEqual(
        expect.objectContaining({ event: "commandError", category: "OTHER", request: 1 }),
    );
});

test("bounds request IDs and records the first denial and stream byte counts", async () => {
    const { trace, context, session } = fixture();
    await context.newCDPSession({});
    const tooLong = "x".repeat(257);
    session.next = Promise.resolve({ frameTree: { frame: { id: tooLong } } });
    await session.send("Page.getFrameTree");
    session.emit("Page.frameNavigated", { frame: { id: tooLong } });
    expect(JSON.parse(trace.report()).events.at(-1)).toMatchObject({ main: false });
    session.emit("Fetch.requestPaused", { requestId: tooLong });
    expect(JSON.parse(trace.report()).events.at(-1)).toMatchObject({ request: 0 });
    session.next = Promise.resolve({ frameTree: { frame: { id: privateText } } });
    await session.send("Page.getFrameTree");
    const streamRequest = privateText + "-document";
    session.next = Promise.resolve({ stream: tooLong });
    await session.send("Fetch.takeResponseBodyAsStream", { requestId: streamRequest });
    session.next = Promise.resolve({ data: "", eof: true });
    await session.send("IO.read", { handle: tooLong });
    expect(JSON.parse(trace.report()).events.at(-1)).toMatchObject({ event: "read", request: 0 });
    for (let i = 0; i < 6; i++) {
        session.next = Promise.resolve({ stream: privateText + "-stream" + i });
        await session.send("Fetch.takeResponseBodyAsStream", { requestId: streamRequest });
    }
    trace.stage("SUBMISSION_PREPARED");
    for (let i = 0; i < 180; i++)
        session.emit("Fetch.requestPaused", {
            requestId: privateText + i,
            frameId: privateText,
            resourceType: "Image",
            request: {
                url: "https://app.test/" + privateText + "?query=" + privateText,
                method: privateText,
            },
            responseHeaders: [{ name: privateText, value: privateText }],
        });
    session.emit("Page.frameNavigated", {
        frame: { id: privateText, url: "https://idp.test/login?query=" + privateText },
    });
    // 主框架、一个文档和六个流先占八个槽位，新请求只有前一百二十个能取得序号。
    for (const i of [119, 120]) session.emit("Fetch.requestPaused", { requestId: privateText + i });
    const boundaryEvents = JSON.parse(trace.report()).events.slice(-2);
    expect(boundaryEvents.map((item: { request: number }) => item.request)).toEqual([121, 0]);
    session.next = Promise.resolve({ stream: privateText + "-overflow" });
    await session.send("Fetch.takeResponseBodyAsStream", { requestId: streamRequest });
    session.next = Promise.resolve({
        data: Buffer.from(privateText).toString("base64"),
        base64Encoded: true,
        eof: true,
    });
    await session.send("IO.read", { handle: privateText + "-overflow" });
    await session.send("IO.read", { handle: privateText + "-stream0" });
    await session.send("IO.close", { handle: privateText + "-stream0" });
    session.emit("Fetch.requestPaused", { requestId: privateText + "-newly-retained" });
    expect(JSON.parse(trace.report()).events.at(-1)).toMatchObject({ request: 122 });
    session.emit("Fetch.requestPaused", {
        requestId: privateText + 1,
        frameId: privateText,
        resourceType: "Image",
        request: { url: "https://idp.test/favicon.ico?" + privateText, method: "GET" },
    });
    trace.denied();
    const output = trace.report();
    trace.stage("IDENTITY");
    session.emit("Fetch.requestPaused", { requestId: privateText });
    trace.denied();
    expect(trace.report()).toBe(output);
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(12 * 1024);
    expect(output).not.toContain(privateText);
    expect(output).not.toContain(Buffer.from(privateText).toString("base64"));
    const report = JSON.parse(output);
    expect(report.firstDenied).toBe(true);
    expect(report.peakRetainedIds).toBe(128);
    expect(report.events.length).toBeLessThanOrEqual(48);
    expect(report.droppedEvents).toBeGreaterThan(0);
    expect(report.droppedIds).toBeGreaterThan(0);
    expect(report.events).toContainEqual(
        expect.objectContaining({ event: "frameNavigated", main: true, site: "IDP", path: "LOGIN" }),
    );
    expect(report.events).toContainEqual(
        expect.objectContaining({ event: "read", request: 1, bytes: Buffer.byteLength(privateText), eof: true }),
    );
    expect(report.events).toContainEqual(expect.objectContaining({ event: "read", request: 0 }));
    expect(report.stage).toBe("SUBMISSION_PREPARED");
    expect(report.events).not.toContainEqual(expect.objectContaining({ event: "stage" }));
    expect(report.events.slice(-2)).toMatchObject([
        { event: "paused", site: "IDP", path: "FAVICON" },
        { event: "firstDenied", stage: "SUBMISSION_PREPARED" },
    ]);
    trace.dispose();
});
