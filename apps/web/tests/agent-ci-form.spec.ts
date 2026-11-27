/**
 * 通过真实模型卡片打开内嵌 CI 管理表单，验证一次账号创建只关联发起轮次，常规页面操作不会沿用该表单来源。
 */
import { expect, test } from "@playwright/test";
import type { PlatformComponents } from "@veriq/contracts";
import { conversationForm } from "./support/agent-conversation-form";

type Turn = PlatformComponents["schemas"]["AgentTurnDTO"];

test("CI plan account writes carry the reviewed turn only inside the conversation form", async ({ page, baseURL }) => {
    await conversationForm(page, baseURL, "CI_PLAN_TOKENS", async ({ workspaceId }) => {
        const name = "Manage CI service accounts and plan tokens";
        const card = page.getByRole("button", { name, exact: true });
        const verified = page.waitForResponse((response) => response.url().endsWith("/workspace-form"));
        await card.click();
        const verification = await verified;
        expect(verification.status()).toBe(200);
        const endpoint = new URL(verification.url()).pathname;
        const turnId = endpoint.split("/").at(-2)!;
        const turns = endpoint.slice(0, endpoint.lastIndexOf("/" + turnId));
        const collection = `/api/v1/workspaces/${workspaceId}/service-accounts`;
        const panel = page.getByRole("region", { name, exact: true });
        await panel.getByRole("textbox", { name: "Service account name", exact: true }).fill("Scoped CI account");
        const committed = page.waitForResponse(
            (response) => response.url().endsWith(collection) && response.request().method() === "POST",
        );
        await panel.getByRole("button", { name: "Create account", exact: true }).click();
        const response = await committed;
        expect(response.status()).toBe(201);
        expect(await response.request().headerValue("X-VeriQ-Agent-Form")).toBe(turnId);
        const account = (await response.json()).data.id;
        const history = await page.request.get(turns);
        expect(history.status()).toBe(200);
        const stored: Turn[] = (await history.json()).data.items;
        expect(stored.find((row) => row.id === turnId)?.workspaceFormReceipts).toMatchObject([
            { action: "service_account.created", targetId: account, capability: "CI_PLAN_TOKENS" },
        ]);

        await page.goto(`/execution-plans?workspaceId=${workspaceId}`);
        await page.getByRole("textbox", { name: "Service account name", exact: true }).fill("Ordinary CI account");
        const plain = page.waitForResponse(
            (reply) => reply.url().endsWith(collection) && reply.request().method() === "POST",
        );
        await page.getByRole("button", { name: "Create account", exact: true }).click();
        const ordinary = await plain;
        expect(ordinary.status()).toBe(201);
        expect(await ordinary.request().headerValue("X-VeriQ-Agent-Form")).toBeNull();
        const after: Turn[] = (await (await page.request.get(turns)).json()).data.items;
        expect(after.find((row) => row.id === turnId)?.workspaceFormReceipts).toHaveLength(1);
    });
});
