/**
 * 在受控端口启动本地模型并准备真实员工工作区，供卡片从生成、重新授权到用户表单操作的跨层浏览器回归共享。
 */
import { createServer } from "node:http";
import { expect, type Page } from "@playwright/test";
import { editorScope } from "../editor-fixture";
import { chooseWorkspace } from "./console-controls";
import { installed } from "./install-console";

/**
 * 每个真实会话单独运行本地模型端点；返回固定能力的工具回合，表单、访问检查及写操作均走生产实现。
 */
export async function conversationForm(
    page: Page,
    baseURL: string | undefined,
    capability: string,
    run: (scope: Awaited<ReturnType<typeof editorScope>>, calls: () => number) => Promise<void>,
    sheet = false,
) {
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
                          id: "workspace_form",
                          type: "function",
                          function: {
                              name: "open_workspace_form_v1",
                              arguments: JSON.stringify({ capability }),
                          },
                      },
                  ],
              }
            : { content: "Review the workspace form." };
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
        const scope = await editorScope(
            page,
            `form-${capability.toLowerCase().replaceAll("_", "-")}`,
            sheet ? "/account" : "/agent",
        );
        const { workspaceId, headers } = scope;
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
        if (sheet) {
            await page.reload();
            await chooseWorkspace(page, workspaceId);
            await page.getByRole("button", { name: "Test Agent", exact: true }).click();
        } else await page.goto(`/agent?workspaceId=${workspaceId}`);
        await page.getByRole("button", { name: "New conversation", exact: true }).click();
        await page.getByRole("textbox", { name: "Message", exact: true }).fill("Open my workspace configuration form.");
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await run(scope, () => calls);
    } finally {
        await new Promise<void>((resolve, reject) => model.close((error) => (error ? reject(error) : resolve())));
    }
}
