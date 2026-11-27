import { chooseLanguage, chooseWorkspace, openWorkspaceMenu, workspacePicker } from "./support/console-controls";
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { PlatformComponents } from "@veriq/contracts";
test("reports show real Workspace history and clear scope on switch", async ({ page }) => {
    const state = (await (await page.request.get("/api/v1/setup")).json()).data;
    if (!state.initialized)
        expect(
            (
                await page.request.post("/api/v1/setup", {
                    headers: {
                        Origin: "http://127.0.0.1:5173",
                        "X-CSRF-Token": state.csrfToken,
                    },
                    data: {
                        installationSecret: "browser-operator-secret",
                        email: "browser-admin@example.com",
                        displayName: "Browser Administrator",
                        password: "Browser password 123!",
                    },
                })
            ).status(),
        ).toBe(201);
    await page.goto("/login");
    await page.getByRole("textbox", { name: "Email" }).fill("browser-admin@example.com");
    await page.getByLabel("Password").fill("Browser password 123!");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("dl")).toBeVisible();
    const session = (await (await page.request.get("/api/v1/auth/session")).json()).data;
    const headers = {
        Origin: "http://127.0.0.1:5173",
        "X-CSRF-Token": session.csrfToken,
    };
    const a = await page.request.post("/api/v1/workspaces", {
        headers,
        data: { key: "reports-a", name: "Reports A" },
    });
    const b = await page.request.post("/api/v1/workspaces", {
        headers,
        data: { key: "reports-b", name: "Reports B" },
    });
    expect(a.status()).toBe(201);
    expect(b.status()).toBe(201);
    await page.getByRole("link", { name: "Reports", exact: true }).click();
    await chooseLanguage(page, "en");
    await expect(page.getByRole("heading", { name: "Reports", exact: true })).toBeVisible();
    await chooseWorkspace(page, (await a.json()).data.id);
    await expect(page.getByText("No runs in this Workspace.", { exact: true })).toBeVisible();
    await chooseWorkspace(page, (await b.json()).data.id);
    await expect(page.getByText("No runs in this Workspace.", { exact: true })).toBeVisible();
    await expect(page.getByText("Select a run to inspect its report.", { exact: true })).toBeVisible();
});

/**
 * 工作区选择回归只创建真实账户空间并读取真实游标分页，不构造 Run、Attempt 或报告数据；因此它能覆盖 URL 与手动选择，却
 * 不能代替受管理引擎产生的订阅和历史验收。
 */
async function reportSession(page: Page) {
    const setup = (await (await page.request.get("/api/v1/setup")).json()).data;
    if (!setup.initialized) {
        const response = await page.request.post("/api/v1/setup", {
            headers: { Origin: "http://127.0.0.1:5173", "X-CSRF-Token": setup.csrfToken },
            data: {
                installationSecret: "browser-operator-secret",
                email: "browser-admin@example.com",
                displayName: "Browser Administrator",
                password: "Browser password 123!",
            },
        });
        expect(response.status()).toBe(201);
    }
    await page.goto("/login");
    await page.getByRole("textbox", { name: "Email" }).fill("browser-admin@example.com");
    await page.getByLabel("Password").fill("Browser password 123!");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("dl")).toBeVisible();
    const session = (await (await page.request.get("/api/v1/auth/session")).json()).data;
    return { Origin: "http://127.0.0.1:5173", "X-CSRF-Token": session.csrfToken };
}

test("reports discover URL workspace on a later genuine page and retain manual choice", async ({ page }) => {
    test.setTimeout(90_000);
    const headers = await reportSession(page);
    for (let index = 0; index < 26; index += 1) {
        const response = await page.request.post("/api/v1/workspaces", {
            headers,
            data: { key: `reports-page-${randomUUID()}`, name: `Report pagination ${index}` },
        });
        expect(response.status()).toBe(201);
    }
    type WorkspacePage = PlatformComponents["schemas"]["WorkspaceDTOPageEnvelope"]["data"];
    const firstResponse = await page.request.get("/api/v1/workspaces");
    expect(firstResponse.status()).toBe(200);
    const first: WorkspacePage = (await firstResponse.json()).data;
    if (!first.nextCursor || !first.items.length) throw new Error("Expected genuine workspace pagination");
    const secondResponse = await page.request.get("/api/v1/workspaces", {
        params: { cursor: first.nextCursor },
    });
    expect(secondResponse.status()).toBe(200);
    const second: WorkspacePage = (await secondResponse.json()).data;
    const target = second.items[0];
    const fallback = first.items[0];
    if (!target || !fallback) throw new Error("Expected two populated workspace pages");
    const selector = workspacePicker(page);
    // 从会话打开指定 Run 时需要直接验证第二页的工作区，未知 Run 本身仍由真实报告接口拒绝，不能退回别的工作区。
    const missingRun = randomUUID();
    const runPath = `/workspaces/${target.id}/runs/${missingRun}`;
    const lookup = page.waitForResponse(
        (response) =>
            response.url().endsWith(runPath + "/report") || response.url().endsWith(runPath + "/events/stream"),
    );
    await page.goto(`/reports?workspaceId=${target.id}&runId=${missingRun}`);
    await expect(selector).toHaveAttribute("data-workspace-id", target.id);
    expect((await lookup).status()).toBe(404);
    await page.goto(`/reports?workspaceId=${target.id}`);
    await expect(selector).toHaveAttribute("data-workspace-id", fallback.id);
    await openWorkspaceMenu(page);
    await page.getByRole("menuitem", { name: "More Workspaces", exact: true }).click();
    await expect(selector).toHaveAttribute("data-workspace-id", target.id);
    await chooseWorkspace(page, fallback.id);
    await chooseLanguage(page, "en");
    await expect(page.getByRole("heading", { name: "Reports", exact: true })).toBeVisible();
    await expect(selector).toHaveAttribute("data-workspace-id", fallback.id);
    // 同一个真实列表还覆盖首屏可见目标和缺失目标，页面导航新建选择生命周期；不能假设创建顺序就是服务端排序，所有目标与
    // 回退项均来自刚读取的 API 分页。
    await page.goto(`/reports?workspaceId=${fallback.id}`);
    await expect(selector).toHaveAttribute("data-workspace-id", fallback.id);
    const other = first.items.find((item) => item.id !== fallback.id);
    if (!other) throw new Error("Expected a manual alternative workspace");
    await chooseWorkspace(page, other.id);
    await chooseLanguage(page, "zh");
    const localizedSelector = workspacePicker(page);
    await expect(localizedSelector).toHaveAttribute("data-workspace-id", other.id);
    await page.goto(`/reports?workspaceId=${randomUUID()}`);
    await expect(localizedSelector).toHaveAttribute("data-workspace-id", fallback.id);
});

for (const initialResponse of ["stale report", "authentication error"]) {
    test(`a delayed ${initialResponse} cannot replace the live terminal report or its evidence`, async ({ page }) => {
        const headers = await reportSession(page);
        const created = await page.request.post("/api/v1/workspaces", {
            headers,
            data: { key: `reports-${randomUUID()}`, name: "Report subscription ordering" },
        });
        expect(created.status(), await created.text()).toBe(201);
        const ws = (await created.json()).data.id;
        const runId = randomUUID();
        const attemptId = randomUUID();
        const gate = { passed: true, reasons: [] };
        const createdAt = "2026-01-01T00:00:00Z";
        const run = { id: runId, workspaceId: ws, source: "CONNECTED_LOCAL", snapshotHash: "0".repeat(64), createdAt };
        const attempt = {
            id: attemptId,
            attemptNo: 1,
            runtimeId: null,
            phase: "FINISHED",
            outcome: "PASSED",
            createdAt,
            activatedAt: null,
            finishedAt: createdAt,
            lastSequence: 0,
            facts: {},
            provenance: {},
            gateAtExecution: gate,
            gateNow: gate,
            compensations: [],
        };
        const report = {
            run: { ...run, state: "FINISHED", outcome: "PASSED" },
            cases: [
                {
                    id: randomUUID(),
                    caseVersionId: randomUUID(),
                    state: "FINISHED",
                    outcome: "PASSED",
                    provenance: {},
                    attempts: [attempt],
                },
            ],
            gateAtExecution: gate,
            gateNow: gate,
            statistics: { caseCount: 1, firstPassCount: 1, retryPassCount: 0, infrastructureErrorCount: 0 },
        };
        const root = `**/api/v1/workspaces/${ws}`;
        const path = `${root}/runs/${runId}`;
        const envelope = (data: unknown) => ({ json: { data, requestId: randomUUID() } });
        const delayed = Promise.withResolvers<void>();
        await page.route(`${path}/report`, async (route) => {
            await delayed.promise;
            if (initialResponse === "stale report") {
                await route.fulfill(envelope({ ...report, run: { ...run, state: "RUNNING" }, cases: [] }));
            } else {
                await route.fulfill({
                    status: 401,
                    json: { code: "AUTHENTICATION_REQUIRED", message: "Please sign in", requestId: randomUUID() },
                });
            }
        });
        let first = true;
        let revoked = false;
        await page.route(`${path}/events/stream`, (route) => {
            if (revoked)
                return route.fulfill({
                    contentType: "text/event-stream",
                    body: 'event: authorization\ndata: {"code":"WORKSPACE_FORBIDDEN"}\n\n',
                });
            const body = first
                ? `event: report\ndata: ${JSON.stringify({ report, events: [] })}\n\n`
                : ": keepalive\n\n";
            first = false;
            return route.fulfill({ contentType: "text/event-stream", body });
        });
        await page.route(`${path}/attempts/${attemptId}/display`, (route) =>
            route.fulfill(envelope({ display: null, metadataStatus: "ABSENT", environment: {} })),
        );
        await page.route(`${root}/attempts/${attemptId}/history*`, (route) =>
            route.fulfill(envelope({ items: [], nextSequence: 0, hasMore: false })),
        );
        await page.route(`${root}/attempts/${attemptId}/artifacts`, (route) =>
            route.fulfill(
                envelope({
                    items: [
                        {
                            id: randomUUID(),
                            attemptId,
                            sha256: "1".repeat(64),
                            sizeBytes: 42,
                            kind: "TRACE",
                            sensitivity: "CREDENTIAL_RESTRICTED",
                            state: "AVAILABLE",
                        },
                    ],
                }),
            ),
        );
        const completed = Promise.withResolvers<void>();
        for (const event of ["requestfinished", "requestfailed"] as const) {
            page.on(event, (request) => {
                if (request.url().endsWith(`/runs/${runId}/report`)) completed.resolve();
            });
        }
        await page.goto(`/reports?workspaceId=${ws}&runId=${runId}`);
        await chooseLanguage(page, "en");
        const terminal = page.getByRole("button", { name: "Attempt 1 · Passed", exact: true });
        await terminal.click();
        const evidence = page.getByRole("button", { name: "Download Trace", exact: true });
        await expect(evidence).toBeVisible();
        // 等待 GET 的 JSON 正文交给 React，并让提交后的渲染完成，再检查唯一的终态帧仍然生效。
        delayed.resolve();
        await completed.promise;
        await page.evaluate(
            () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
        );
        await expect(page.getByRole("heading", { name: "Passed · Connected local", exact: true })).toBeVisible();
        await expect(terminal).toBeVisible();
        await expect(evidence).toBeVisible();
        revoked = true;
        await expect(terminal).toBeHidden();
        await expect(evidence).toBeHidden();
    });
}

test("workspace audit reads on demand and follows its own cursor", async ({ page }) => {
    const headers = await reportSession(page);
    const created = await page.request.post("/api/v1/workspaces", {
        headers,
        data: { key: `reports-${randomUUID()}`, name: "Audit pagination" },
    });
    expect(created.status()).toBe(201);
    const workspace = (await created.json()).data.id;
    const first = randomUUID(),
        last = randomUUID();
    const requests: (string | null)[] = [];
    await page.route(`**/api/v1/workspaces/${workspace}/audit*`, async (route) => {
        const after = new URL(route.request().url()).searchParams.get("after");
        requests.push(after);
        if (after === last) {
            await route.fulfill({
                status: 403,
                json: { code: "WORKSPACE_FORBIDDEN", message: "Workspace access revoked", requestId: randomUUID() },
            });
            return;
        }
        const id = after ? last : first;
        await route.fulfill({
            json: {
                requestId: randomUUID(),
                data: {
                    items: [
                        {
                            id,
                            actorId: null,
                            targetId: id,
                            action: after ? "service_account.disabled" : "service_account.created",
                            createdAt: "2026-01-02T00:00:00Z",
                        },
                    ],
                    nextCursor: id,
                },
            },
        });
    });
    await page.goto(`/reports?workspaceId=${workspace}`);
    await chooseLanguage(page, "en");
    await expect(page.getByText("No runs in this Workspace.", { exact: true })).toBeVisible();
    expect(requests).toEqual([]);
    await page.getByText("Workspace audit", { exact: true }).click();
    await expect(page.getByText(/service_account\.created/)).toBeVisible();
    await page.getByRole("button", { name: "More audit entries" }).click();
    await expect(page.getByText(/service_account\.disabled/)).toBeVisible();
    await expect(page.getByText(/service_account\.created/)).toBeVisible();
    await page.getByRole("button", { name: "More audit entries" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Workspace access revoked" })).toBeVisible();
    await expect(page.getByText(/service_account\.created/)).toHaveCount(0);
    await expect(page.getByText(/service_account\.disabled/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "More audit entries" })).toHaveCount(0);
    expect(requests).toEqual([null, first, last]);
});
