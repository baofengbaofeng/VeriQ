/**
 * 在真实宿主会话和 IPC 操作解析器上测试浏览器交接；替换 Electron 的网络和系统启动函数，观察实际出站目标。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Session } from "electron";
import { openAgentFormInBrowser } from "../src/renderer/agent-web-form.ts";
import { HostSession } from "../src/main/session.ts";
import { formDestination, type WorkspaceFormCard } from "../../web/src/features/agent/workspace-forms.ts";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const turnId = "44444444-4444-4444-8444-444444444444";
const reference = { workspaceId, sessionId, turnId, capability: "AUTH_CREDENTIALS" } as const;
const card: WorkspaceFormCard = { type: "OPEN_WORKSPACE_FORM", workspaceId, capability: "AUTH_CREDENTIALS" };

/**
 * 手动交付宿主认证请求的 Response，使测试可以精确控制撤权或切换标签与系统浏览器调用之间的先后顺序。
 */
function fixture() {
    const received: string[] = [];
    const launched: string[] = [];
    const pending: Array<(reply: Response) => void> = [];
    const host = new HostSession(
        {
            fetch: (url: string) => {
                received.push(url);
                return new Promise<Response>((done) => {
                    pending.push(done);
                });
            },
            clearStorageData: async () => {},
        } as Pick<Session, "fetch" | "clearStorageData">,
        "https://forms.example.invalid:8443",
    );
    host.workspace = {
        id: workspaceId,
        key: "example",
        name: "Example",
        role: "ADMIN",
        archived: false,
        createdAt: "2026-01-01T00:00:00Z",
    };
    host.user = {
        user: { id: turnId, displayName: "Employee", email: "employee@example.invalid", disabled: false },
        expiresAt: "2030-01-01T00:00:00Z",
    };
    const prepare = (input: unknown) => host.prepareAgentWebForm(input);
    const open = (ticket: unknown) =>
        host.openAgentWebForm({ ticket }, async (url) => {
            launched.push(url);
        });
    function respond(reply: Response, index = 0) {
        const [release] = pending.splice(index, 1);
        assert.ok(release);
        release(reply);
    }
    return { host, received, launched, prepare, open, respond };
}

test("only saved Web-only form IDs open fixed paths on the authenticated origin", async () => {
    const handoff = fixture();
    for (const capability of [
        "AUTH_CREDENTIALS",
        "DEVICE_ACCESS",
        "DEVICE_CREDENTIAL_DELIVERY",
        "CI_PLAN_TOKENS",
        "WORKSPACE_MEMBERS",
        "AI_PROVIDERS",
        "NOTIFICATION_INBOX",
        "WORKSPACE_ARCHIVE",
    ] as const) {
        const pending = handoff.prepare({ ...reference, capability });
        handoff.respond(Response.json({ data: { ...card, capability } }));
        const ticket = await pending;
        await handoff.open(ticket);
        await assert.rejects(handoff.open(ticket));
        const launchedUrl = handoff.launched.at(-1);
        assert.ok(launchedUrl);
        const got = new URL(launchedUrl);
        assert.equal(got.origin, handoff.host.origin);
        assert.equal(got.searchParams.has("sessionId"), false);
        assert.equal(got.searchParams.has("turnId"), false);
        assert.equal(got.username + got.password + got.hash, "");
        assert.equal(got.searchParams.get("fromAgentForm"), "1");
        if (capability === "NOTIFICATION_INBOX") {
            assert.equal(got.pathname, "/notifications");
            assert.equal(got.searchParams.has("workspaceId"), false);
        } else {
            const expected = formDestination({ ...card, capability }, "web");
            assert.equal(got.pathname + got.search, expected?.platform === "web" && expected.href);
        }
    }
    assert.equal(new Set(handoff.received).size, 1);
    const route = `/api/v1/workspaces/${workspaceId}/agent/sessions/${sessionId}/turns/${turnId}/workspace-form`;
    assert.equal(handoff.received[0], handoff.host.origin + route);
});

test("cross-workspace, native-only and free-form destinations cannot reach the system browser", async () => {
    const handoff = fixture();
    for (const bad of [
        { ...reference, url: "https://unapproved.invalid/" },
        { ...reference, capability: "https://unapproved.invalid/" },
        { ...reference, capability: "ENVIRONMENT" },
        { ...reference, workspaceId: turnId },
        { ...reference, sessionId: "not-a-uuid" },
    ])
        await assert.rejects(handoff.prepare(bad));
    assert.deepEqual(handoff.received, []);
    for (const response of [
        Response.json({ code: "WORKSPACE_FORBIDDEN" }, { status: 403 }),
        Response.json({ data: { ...card, workspaceId: turnId } }),
        Response.json({ data: { ...card, capability: "WORKSPACE_MEMBERS" } }),
        Response.json({ data: { ...card, href: "https://unapproved.invalid/" } }),
    ]) {
        const pending = handoff.prepare(reference);
        handoff.respond(response);
        await assert.rejects(pending);
    }
    const previousWorkspace = handoff.host.workspace;
    const beforeReselect = handoff.prepare(reference);
    handoff.host.invalidate(false);
    handoff.host.workspace = previousWorkspace;
    handoff.respond(Response.json({ data: card }));
    await assert.rejects(beforeReselect);
    const pending = handoff.prepare(reference);
    handoff.host.invalidate();
    handoff.respond(Response.json({ data: card }));
    await assert.rejects(pending);
    await assert.rejects(handoff.prepare(reference));
    assert.deepEqual(handoff.launched, []);
});

test("a delayed host read cannot launch after the original renderer conversation closes", async () => {
    const handoff = fixture();
    const intent = new AbortController();
    const bridge = { prepareAgentWebForm: handoff.prepare, openAgentWebForm: handoff.open };
    const pending = openAgentFormInBrowser(bridge, reference, intent.signal);
    assert.equal(handoff.received.length, 1);
    intent.abort();
    handoff.respond(Response.json({ data: card }));
    await pending;
    assert.deepEqual(handoff.launched, []);
    await openAgentFormInBrowser(bridge, reference, intent.signal);
    assert.equal(handoff.received.length, 1);
    const current = openAgentFormInBrowser(bridge, reference, new AbortController().signal);
    handoff.respond(Response.json({ data: card }));
    await current;
    assert.equal(handoff.launched.length, 1);
});

test("issued tickets expire and are bound to the host employee and workspace generation", async (ctx) => {
    const handoff = fixture();
    let now = performance.now();
    ctx.mock.method(performance, "now", () => now);
    const issue = async () => {
        const pending = handoff.prepare(reference);
        handoff.respond(Response.json({ data: card }));
        return pending;
    };
    const staleTime = await issue();
    now += 60_000;
    await assert.rejects(handoff.open(staleTime));
    const staleActor = await issue();
    const originalActor = handoff.host.user;
    assert.ok(originalActor);
    handoff.host.user = { ...originalActor };
    await assert.rejects(handoff.open(staleActor));
    const staleScope = await issue();
    const original = handoff.host.workspace;
    handoff.host.invalidate(false);
    handoff.host.workspace = original;
    await assert.rejects(handoff.open(staleScope));
    await assert.rejects(handoff.open("https://another.invalid/"));
    assert.deepEqual(handoff.launched, []);
});

test("a late old prepare cannot replace the latest verified browser destination", async () => {
    const handoff = fixture();
    const first = handoff.prepare(reference);
    const latest = handoff.prepare({ ...reference, capability: "WORKSPACE_MEMBERS" });
    handoff.respond(Response.json({ data: { ...card, capability: "WORKSPACE_MEMBERS" } }), 1);
    const ticket = await latest;
    handoff.respond(Response.json({ data: card }));
    await assert.rejects(first);
    await handoff.open(ticket);
    assert.equal(handoff.launched.length, 1);
    assert.match(handoff.launched[0] ?? "", /tab=members/);
});
