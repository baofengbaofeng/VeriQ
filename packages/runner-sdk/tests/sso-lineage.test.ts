/**
 * 使用真实浏览器已观测的两种事件顺序与跨跳标识关系，验证发出继续命令之前具备文档归属、响应履约和当前认证窗口的证据。
 */
import { EventEmitter } from "node:events";
import type { Page } from "@playwright/test";
import { guardSsoPage } from "../src/fixtures/sso-boundary.js";
import { afterEach, expect, test, vi } from "vitest";
import { SsoLineage, type Admission, type Owner } from "../src/fixtures/sso-lineage.js";

function fixture(holdAcknowledgements = false) {
    const decide = vi.fn((...args: unknown[]) => {
        const ack = args[5];
        if (!holdAcknowledgements && typeof ack === "function") ack();
    });
    const violation = vi.fn(() => {
        lineage.close();
    });
    const lineage = new SsoLineage(decide, violation);
    function join(
        id: string,
        loader: string,
        admission: Admission,
        owner: Owner = "APP",
        networkFirst = true,
        key = id,
        parent?: string,
    ) {
        const hop = {
            type: admission === "resource" ? "Script" : "Document",
            method: "GET",
            target: "APP" as const,
            redirected: parent !== undefined,
        };
        const network = () => lineage.network(key, { ...hop, loader, owner });
        const paused = () => lineage.paused(key, { ...hop, id, admission, ...(parent ? { parent } : {}) });
        if (networkFirst) {
            network();
            paused();
        } else {
            paused();
            network();
        }
    }
    return { lineage, decide, violation, join };
}

afterEach(() => vi.useRealTimers());

test.each([true, false])("requires the approved owner and loader before and after Frame, network first %s", (first) => {
    const { lineage, decide, join } = fixture();
    join("landing", "app-loader", "landing");
    lineage.response("landing", true);
    join("old-before", "idp-loader", "resource", "IDP", first);
    lineage.frame("app-loader", "APP");
    join("old-after", "idp-loader", "resource", "IDP", first);
    join("wrong-owner", "app-loader", "resource", "IDP", first);
    join("wrong-loader", "idp-loader", "resource", "APP", first);
    join("approved", "app-loader", "resource", "APP", first);
    expect(decide.mock.calls.map(([id, allowed]) => [id, allowed])).toEqual([
        ["landing", true],
        ["old-before", false],
        ["old-after", false],
        ["wrong-owner", false],
        ["wrong-loader", false],
        ["approved", true],
    ]);
    expect(lineage.close()).toBe(true);
});

test.each([true, false])("holds a resource and commit confirmation until document fulfillment is %s", async (ok) => {
    const { lineage, decide, join } = fixture();
    join("landing", "app-loader", "landing");
    lineage.frame("app-loader", "APP");
    const committed = lineage.committed();
    join("script", "app-loader", "resource");
    expect(decide.mock.calls.map(([id]) => id)).toEqual(["landing"]);
    lineage.response("landing", ok);
    expect(decide.mock.calls.at(-1)?.slice(0, 2)).toEqual(["script", ok]);
    lineage.close();
    await expect(committed).resolves.toBe(ok);
});

test("links redirect hops sharing one network identifier and rejects a repeated Fetch identifier", () => {
    const { lineage, decide, join } = fixture();
    join("post", "loader", "chain", "IDP", true, "navigation");
    join("callback", "loader", "landing", "APP", false, "navigation", "post");
    lineage.response("callback", false);
    join("final", "loader", "landing", "APP", true, "navigation", "callback");
    join("final", "loader", "landing", "APP", true, "navigation", "callback");
    join("orphan", "loader", "chain", "IDP", true, "another", "post");
    expect(decide.mock.calls.map(([, allowed]) => allowed)).toEqual([true, true, true, false, false]);
    lineage.close();
});

test("closes a pending authentication request before business admission or timeout", () => {
    vi.useFakeTimers();
    const hop = {
        id: "p",
        method: "GET",
        type: "Script",
        target: "APP",
        redirected: false,
        admission: "resource",
    } as const;
    for (const ending of ["business", "timeout"]) {
        const { lineage, decide, violation } = fixture();
        lineage.paused("network", hop);
        if (ending === "business") expect(lineage.close()).toBe(false);
        else {
            vi.runAllTimers();
            expect(violation).toHaveBeenCalledOnce();
        }
        lineage.network("network", { ...hop, loader: "later", owner: "APP" });
        expect(decide.mock.calls.map(([id, allowed]) => [id, allowed])).toEqual([["p", false]]);
    }
});

test("bounds retained protocol identifiers and fails closed for absent or oversized attribution", () => {
    const network = {
        method: "GET",
        type: "Document",
        target: "APP",
        redirected: false,
        loader: "l",
        owner: "APP",
    } as const;
    for (const bad of ["", "x".repeat(257)]) {
        for (const field of ["network", "loader"]) {
            const { lineage, violation } = fixture();
            lineage.network(field === "network" ? bad : "n", { ...network, loader: field === "loader" ? bad : "l" });
            expect(violation).toHaveBeenCalledOnce();
        }
    }
    const { lineage, violation, decide } = fixture();
    for (let i = 0; i < 128; i++) lineage.network("key" + i, network);
    expect(violation).toHaveBeenCalledOnce();
    expect(decide).not.toHaveBeenCalled();
});

/**
 * 在同一守卫会话上控制文档履约的确认时刻，分别核对原始浏览器命令的继续与拒绝次数，取消不能把同一请求结算两次。
 */
async function boundaryFixture(holdScript = false, holdHandoff = false) {
    const session = new EventEmitter();
    function deferred() {
        let resolve!: () => void;
        let reject!: (error: Error) => void;
        const promise = new Promise<void>((ok, fail) => {
            resolve = ok;
            reject = fail;
        });
        return { promise, resolve, reject };
    }
    const fulfilled = deferred();
    const scriptAck = deferred();
    const handoffAck = deferred();
    const sent = deferred();
    const commands: Array<{ name: string; id?: string }> = [];
    const transport = Object.assign(session, {
        async send(name: string, args?: { requestId?: string }) {
            commands.push({ name, ...(args?.requestId ? { id: args.requestId } : {}) });
            if (holdScript && name === "Fetch.continueRequest" && args?.requestId === "script") await scriptAck.promise;
            if (name === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
            if (name === "Fetch.takeResponseBodyAsStream") return { stream: "body" };
            if (name === "IO.read") return { data: "ok", eof: true };
            if (name === "Fetch.fulfillRequest") {
                sent.resolve();
                if (holdHandoff && args?.requestId === "handoff") await handoffAck.promise;
                else await fulfilled.promise;
            }
            return {};
        },
    });
    const context = Object.assign(new EventEmitter(), {
        browser: () => ({ version: () => "158.0.0.0" }),
        newCDPSession: async () => transport,
        route: async () => {},
        routeWebSocket: async () => {},
    });
    const page = Object.assign(new EventEmitter(), { context: () => context });
    const app = "https://app.example",
        idp = "https://idp.example";
    const guard = await guardSsoPage(
        page as unknown as Page,
        { app, idp, api: app, submitPath: "/submit", callbackPath: "/callback" },
        () => {},
        () => {},
    );
    guard.prepareSubmission();
    guard.protectLoginMaterial("fixture-account", "fixture-only");
    function send(
        id: string,
        url: string,
        method: string,
        type: string,
        networkId: string | undefined,
        loaderId: string,
        doc: string,
        frameId = "main",
        parent?: string,
        timestamp = 20,
    ) {
        const request = { url, method };
        if (networkId)
            session.emit("Network.requestWillBeSent", {
                requestId: networkId,
                timestamp,
                request,
                loaderId,
                frameId,
                type,
                documentURL: doc,
                ...(parent ? { redirectResponse: {} } : {}),
            });
        session.emit("Fetch.requestPaused", {
            requestId: id,
            request,
            networkId,
            frameId,
            resourceType: type,
            redirectedRequestId: parent,
        });
    }
    send("post", idp + "/submit", "POST", "Document", "navigation", "new", idp + "/submit");
    session.emit("Fetch.requestPaused", {
        requestId: "post",
        networkId: "navigation",
        frameId: "main",
        resourceType: "Document",
        request: { method: "POST", url: idp + "/submit" },
        responseStatusCode: 303,
        responseHeaders: [],
    });
    send("doc", app + "/callback", "GET", "Document", "navigation", "new", app + "/callback", "main", "post");
    session.emit("Fetch.requestPaused", {
        requestId: "doc",
        request: { method: "GET", url: app + "/callback" },
        frameId: "main",
        resourceType: "Document",
        networkId: "navigation",
        responseStatusCode: 200,
        responseHeaders: [],
    });
    await sent.promise;
    const script = (networkId: string | undefined = "resource", frameId = "main", loader = "new", source = app) =>
        send("script", app + "/asset", "GET", "Script", networkId, loader, source + "/page", frameId);
    const decisions = () => commands.filter(({ id }) => id === "script").map(({ name }) => name);
    async function verifyIdentity() {
        guard.prepareIdentity(app + "/me");
        const confirmed = guard.observedDocument("identity");
        send("me", app + "/me", "GET", "Document", "identity-net", "identity-loader", app + "/me");
        session.emit("Fetch.requestPaused", {
            requestId: "me",
            networkId: "identity-net",
            frameId: "main",
            resourceType: "Document",
            request: { method: "GET", url: app + "/me" },
            responseStatusCode: 200,
            responseHeaders: [],
        });
        session.emit("Page.frameNavigated", { frame: { id: "main", loaderId: "identity-loader", url: app + "/me" } });
        await expect(confirmed).resolves.toBe(true);
    }
    return {
        session,
        guard,
        fulfilled,
        script,
        decisions,
        app,
        idp,
        commands,
        send,
        verifyIdentity,
        scriptAck,
        handoffAck,
    };
}

test.each(["success", "failure", "stop", "business"] as const)("settles the paused script once on %s", async (end) => {
    const { guard, fulfilled, script, decisions } = await boundaryFixture();
    script();
    expect(decisions()).toEqual([]);
    if (end === "failure") fulfilled.reject(new Error("fixture"));
    else if (end === "stop") guard.stop();
    else if (end === "business") expect(() => guard.authorizeBusiness()).toThrow("SSO_ORIGIN_NOT_ALLOWED");
    else fulfilled.resolve();
    if (end === "failure") await expect(guard.violation).rejects.toThrow("SSO_ORIGIN_NOT_ALLOWED");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(decisions()).toEqual([end === "success" ? "Fetch.continueRequest" : "Fetch.failRequest"]);
    guard.stop();
    fulfilled.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(decisions()).toHaveLength(1);
});

test.each(["missingNetwork", "otherFrame", "oldBefore", "oldAfter"] as const)(
    "rejects a request to the allowed APP endpoint with %s provenance",
    async (kind) => {
        const { session, guard, fulfilled, script, decisions, app, idp } = await boundaryFixture();
        fulfilled.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (kind === "oldAfter")
            session.emit("Page.frameNavigated", { frame: { id: "main", loaderId: "new", url: app + "/callback" } });
        if (kind === "missingNetwork") script("");
        else if (kind === "otherFrame") script("resource", "child");
        else script("resource", "main", "old", idp);
        await expect(guard.violation).rejects.toThrow("SSO_ORIGIN_NOT_ALLOWED");
        expect(decisions()).toEqual(["Fetch.failRequest"]);
    },
);

test("preserves late APP resources while an independently owned API identity document is committing", async () => {
    const { lineage, join, decide } = fixture();
    join("landing", "app-loader", "landing");
    lineage.response("landing", true);
    const observing = lineage.committed("identity");
    const api = { method: "GET", type: "Document", target: "API", redirected: false } as const;
    lineage.paused("api-nav", { ...api, id: "me", admission: "identity" });
    lineage.network("api-nav", { ...api, loader: "api-loader", owner: "API" });
    lineage.frame("api-loader", "API");
    join("late-app", "app-loader", "resource", "APP");
    join("api-script", "api-loader", "resource", "API");
    expect(decide.mock.calls.map(([id]) => id)).toEqual(["landing", "me", "late-app"]);
    lineage.response("me", true);
    await expect(observing).resolves.toBe(true);
    expect(decide.mock.calls.at(-1)?.slice(0, 2)).toEqual(["api-script", true]);
    lineage.close();
});

test.each(["unknown", "doc"])("rejects undocumented or replayed response %s before opening the body", async (id) => {
    const { session, guard, commands, app, fulfilled } = await boundaryFixture();
    const reads = commands.filter((entry) => entry.name === "Fetch.takeResponseBodyAsStream").length;
    session.emit("Fetch.requestPaused", {
        requestId: id,
        networkId: "navigation",
        frameId: "main",
        resourceType: "Document",
        request: { method: "GET", url: app + "/callback" },
        responseStatusCode: 200,
        responseHeaders: [],
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
        expect(commands.filter((entry) => entry.name === "Fetch.takeResponseBodyAsStream")).toHaveLength(reads);
        expect(commands.filter((entry) => entry.name === "Fetch.failRequest" && entry.id === id)).toHaveLength(1);
    } finally {
        guard.stop();
        fulfilled.resolve();
    }
});

test.each(["duplicate", "repeated", "invalidDuplicate", "terminal"])(
    "rejects a waiting script exactly once when %s arrives",
    async (event) => {
        const { session, guard, fulfilled, script, decisions, app } = await boundaryFixture();
        script();
        if (event !== "terminal") {
            for (let n = 0; n < (event === "repeated" ? 2 : 1); n++)
                session.emit("Fetch.requestPaused", {
                    requestId: "script",
                    networkId: event === "invalidDuplicate" ? undefined : "resource",
                    frameId: "main",
                    resourceType: "Script",
                    request: { method: "GET", url: app + "/asset" },
                });
        } else session.emit("Network.loadingFailed", { requestId: "resource" });
        await expect(guard.violation).rejects.toThrow("SSO_ORIGIN_NOT_ALLOWED");
        fulfilled.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(decisions()).toEqual(["Fetch.failRequest"]);
    },
);

test.each(["url", "method", "network", "frame", "type", "valid"] as const)(
    "verifies business document response admission before the body is touched for %s",
    async (kind) => {
        const { session, guard, fulfilled, commands, app, send, verifyIdentity } = await boundaryFixture();
        fulfilled.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));
        await verifyIdentity();
        guard.authorizeBusiness();
        send("business", app + "/home", "GET", "Document", "request", "business-loader", app + "/home");
        const reads = commands.filter((entry) => entry.name === "Fetch.takeResponseBodyAsStream").length;
        session.emit("Fetch.requestPaused", {
            requestId: "business",
            networkId: kind === "network" ? "another" : "request",
            frameId: kind === "frame" ? "another" : "main",
            resourceType: kind === "type" ? "Script" : "Document",
            request: { method: kind === "method" ? "POST" : "GET", url: app + (kind === "url" ? "/else" : "/home") },
            responseStatusCode: 200,
            responseHeaders: [],
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(commands.filter((entry) => entry.name === "Fetch.takeResponseBodyAsStream")).toHaveLength(
            reads + Number(kind === "valid"),
        );
        expect(commands.filter((entry) => entry.name === "Fetch.failRequest" && entry.id === "business")).toHaveLength(
            Number(kind !== "valid"),
        );
        guard.stop();
    },
);

test.each(["success", "failure", "duplicate"] as const)(
    "preserves an approved resource across identity confirmation until its %s acknowledgement",
    async (outcome) => {
        const { session, guard, fulfilled, script, decisions, app, verifyIdentity, scriptAck } =
            await boundaryFixture(true);
        fulfilled.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));
        script();
        await verifyIdentity();
        expect(decisions()).toEqual(["Fetch.continueRequest"]);
        try {
            expect(() => guard.authorizeBusiness()).not.toThrow();
            if (outcome === "duplicate")
                session.emit("Fetch.requestPaused", {
                    requestId: "script",
                    networkId: "resource",
                    frameId: "main",
                    resourceType: "Script",
                    request: { method: "GET", url: app + "/asset" },
                });
            if (outcome === "failure") scriptAck.reject(new Error("fixture"));
            else scriptAck.resolve();
            if (outcome !== "success") await expect(guard.violation).rejects.toThrow("SSO_ORIGIN_NOT_ALLOWED");
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(decisions()).toEqual(["Fetch.continueRequest"]);
        } finally {
            scriptAck.resolve();
            guard.stop();
        }
    },
);

test.each(["stale", "active", "confirmed"] as const)(
    "retires only a confirmed canceled handoff with %s evidence",
    async (kind) => {
        const { session, guard, fulfilled, app, send, verifyIdentity, handoffAck } = await boundaryFixture(false, true);
        fulfilled.resolve();
        session.emit("Page.frameNavigated", { frame: { id: "main", loaderId: "new", url: app + "/callback" } });
        await new Promise<void>((resolve) => setImmediate(resolve));
        send("handoff", app + "/home", "GET", "Document", "handoff-net", "next", app + "/home");
        if (kind === "active") {
            session.emit("Fetch.requestPaused", {
                requestId: "handoff",
                networkId: "handoff-net",
                frameId: "main",
                resourceType: "Document",
                request: { method: "GET", url: app + "/home" },
                responseStatusCode: 200,
                responseHeaders: [],
            });
        }
        await verifyIdentity();
        session.emit("Network.loadingFailed", {
            requestId: "handoff-net",
            type: "Document",
            canceled: true,
            errorText: "net::ERR_ABORTED",
            timestamp: kind === "stale" ? 19 : 21,
        });
        try {
            if (kind === "confirmed") expect(() => guard.authorizeBusiness()).not.toThrow();
            else expect(() => guard.authorizeBusiness()).toThrow("SSO_ORIGIN_NOT_ALLOWED");
        } finally {
            handoffAck.resolve();
            guard.stop();
        }
    },
);

test.each(["network-first", "pause-first"])(
    "keeps a redirected resource independent of old ACK and terminal in %s order",
    (order) => {
        const { lineage, decide, join, violation } = fixture(true);
        join("landing", "document-loader", "landing");
        lineage.response("landing", true);
        join("asset-first", "document-loader", "resource", "APP", true, "shared");
        const hop = { method: "GET", type: "Script", target: "APP", redirected: true } as const;
        const network = () => lineage.network("shared", { ...hop, loader: "document-loader", owner: "APP", time: 21 });
        const pause = () =>
            lineage.paused("shared", { ...hop, id: "asset-next", parent: "asset-first", admission: "resource" });
        if (order === "network-first") network();
        else pause();
        lineage.terminal("shared", 20);
        if (order === "network-first") pause();
        else network();
        expect(decide.mock.calls.map(([id, allowed]) => [id, allowed])).toEqual([
            ["landing", true],
            ["asset-first", true],
            ["asset-next", true],
        ]);
        const firstAck = decide.mock.calls[1]?.[5],
            nextAck = decide.mock.calls[2]?.[5];
        if (typeof firstAck !== "function" || typeof nextAck !== "function") throw new Error("RESOURCE_ACK_MISSING");
        firstAck();
        expect(lineage.isContinuing("asset-first")).toBe(false);
        expect(lineage.isContinuing("asset-next")).toBe(true);
        nextAck();
        expect(lineage.isContinuing("asset-next")).toBe(false);
        expect(violation).not.toHaveBeenCalled();
        lineage.close();
    },
);
