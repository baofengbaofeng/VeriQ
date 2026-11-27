/**
 * Chromium 通过正常对话取得表单卡，核对点击时的员工轮次请求和业务表单导航，再用归档证明旧的入口仍需授权。
 */
import { randomUUID } from "node:crypto";
import { conversationForm } from "./support/agent-conversation-form";
import { expect, test } from "@playwright/test";
import { editorScope } from "./editor-fixture";
import { installed } from "./support/install-console";

test("an authorized inline form preserves the exact chat draft and repeated clicks recheck access", async ({
    page,
    baseURL,
}) => {
    await conversationForm(page, baseURL, "ENVIRONMENT", async ({ workspaceId, headers }, calls) => {
        const base = `/api/v1/workspaces/${workspaceId}`;
        const card = page.getByRole("button", { name: "Configure execution environments", exact: true });
        await expect(card).toBeVisible();
        const url = page.url();
        const draft = page.getByRole("textbox", { name: "Message", exact: true });
        await draft.fill("Keep my pending message.");
        const verified = page.waitForResponse((response) => response.url().endsWith("/workspace-form"));
        await card.click();
        const verification = await verified;
        expect(verification.request().method()).toBe("GET");
        expect(verification.status()).toBe(200);
        const panel = page.getByRole("region", { name: "Configure execution environments", exact: true });
        await expect(panel.getByRole("heading", { name: "Execution environments", exact: true }).first()).toBeVisible();
        await expect(page).toHaveURL(url);
        await panel.getByRole("button", { name: "Close form", exact: true }).click();
        await expect(panel).toHaveCount(0);
        await expect(draft).toHaveValue("Keep my pending message.");
        await expect(card).toBeVisible();
        await card.click();
        await expect(panel).toBeVisible();
        await page.getByRole("button", { name: "New conversation", exact: true }).click();
        await expect(panel).toHaveCount(0);
        await expect(page).toHaveURL(url);
        expect((await page.request.delete(base, { headers })).status()).toBe(200);
        const closed = await page.request.get(verification.url());
        expect(closed.status(), await closed.text()).toBe(409);
        expect((await closed.json()).code).toBe("WORKSPACE_ARCHIVED");
        expect(calls()).toBe(2);
    });
});

test("inline archive retains the outer URL and requires the original confirmation", async ({ page, baseURL }) => {
    await conversationForm(page, baseURL, "WORKSPACE_ARCHIVE", async ({ workspaceId }, calls) => {
        const entry = page.url();
        const card = page.getByRole("button", { name: "Review workspace archive settings", exact: true });
        await card.click();
        const panel = page.getByRole("region", { name: "Review workspace archive settings", exact: true });
        const archive = panel.getByRole("button", { name: "Archive Workspace", exact: true });
        await archive.click();
        const dialog = page.getByRole("dialog", { name: "Archive Workspace", exact: true });
        await expect(dialog).toBeVisible();
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(dialog).toHaveCount(0);
        const base = `/api/v1/workspaces/${workspaceId}`;
        expect((await (await page.request.get(base)).json()).data.archived).toBe(false);
        await expect(page).toHaveURL(entry);
        await archive.click();
        const result = page.waitForResponse(
            (response) => response.url().endsWith(base) && response.request().method() === "DELETE",
        );
        await dialog.getByRole("button", { name: "Archive Workspace", exact: true }).click();
        const confirmed = await result;
        expect(confirmed.status()).toBe(200);
        expect(await confirmed.request().headerValue("x-veriq-agent-form")).toMatch(/^[a-f\d-]{36}$/i);
        expect((await (await page.request.get(base)).json()).data.archived).toBe(true);
        await expect(page).toHaveURL(entry);
        expect(calls()).toBe(2);
    });
});

test("the sheet keeps its draft while an inline dataset opens its actual detail page and returns", async ({
    page,
    baseURL,
}) => {
    await conversationForm(
        page,
        baseURL,
        "HTTP_DATASET",
        async ({ workspaceId, headers }) => {
            const entry = page.url();
            const document = {
                schemaVersion: "2.0",
                shape: "TABLE",
                fields: { title: { type: "string", required: true, nullable: false } },
                source: { kind: "STATIC", rows: [{ key: "one", values: { title: "Pinned row" } }] },
            };
            const seeded = await page.request.post(`/api/v1/workspaces/${workspaceId}/resources`, {
                headers,
                data: {
                    kind: "DATASET",
                    name: "Inline dataset",
                    key: "inline_dataset",
                    content: { kind: "DATASET", document },
                },
            });
            expect(seeded.status(), await seeded.text()).toBe(201);
            const sheet = page.getByRole("dialog", { name: "Test Agent", exact: true });
            const draft = sheet.getByRole("textbox", { name: "Message", exact: true });
            await draft.fill("Draft in the active drawer");
            await sheet.getByRole("button", { name: "Configure HTTP datasets", exact: true }).click();
            const panel = sheet.getByRole("region", { name: "Configure HTTP datasets", exact: true });
            const details = panel.getByRole("link", {
                name: "Details for Inline dataset (inline_dataset)",
                exact: true,
            });
            await details.click();
            await expect(panel.getByRole("heading", { name: "Inline dataset", exact: true })).toBeVisible();
            await expect(panel.getByRole("tablist", { name: "Dataset editor", exact: true })).toBeVisible();
            await panel.getByRole("link", { name: "Datasets", exact: true }).click();
            await expect(details).toBeVisible();
            await panel.getByRole("button", { name: "Close form", exact: true }).click();
            await expect(draft).toHaveValue("Draft in the active drawer");
            await expect(page).toHaveURL(entry);
        },
        true,
    );
});

test("an inline notification resolves its private detail without replacing the current chat", async ({
    page,
    baseURL,
}) => {
    await conversationForm(page, baseURL, "NOTIFICATION_INBOX", async ({ workspaceId, headers }) => {
        const entry = page.url();
        const draft = page.getByRole("textbox", { name: "Message", exact: true });
        const card = page.getByRole("button", { name: "View my notifications", exact: true });
        await expect(card).toBeVisible();
        await draft.fill("Keep this pending reply");
        // 未展示的第二个私有会话产生真实延迟投递。当前屏幕上可见的回复会按产品规则主动确认并取消投递。
        const sessions = `/api/v1/workspaces/${workspaceId}/agent/sessions`;
        const created = await page.request.post(sessions, { headers, data: { title: "Unopened notification target" } });
        expect(created.status(), await created.text()).toBe(201);
        const sessionId = (await created.json()).data.id;
        const reply = await page.request.post(`${sessions}/${sessionId}/turns/stream`, {
            headers,
            data: { requestId: randomUUID(), text: "Prepare a private inbox notice" },
        });
        expect(reply.status(), await reply.text()).toBe(200);
        async function inboxNotice() {
            const list = await page.request.get("/api/v1/notifications");
            expect(list.status()).toBe(200);
            return (await list.json()).data.items.find(
                (row: { sessionId?: string; kind: string }) =>
                    row.kind === "AGENT_REPLY" && row.sessionId === sessionId,
            );
        }
        await expect.poll(inboxNotice).toBeTruthy();
        const notice = await inboxNotice();
        await card.click();
        const panel = page.getByRole("region", { name: "View my notifications", exact: true });
        const read = page.waitForResponse(
            (response) =>
                response.request().method() === "POST" && response.url().endsWith(`/notifications/${notice.id}/read`),
        );
        await panel
            .getByRole("row")
            .filter({ hasText: notice.sessionTitle })
            .getByRole("button", { name: "View", exact: true })
            .click();
        expect((await read).status()).toBe(200);
        const detail = panel.getByRole("region", { name: "Notification details", exact: true });
        await expect(detail).toContainText(notice.preview);
        await expect(detail.getByRole("button", { name: "View", exact: true })).toHaveCount(0);
        await detail.getByRole("link", { name: "Back to notifications", exact: true }).click();
        await expect(detail).toHaveCount(0);
        await panel.getByRole("button", { name: "Close form", exact: true }).click();
        await expect(draft).toHaveValue("Keep this pending reply");
        await expect(page).toHaveURL(entry);
    });
});

test("a separate browser signs in at the verified form URL and continues in its own session", async ({
    page,
    browser,
    baseURL,
}) => {
    await installed(page, baseURL);
    const { workspaceId } = await editorScope(page, "workspace-form-browser-login");
    const browserProfile = await browser.newContext({ baseURL });
    try {
        const external = await browserProfile.newPage();
        const path = `/workspaces?tab=members&workspaceId=${workspaceId}&fromAgentForm=1`;
        await external.goto(path);
        await expect(external.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
        expect(new URL(external.url()).pathname).toBe("/workspaces");
        await external.getByRole("textbox", { name: "Email" }).fill("browser-admin@example.com");
        await external.getByLabel("Password").fill("Browser password 123!");
        await external.getByRole("button", { name: "Sign in", exact: true }).click();
        await expect(external.getByRole("tabpanel", { name: "Members", exact: true })).toBeVisible();
        expect(new URL(external.url()).pathname + new URL(external.url()).search).toBe(path);
    } finally {
        await browserProfile.close();
    }
});

test("desktop card mounting and revoked clicks never invoke the browser bridge", async ({ page }) => {
    await page.goto("/tests/workspace-form-bridge-fixture.html");
    const open = page.locator("#root button");
    await expect(open).toHaveText(/browser|浏览器/i);
    await expect(page.locator("#checks")).toHaveText("0");
    await expect(page.locator("#launches")).toHaveText("[]");
    await open.click();
    await expect(page.locator("#checks")).toHaveText("1");
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.locator("#launches")).toHaveText("[]");
    await page.getByLabel("Allow the next authorization").check();
    await open.click();
    await expect(page.locator("#checks")).toHaveText("2");
    await expect(page.locator("#launches")).toHaveText(
        JSON.stringify([
            {
                workspaceId: "22222222-2222-4222-8222-222222222222",
                sessionId: "33333333-3333-4333-8333-333333333333",
                turnId: "44444444-4444-4444-8444-444444444444",
                capability: "AUTH_CREDENTIALS",
            },
        ]),
    );
});
