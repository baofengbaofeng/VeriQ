/**
 * 从真实浏览器使用附件、标题和资源确认，供应商只替换为本机协议服务，所有业务状态由控制服务保存。
 */
import { createServer } from "node:http";
import { expect, test } from "@playwright/test";
import { editorScope } from "./editor-fixture";
import { chooseWorkspace } from "./support/console-controls";
import { installed } from "./support/install-console";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGO4t3YfAAS2Ako5Hvp4AAAAAElFTkSuQmCC";
const notes = "Checkout configuration input: coverage-only-example";

type ModelRequest = {
    stream?: boolean;
    tools?: { function: { name: string } }[];
    messages: { role: string; content: unknown }[];
};

/**
 * 在官方兼容协议中使用真实工具增量；工具结果会由控制服务追加到下一次请求后再返回最终聊天文本。
 */
async function startModel(port: number) {
    const requests: ModelRequest[] = [];
    const dataset = {
        kind: "DATASET",
        key: "agent-checkout",
        name: "Checkout data",
        content: {
            kind: "DATASET",
            document: {
                schemaVersion: "2.0",
                shape: "TABLE",
                fields: { tier: { type: "string", required: true, nullable: false } },
                source: { kind: "STATIC", rows: [{ key: "standard", values: { tier: "standard" } }] },
            },
        },
    };
    const replies = [
        { content: "I received the requirements and image." },
        {
            tool_calls: [
                {
                    index: 0,
                    id: "fixture_resource_draft",
                    type: "function",
                    function: {
                        name: "prepare_resource_draft_v1",
                        arguments: JSON.stringify({ proposal: { type: "SAVE_RESOURCE_DRAFT", resource: dataset } }),
                    },
                },
            ],
        },
        { content: "The checkout dataset is ready to review." },
        { content: "Billing is a separate test topic." },
    ];
    const server = createServer(async (request, response) => {
        const buffers: Buffer[] = [];
        for await (const chunk of request) buffers.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(buffers).toString()) as ModelRequest;
        const delta = replies[requests.length];
        requests.push(body);
        if (!body.stream || !delta) {
            response.writeHead(500).end();
            return;
        }
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        const output = {
            id: "agent_workflow_fixture",
            object: "chat.completion.chunk",
            created: 0,
            model: "workflow-emulator",
            choices: [{ index: 0, delta, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }],
            usage: { prompt_tokens: 60, completion_tokens: 40, total_tokens: 100 },
        };
        response.end(`data: ${JSON.stringify(output)}\n\ndata: [DONE]\n\n`);
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
    });
    return { server, requests };
}

test("Test Agent sends files, keeps manual titles, and applies a draft only after review", async ({
    page,
    baseURL,
}) => {
    const port = Number(process.env.VERIQ_TEST_MODEL_PORT ?? "18890");
    const { server, requests } = await startModel(port);
    try {
        await installed(page, baseURL);
        const { workspaceId, headers } = await editorScope(page, "agent-workflow");
        const base = `/api/v1/workspaces/${workspaceId}`;
        const provider = await page.request.post(`${base}/ai/providers`, {
            headers,
            data: {
                name: "Workflow emulator",
                adapter: "OPENAI_COMPATIBLE",
                baseURL: `http://127.0.0.1:${port}/v1`,
                model: "workflow-emulator",
                apiKey: "synthetic-workflow-model-key",
                enabled: true,
                supportsImages: true,
                monthlyBudgetUsd: 1,
                inputUsdPerMillion: 1,
                outputUsdPerMillion: 2,
                maxOutputTokens: 1024,
                maxRequestUsd: 1,
            },
        });
        expect(provider.status(), await provider.text()).toBe(201);
        const providerId = (await provider.json()).data.id;
        const settings = await page.request.put(`${base}/agent/settings`, {
            headers,
            data: { defaultProviderId: providerId, agentProviderId: null },
        });
        expect(settings.status(), await settings.text()).toBe(200);
        await page.goto("/agent");
        await chooseWorkspace(page, workspaceId);
        await page.getByRole("button", { name: "New conversation", exact: true }).click();

        const choose = page.waitForEvent("filechooser");
        await page.getByRole("button", { name: "Add attachments", exact: true }).click();
        await (
            await choose
        ).setFiles([
            { name: "requirements.md", mimeType: "text/markdown", buffer: Buffer.from(notes) },
            { name: "diagram.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") },
        ]);
        await expect(page.getByRole("list", { name: "Selected attachments", exact: true })).toContainText(
            "requirements.md",
        );
        const send = page.getByRole("button", { name: "Send", exact: true });
        await send.click();
        await expect(page.getByText("I received the requirements and image.")).toBeVisible();
        const uploaded = requests[0].messages[1].content;
        expect(uploaded).toEqual([
            { type: "text", text: expect.stringContaining(notes) },
            { type: "image_url", image_url: { url: `data:image/png;base64,${png}`, detail: "low" } },
        ]);
        await expect(page.getByRole("list", { name: "Attachments", exact: true })).toContainText("diagram.png");

        const message = page.getByLabel("Message", { exact: true });
        await message.fill("Configure checkout dataset");
        await send.click();
        await expect(page.getByText("The checkout dataset is ready to review.")).toBeVisible();
        await expect(page.getByRole("list", { name: "Tool activity" })).toContainText("Succeeded");
        expect(requests[1].tools?.map(({ function: tool }) => tool.name)).toContain("prepare_resource_draft_v1");
        expect(requests[2].messages.at(-1)?.role).toBe("tool");
        const sessions = (await (await page.request.get(`${base}/agent/sessions`)).json()).data.items;
        const session = `${base}/agent/sessions/${sessions[0].id}`;
        const autoTitle = page.getByRole("button", { name: /^Configure checkout dataset/ });
        await expect(autoTitle).toBeVisible();

        const preview = page.getByRole("region", { name: "Resource draft preview" });
        await expect(preview).toContainText("Checkout data");
        const resources = `${base}/resources?kind=DATASET`;
        expect((await (await page.request.get(resources)).json()).data.items).toHaveLength(0);
        await page.getByRole("button", { name: "Confirm save resource draft", exact: true }).click();
        await expect(page.getByRole("region", { name: "Resource draft saved", exact: true })).toBeVisible();
        const drafts = (await (await page.request.get(resources)).json()).data.items;
        expect(drafts).toHaveLength(1);
        expect(drafts[0]).toMatchObject({ key: "agent-checkout", kind: "DATASET" });
        expect(drafts[0].latestVersionId ?? null).toBeNull();

        await page.getByRole("button", { name: "Rename conversation", exact: true }).click();
        const rename = page.getByRole("dialog", { name: "Rename conversation", exact: true });
        await rename.getByLabel("Conversation title").fill("Reviewed checkout");
        await rename.getByRole("button", { name: "Save", exact: true }).click();
        await expect(rename).toBeHidden();
        await message.fill("Design billing retry tests");
        await send.click();
        await expect(page.getByText("Billing is a separate test topic.")).toBeVisible();
        // 增量已显示时结算仍可能进行，使用对应轮次的持久化终态作为验证标题的依据，避免依赖浏览器结束长连接。
        await expect
            .poll(async () => {
                const response = await page.request.get(`${session}/turns`);
                const data = (await response.json()).data.items as { text: string; status: string }[];
                return data.find(({ text }) => text === "Design billing retry tests")?.status;
            })
            .toBe("COMPLETED");
        const saved = (await (await page.request.get(session)).json()).data;
        expect(saved.title).toBe("Reviewed checkout");
        const history = await page.request.get(`${session}/turns`);
        expect(await history.text()).not.toContain(notes);
        expect(await history.text()).not.toContain(png);

        await page.reload();
        await chooseWorkspace(page, workspaceId);
        await page.getByRole("button", { name: "Choose a conversation", exact: true }).click();
        await page.getByRole("menuitemradio", { name: "Reviewed checkout", exact: true }).click();
        await expect(page.getByRole("list", { name: "Attachments", exact: true })).toContainText("requirements.md");
        await expect(page.getByRole("list", { name: "Tool activity" })).toContainText("Succeeded");
    } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
});
