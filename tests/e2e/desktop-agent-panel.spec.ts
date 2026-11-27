/**
 * 在打包的桌面渲染器中复核十四种原生表单与聊天共存；仅用确定性的 preload 边界提供账户、会话和业务响应。
 */
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { components } from "../../packages/contracts/src/api.generated";
import type { DesktopState } from "../../apps/desktop/src/shared/bridge";
import type { CloudOperation } from "../../apps/desktop/src/shared/operations.generated";
import { expect, test } from "../../apps/desktop/tests/fixtures";

type Schemas = components["schemas"];
const management = [
    { kind: "AUTH_CREDENTIALS", label: "Manage identities and credential versions", read: "listCredentials" },
    { kind: "DEVICE_ACCESS", label: "Manage device approval and sharing", read: "listRuntimes" },
    { kind: "DEVICE_CREDENTIAL_DELIVERY", label: "Review device credential delivery", read: "listRuntimes" },
    { kind: "CI_PLAN_TOKENS", label: "Manage CI service accounts and plan tokens", read: "listServiceAccounts" },
    { kind: "WORKSPACE_MEMBERS", label: "Manage workspace members and roles", read: "listMembers" },
    { kind: "AI_PROVIDERS", label: "Manage model providers and budgets", read: "listProviders" },
    { kind: "NOTIFICATION_INBOX", label: "View my notifications", read: "listNotifications" },
    { kind: "WORKSPACE_ARCHIVE", label: "Review workspace archive settings", read: "getWorkspace" },
] as const;

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
        ...management.map(({ kind }) => kind),
    ] satisfies Schemas["AgentWorkspaceCapability"][];
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    const sessionId = "22222222-2222-4222-8222-222222222222";
    const unexpectedOrigins = new Set<string>();
    await page.context().route("**/*", async (route) => {
        unexpectedOrigins.add(new URL(route.request().url()).origin);
        await route.abort();
    });
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
            const user = {
                id: "44444444-4444-4444-8444-444444444444",
                displayName: "Employee",
                email: "owner@example.test",
                disabled: false,
                createdAt,
            } satisfies Schemas["UserDTO"];
            const account = { ...user, systemAdmin: true } satisfies Schemas["AdminUserDTO"];
            const workspace = {
                id: workspaceId,
                name: "Inline workspace",
                key: "one",
                role: "OWNER",
                archived: false,
                createdAt,
            } satisfies Schemas["WorkspaceDTO"];
            const session = {
                id: sessionId,
                workspaceId,
                title: "Inline fixture conversation",
                createdAt,
                archived: false,
            };
            const turns = capabilities.map((capability, n): Schemas["AgentTurnDTO"] => ({
                id: `33333333-3333-4333-8333-${String(n).padStart(12, "3")}`,
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
                user: { user, expiresAt: "2099-01-01T00:00:00Z" },
                tray: false,
                agent: {
                    pid: 1,
                    node: "24",
                    online: false,
                    active: null,
                    headedAvailable: false,
                    bundles: [],
                    history: [],
                    workspaceId,
                    browser: { available: true, source: "fixture" },
                },
            };
            const calls: CloudOperation[] = [];
            const browserCalls: string[] = [];
            Object.defineProperty(window, "nativeFormAccount", { value: account });
            const runtime: Schemas["RuntimeDTO"] = {
                id: "88888888-8888-4888-8888-888888888888",
                ownerId: user.id,
                name: "Managed browser device",
                location: "CONNECTED_LOCAL",
                trustStatus: "MANAGED",
                status: "ONLINE",
                workspaceId,
                capabilities: { engineVersion: "1.0.0", os: "linux", arch: "x64", browsers: ["chromium"] },
                ownerType: "USER",
                capabilitiesSource: "DEVICE_REPORTED",
                sharedWithWorkspace: true,
                sharedWithUserIds: [],
                allowCredentialDelivery: false,
                canManage: true,
            };
            const serviceAccounts: Schemas["ServiceAccountDTO"][] = [];
            Object.defineProperty(window, "managementBrowserCalls", { value: browserCalls });
            Object.defineProperty(window, "nativeFormCalls", { value: calls });
            Object.defineProperty(window, "nativeFormWorkspace", { value: workspace });
            Object.defineProperty(window, "nativeFormAgent", { value: state.agent });
            function response(input: CloudOperation) {
                calls.push(structuredClone(input));
                switch (input.operation) {
                    case "getAccount":
                        return account;
                    case "getWorkspace":
                        return workspace;
                    case "listRuntimes":
                        return { items: [runtime], nextCursor: null };
                    case "updateRuntimeCredentialDelivery":
                        runtime.allowCredentialDelivery = input.data.allowCredentialDelivery;
                        return runtime;
                    case "listNotifications":
                        return {
                            items: [],
                            unreadCount: 0,
                            readThrough: "0",
                        } satisfies Schemas["NotificationInboxDTO"];
                    case "listServiceAccounts":
                        return { items: serviceAccounts, nextCursor: null };
                    case "createServiceAccount": {
                        const saved = {
                            id: "66666666-6666-4666-8666-666666666666",
                            workspaceId,
                            name: input.data.name,
                            disabled: false,
                        };
                        serviceAccounts.push(saved);
                        const origin = turns.find((turn) => turn.id === input.agentFormTurnId);
                        if (origin?.workspaceForm?.capability === "CI_PLAN_TOKENS") {
                            origin.workspaceFormReceipts = [
                                {
                                    id: "77777777-7777-4777-8777-777777777777",
                                    targetId: saved.id,
                                    action: "service_account.created",
                                    capability: "CI_PLAN_TOKENS",
                                    createdAt,
                                },
                            ];
                        }
                        return saved;
                    }
                    case "getAgentSettings":
                        return {
                            defaultProviderId: null,
                            agentProviderId: null,
                            providerStatus: "READY",
                            resolvedProviderId: "99999999-9999-4999-8999-999999999999",
                        } satisfies Schemas["AgentSettingsDTO"];
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
                            items: [{ id: "entry", createdAt, action: "agent.form.fixture", targetId: workspaceId }],
                        };
                    case "listAgentTasks":
                        return {
                            items: [
                                {
                                    id: "aaaa0000-0000-4000-8000-000000000000",
                                    runId: workspaceId,
                                    mode: "MANUAL",
                                    state: "FOLLOWING",
                                },
                            ],
                        };
                    default:
                        return { items: [], nextCursor: null };
                }
            }
            Object.defineProperty(window, "veriq", {
                value: {
                    state: async () => structuredClone(state) satisfies DesktopState,
                    prepareAgentWebForm: async () => {
                        browserCalls.push("prepare");
                        throw new Error("Unexpected external form");
                    },
                    openAgentWebForm: async () => {
                        browserCalls.push("open");
                        throw new Error("Unexpected external form");
                    },
                    streamOpen: async () => "fixture-stream",
                    streamPull: async () => ({ done: true }),
                    streamClose: async () => {},
                    cloud: async (input: CloudOperation) => structuredClone(response(input)),
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
        ...management.map(({ label }) => label),
    ];
    const tasks = page.getByRole("region", { name: "Background tasks" });
    for (const [index, label] of labels.entries()) {
        const source = page.getByRole("button", { name: label, exact: true });
        const feature = management[index - 6];
        const callsBefore = await page.evaluate(() => Reflect.get(window, "nativeFormCalls").length as number);
        if (feature?.kind === "AUTH_CREDENTIALS") {
            await page.evaluate(() => {
                Reflect.get(window, "nativeFormAccount").disabled = true;
            });
            await source.click();
            const blocked = page.getByRole("complementary", { name: label, exact: true });
            await expect(blocked.getByRole("alert")).toHaveText("Unable to verify the current employee.");
            const reads = await page.evaluate(
                (start) =>
                    Reflect.get(window, "nativeFormCalls")
                        .slice(start)
                        .map((call: CloudOperation) => call.operation),
                callsBefore,
            );
            expect(reads).toContain("getAccount");
            expect(reads).not.toContain("listCredentials");
            expect(reads).not.toContain("getWorkspace");
            await blocked.getByRole("button", { name: "Close form" }).click();
            await page.evaluate(() => {
                Reflect.get(window, "nativeFormAccount").disabled = false;
            });
        }
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
        if (feature) {
            await expect
                .poll(() =>
                    page.evaluate(
                        ({ read, start }) =>
                            Reflect.get(window, "nativeFormCalls")
                                .slice(start)
                                .some((call: CloudOperation) => call.operation === read),
                        { read: feature.read, start: callsBefore },
                    ),
                )
                .toBe(true);
            switch (feature.kind) {
                case "AUTH_CREDENTIALS":
                    await expect(form.getByRole("tab", { name: "Credential versions" })).toBeVisible();
                    break;
                case "DEVICE_ACCESS":
                    await expect(form.getByRole("heading", { name: "Approve a device" })).toBeVisible();
                    await expect(form.getByRole("heading", { name: "Managed browser device" })).toBeVisible();
                    await expect(form.getByRole("heading", { name: "Workspace credential delivery" })).toHaveCount(0);
                    break;
                case "DEVICE_CREDENTIAL_DELIVERY":
                    await expect(form.getByRole("heading", { name: "Workspace credential delivery" })).toBeVisible();
                    await expect(form.getByRole("heading", { name: "Approve a device" })).toHaveCount(0);
                    await form.getByRole("checkbox", { name: "Allow platform credential delivery" }).check();
                    await form.getByRole("button", { name: "Save credential delivery" }).click();
                    await expect
                        .poll(() =>
                            page.evaluate(() =>
                                Reflect.get(window, "nativeFormCalls").find(
                                    (call: CloudOperation) => call.operation === "updateRuntimeCredentialDelivery",
                                ),
                            ),
                        )
                        .toMatchObject({
                            params: { workspaceId, runtimeId: "88888888-8888-4888-8888-888888888888" },
                            data: { allowCredentialDelivery: true },
                            agentFormTurnId: `33333333-3333-4333-8333-${String(index).padStart(12, "3")}`,
                        });
                    await page
                        .getByRole("dialog", { name: "Operation succeeded" })
                        .getByRole("button", { name: "OK" })
                        .click();
                    break;
                case "WORKSPACE_MEMBERS":
                    await expect(form.getByRole("heading", { name: "Invitations", exact: true })).toBeVisible();
                    break;
                case "AI_PROVIDERS":
                    await expect(form.getByRole("button", { name: "New provider", exact: true })).toBeVisible();
                    break;
                case "NOTIFICATION_INBOX":
                    await expect(form.getByRole("heading", { name: "Notifications", exact: true })).toBeVisible();
                    break;
                case "WORKSPACE_ARCHIVE":
                    await expect(form.getByRole("button", { name: "Archive Workspace", exact: true })).toBeVisible();
                    break;
            }
            if (feature.kind === "CI_PLAN_TOKENS") {
                await form.getByRole("textbox", { name: "Service account name" }).fill("Release checks");
                await form.getByRole("button", { name: "Create account", exact: true }).click();
                await expect
                    .poll(() =>
                        page.evaluate(() =>
                            Reflect.get(window, "nativeFormCalls").find(
                                (call: CloudOperation) => call.operation === "createServiceAccount",
                            ),
                        ),
                    )
                    .toMatchObject({
                        params: { workspaceId },
                        data: { name: "Release checks" },
                        agentFormTurnId: `33333333-3333-4333-8333-${String(index).padStart(12, "3")}`,
                    });
                await page
                    .getByRole("dialog", { name: "Operation succeeded" })
                    .getByRole("button", { name: "OK" })
                    .click();
            }
        }
        await form.getByRole("button", { name: "Close form" }).click();
        await expect(form).toHaveCount(0);
        await expect(draft).toHaveValue("Keep this unsent draft.");
        await expect(source).toBeFocused();
        if (feature?.kind === "CI_PLAN_TOKENS") {
            const receipt = page.getByRole("region", { name: "Confirmed form operations" });
            await expect(receipt).toContainText("Service account created");
            await receipt.getByText("Operation details", { exact: true }).click();
            await expect(receipt).toContainText("66666666-6666-4666-8666-666666666666");
        }
    }
    expect(await page.evaluate(() => Reflect.get(window, "managementBrowserCalls"))).toEqual([]);
    const last = page.getByRole("button", { name: "Manage CI service accounts and plan tokens", exact: true });
    await last.click();
    const managementForm = page.getByRole("complementary", {
        name: "Manage CI service accounts and plan tokens",
        exact: true,
    });
    await expect(managementForm.getByRole("textbox", { name: "Service account name" })).toBeVisible();
    await page.evaluate(() => {
        Reflect.get(window, "nativeFormWorkspace").id = "55555555-5555-4555-8555-555555555555";
    });
    await expect(managementForm).toHaveCount(0);
    const reads = await page.evaluate(() =>
        Reflect.get(window, "nativeFormCalls")
            .filter((op: { operation: string }) => op.operation === "getAgentWorkspaceForm")
            .map((op: { params: Record<string, string> }) => op.params),
    );
    expect(reads).toHaveLength(capabilities.length + 2);
    for (const ref of reads) expect(ref).toMatchObject({ workspaceId, sessionId });
    expect(unexpectedOrigins.size).toBe(0);
    expect(page.context().pages()).toHaveLength(1);
});
