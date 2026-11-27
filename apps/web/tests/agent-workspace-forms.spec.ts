/**
 * Chromium 通过正常对话取得表单卡，核对点击时的员工轮次请求和业务表单导航，再用归档证明旧的入口仍需授权。
 */
import { createServer } from "node:http";
import { expect, test } from "@playwright/test";
import { editorScope } from "./editor-fixture";
import { installed } from "./support/install-console";

test("a saved form opens its authorized workspace and loses access when that workspace is archived", async ({
    page,
    baseURL,
}) => {
    const port = Number(process.env.VERIQ_TEST_MODEL_PORT ?? "18890");
    let calls = 0;
    const model = createServer(async (request, response) => {
        const buffers: Buffer[] = [];
        for await (const chunk of request) buffers.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(buffers).toString()) as {
            stream?: boolean;
            messages: { role: string }[];
        };
        calls++;
        const first = !body.messages.some((message) => message.role === "tool");
        const delta = first
            ? {
                  tool_calls: [
                      {
                          index: 0,
                          id: "environment_form",
                          type: "function",
                          function: {
                              name: "open_workspace_form_v1",
                              arguments: JSON.stringify({ capability: "ENVIRONMENT" }),
                          },
                      },
                  ],
              }
            : { content: "Review the environment form." };
        if (!body.stream) {
            response.writeHead(400).end();
            return;
        }
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        const event = {
            id: "form-test",
            object: "chat.completion.chunk",
            created: 0,
            model: "form-model",
            choices: [{ index: 0, delta, finish_reason: first ? "tool_calls" : "stop" }],
            usage: { prompt_tokens: 50, completion_tokens: 25, total_tokens: 75 },
        };
        response.end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
    });
    await new Promise<void>((resolve, reject) => {
        model.once("error", reject);
        model.listen(port, "127.0.0.1", resolve);
    });
    try {
        await installed(page, baseURL);
        const { workspaceId, headers } = await editorScope(page, "workspace-form-cards", "/agent");
        const base = `/api/v1/workspaces/${workspaceId}`;
        const created = await page.request.post(`${base}/ai/providers`, {
            headers,
            data: {
                name: "Form test",
                adapter: "OPENAI_COMPATIBLE",
                model: "form-model",
                baseURL: `http://127.0.0.1:${port}/v1`,
                apiKey: "local-form-test-key",
                enabled: true,
                monthlyBudgetUsd: 1,
                inputUsdPerMillion: 1,
                outputUsdPerMillion: 2,
                maxOutputTokens: 1024,
                maxRequestUsd: 1,
            },
        });
        expect(created.status(), await created.text()).toBe(201);
        const settings = await page.request.put(`${base}/agent/settings`, {
            headers,
            data: { defaultProviderId: (await created.json()).data.id, agentProviderId: null },
        });
        expect(settings.status(), await settings.text()).toBe(200);
        await page.reload();
        await page.getByRole("button", { name: "New conversation", exact: true }).click();
        await page
            .getByRole("textbox", { name: "Message", exact: true })
            .fill("Open my workspace environment configuration form.");
        await page.getByRole("button", { name: "Send", exact: true }).click();
        const card = page.getByRole("button", { name: "Configure execution environments", exact: true });
        await expect(card).toBeVisible();
        const verified = page.waitForResponse((response) => response.url().endsWith("/workspace-form"));
        await card.click();
        const verification = await verified;
        expect(verification.request().method()).toBe("GET");
        expect(verification.status()).toBe(200);
        await expect(page).toHaveURL(
            new RegExp(`/resources/environments\\?workspaceId=${workspaceId}&fromAgentForm=1$`),
        );
        await expect(page.getByRole("heading", { name: "Execution environments", exact: true }).first()).toBeVisible();
        await page.reload();
        await expect(page.getByRole("heading", { name: "Execution environments", exact: true }).first()).toBeVisible();
        expect((await page.request.delete(base, { headers })).status()).toBe(200);
        const closed = await page.request.get(verification.url());
        expect(closed.status(), await closed.text()).toBe(409);
        expect((await closed.json()).code).toBe("WORKSPACE_ARCHIVED");
        expect(calls).toBe(2);
    } finally {
        await new Promise<void>((resolve, reject) => model.close((error) => (error ? reject(error) : resolve())));
    }
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
