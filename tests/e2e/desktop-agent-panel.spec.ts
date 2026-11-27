/**
 * 在打包的桌面渲染器中复核六种原生表单与聊天共存；仅用确定性的 preload 边界提供账户、会话和业务响应。
 */
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { expect, test } from "../../apps/desktop/tests/fixtures";

test("the native agent forms keep the private conversation and draft mounted", async ({ page }) => {
    const assets = resolve("out/renderer");
    page.setDefaultTimeout(10_000);
    const capabilities = [
        "ENVIRONMENT",
        "FIXTURE",
        "HTTP_DATASET",
        "REPORT_EVIDENCE",
        "WORKSPACE_AUDIT",
        "LOCAL_RETENTION",
    ];
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    const sessionId = "22222222-2222-4222-8222-222222222222";
    await page.route("https://desktop-component.invalid/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        const file = resolve(assets, `.${path === "/" ? "/index.html" : path}`);
        if (!file.startsWith(`${assets}${sep}`)) return route.abort();
        const mime: Record<string, string> = {
            ".js": "text/javascript",
            ".css": "text/css",
            ".svg": "image/svg+xml",
            ".html": "text/html",
        };
        await route.fulfill({
            contentType: mime[extname(file)] ?? "application/octet-stream",
            body: await readFile(file),
        });
    });
    await page.addInitScript(
        ({ workspaceId, sessionId, capabilities }) => {
            localStorage.setItem("veriq.language", "en");
            const createdAt = "2026-11-26T00:00:00Z";
            const workspace = {
                id: workspaceId,
                name: "Inline workspace",
                key: "one",
                role: "OWNER",
                archived: false,
                createdAt,
            };
            const session = {
                id: sessionId,
                workspaceId,
                title: "Inline fixture conversation",
                createdAt,
                archived: false,
            };
            const turns = capabilities.map((capability, n) => ({
                id: `33333333-3333-4333-8333-33333333333${n}`,
                text: `Review ${capability}`,
                reply: "Review the form.",
                status: "COMPLETED",
                createdAt,
                workspaceForm: { type: "OPEN_WORKSPACE_FORM", workspaceId, capability },
            }));
            const state = {
                origin: "https://platform.invalid",
                version: "component-fixture",
                workspace,
                user: { user: { id: "44444444-4444-4444-8444-444444444444", displayName: "Employee" } },
                agent: {
                    pid: 1,
                    node: "24",
                    online: false,
                    bundles: [],
                    history: [],
                    workspaceId,
                    browser: { available: true, source: "fixture" },
                },
            };
            const calls: { operation: string; params?: Record<string, string>; query?: Record<string, unknown> }[] = [];
            Object.defineProperty(window, "nativeFormCalls", { value: calls });
            Object.defineProperty(window, "nativeFormWorkspace", { value: workspace });
            Object.defineProperty(window, "nativeFormAgent", { value: state.agent });
            Object.defineProperty(window, "veriq", {
                value: {
                    state: async () => structuredClone(state),
                    cloud: async (input: (typeof calls)[number]) => {
                        calls.push(input);
                        switch (input.operation) {
                            case "getAgentSettings":
                                return { providerStatus: "READY", resolvedProviderId: "model" };
                            case "listAgentSessions":
                                return { items: input.query?.archived ? [] : [session] };
                            case "getAgentSession":
                                return session;
                            case "listAgentTurns":
                                return { items: turns };
                            case "getAgentWorkspaceForm":
                                return turns.find((t) => t.id === input.params?.turnId)?.workspaceForm;
                            case "createResource":
                                throw new Error("RESOURCE_KEY_CONFLICT");
                            case "getWorkspaceAudit":
                                return {
                                    items: [
                                        { id: "entry", createdAt, action: "agent.form.fixture", targetId: workspaceId },
                                    ],
                                };
                            case "listAgentTasks":
                                return {
                                    items: [{ id: "task", runId: workspaceId, mode: "MANUAL", state: "FOLLOWING" }],
                                };
                            default:
                                return { items: [] };
                        }
                    },
                },
            });
        },
        { workspaceId, sessionId, capabilities },
    );
    await page.goto("https://desktop-component.invalid/");
    await page.getByRole("button", { name: /^(Test Agent|测试 Agent)$/ }).click();
    await page.getByRole("button", { name: "Choose a conversation" }).click();
    await page.getByRole("menuitemradio", { name: /Inline fixture conversation/ }).click();
    const draft = page.getByRole("textbox", { name: /^(Message|消息)$/ });
    await draft.fill("Keep this unsent draft.");
    const labels = [
        "Configure execution environments",
        "Edit test fixtures",
        "Configure HTTP datasets",
        "Review report evidence downloads",
        "View workspace audit records",
        "Review this device’s retention settings",
    ];
    const tasks = page.getByRole("region", { name: "Background tasks" });
    for (const [index, label] of labels.entries()) {
        const source = page.getByRole("button", { name: label, exact: true });
        await source.click();
        const form = page.getByRole("complementary", { name: label, exact: true });
        await expect(form).toBeVisible();
        await expect(draft).toHaveValue("Keep this unsent draft.");
        await expect(tasks).toBeVisible();
        if (index < 3) {
            const kind = ["ENVIRONMENT", "FIXTURE", "DATASET"][index];
            await expect
                .poll(() =>
                    page.evaluate(
                        (kind) =>
                            Reflect.get(window, "nativeFormCalls").some(
                                (op: { operation: string; query?: { kind?: string } }) =>
                                    op.operation === "listResources" && op.query?.kind === kind,
                            ),
                        kind,
                    ),
                )
                .toBe(true);
        }
        if (index === 1) {
            await form.getByRole("textbox", { name: "Key", exact: true }).fill("duplicate_fixture");
            await form.getByRole("textbox", { name: "Name", exact: true }).fill("Duplicate fixture");
            await form.getByRole("button", { name: "Create resource", exact: true }).click();
            await expect
                .poll(() =>
                    page.evaluate(() =>
                        Reflect.get(window, "nativeFormCalls").find(
                            (op: { operation: string }) => op.operation === "createResource",
                        ),
                    ),
                )
                .toMatchObject({
                    params: { workspaceId },
                    agentFormTurnId: "33333333-3333-4333-8333-333333333331",
                    data: { kind: "FIXTURE", key: "duplicate_fixture" },
                });
            const failure = page.getByRole("dialog", { name: "Operation failed" });
            await expect(failure).toContainText("RESOURCE_KEY_CONFLICT");
            await failure.getByRole("button", { name: "OK" }).click();
        }
        if (index === 2) {
            await form.getByRole("combobox", { name: /Dataset format/ }).click();
            await page.getByRole("option", { name: "HTTP table" }).click();
            await expect(form.getByRole("combobox", { name: /Dataset format/ })).toContainText("HTTP table");
        }
        if (index === 3) await expect(form.getByRole("heading", { name: /history/i }).first()).toBeVisible();
        if (index === 4) await expect(form.getByText(/agent\.form\.fixture/)).toBeVisible();
        if (index === 5) {
            await expect(form.getByRole("spinbutton").first()).toBeEnabled();
            await page.evaluate(() => Reflect.deleteProperty(Reflect.get(window, "nativeFormAgent"), "workspaceId"));
            await expect(form.getByRole("status")).toContainText("Select this workspace in the local Agent");
            await expect(form.getByRole("spinbutton")).toHaveCount(0);
        }
        await form.getByRole("button", { name: "Close form" }).click();
        await expect(form).toHaveCount(0);
        await expect(draft).toHaveValue("Keep this unsent draft.");
        await expect(source).toBeFocused();
    }
    const last = page.getByRole("button", { name: labels[0], exact: true });
    await last.click();
    await page.evaluate(() => {
        Reflect.get(window, "nativeFormWorkspace").id = "55555555-5555-4555-8555-555555555555";
    });
    await expect(page.getByRole("complementary", { name: labels[0], exact: true })).toHaveCount(0);
    const reads = await page.evaluate(() =>
        Reflect.get(window, "nativeFormCalls")
            .filter((op: { operation: string }) => op.operation === "getAgentWorkspaceForm")
            .map((op: { params: Record<string, string> }) => op.params),
    );
    expect(reads).toHaveLength(7);
    for (const ref of reads) expect(ref).toMatchObject({ workspaceId, sessionId });
});
