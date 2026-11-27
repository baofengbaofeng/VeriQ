import {
    chooseLanguage,
    chooseWorkspace,
    openWorkspaceMenu,
    workspaceOption,
    workspacePicker,
} from "./support/console-controls";
import { createHash, randomUUID } from "node:crypto";
import { test, expect, type Locator, type Page } from "@playwright/test";
import type { ResourceDocumentV1 } from "@veriq/contracts";
import { withCleanup } from "./support/case-profile-cleanup";
import { holdValidationReceipt } from "./support/hold-validation-receipt";
import {
    acknowledgeOperation,
    editorScope,
    closeResourceEditor,
    resourceCreateForm,
    openResourceCreateForm,
    selectResourceOption,
    createResource,
    saveDraft,
    applyDocument,
    managedCompiler,
    queueValidation,
    replaceEditorJson,
} from "./editor-fixture";
test.beforeEach(async ({ page }) => {
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
});

const rotationReferenceHint = "Choose the existing reference to update, for example employee_sso_login.";

/**
 * 凭证操作使用实际菜单交互切换，检查弹层外观并从其可访问选项选择，避免原生选择接口掩盖组件替换问题。
 */
async function chooseCredentialOperation(page: Page, choice: "Create reference" | "New version") {
    await page.getByRole("combobox", { name: "Operation", exact: true }).click();
    const choices = page.getByRole("listbox");
    await expect(choices).toHaveCSS("border-radius", "16px");
    await choices.getByRole("option", { name: choice, exact: true }).click();
}

/**
 * 在桌面宽度按浏览器实际位置核对左右控件等宽、等高且同排，右侧控件类型切换不应改变首行布局。
 */
async function expectCredentialTargetHalves(operation: Locator, reference: Locator) {
    const [left, right] = await Promise.all([operation.boundingBox(), reference.boundingBox()]);
    if (!left || !right) throw new Error("Expected both credential target controls to be visible");
    expect(right.x).toBeGreaterThan(left.x);
    expect(Math.abs(left.y - right.y)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(left.width - right.width)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(left.height - right.height)).toBeLessThanOrEqual(0.5);
}

test("resource forms save a canonical case and publish only after server-side validation", async ({
    page,
}, testInfo) => {
    test.setTimeout(180_000);
    const origin = "http://127.0.0.1:5173";
    const setup = (await (await page.request.get("/api/v1/setup")).json()).data;
    if (!setup.initialized) {
        const initialized = await page.request.post("/api/v1/setup", {
            headers: { Origin: origin, "X-CSRF-Token": setup.csrfToken },
            data: {
                installationSecret: "browser-operator-secret",
                email: "browser-admin@example.com",
                displayName: "Browser Administrator",
                password: "Browser password 123!",
            },
        });
        expect(initialized.status()).toBe(201);
    }
    await page.goto("/login");
    await page.getByRole("textbox", { name: "Email" }).fill("browser-admin@example.com");
    await page.getByLabel("Password").fill("Browser password 123!");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("dl")).toBeVisible();
    const session = (await (await page.request.get("/api/v1/auth/session")).json()).data;
    const response = await page.request.post("/api/v1/workspaces", {
        headers: { Origin: origin, "X-CSRF-Token": session.csrfToken },
        data: { key: "editor-browser", name: "Editor Browser" },
    });
    expect(response.status()).toBe(201);
    const workspace = (await response.json()).data;
    const compiler = await managedCompiler(page, { workspaceId: workspace.id });
    await withCleanup(async () => {
        await page.goto("/resources/element-catalogs");
        await expect(page.getByRole("heading", { name: "Element catalogs", exact: true })).toBeVisible();
        await chooseWorkspace(page, workspace.id);
        await expect(page.getByText("No resources in this Workspace.")).toBeVisible();
        await openResourceCreateForm(page, "ELEMENT_CATALOG");
        await resourceCreateForm(page).getByLabel("Key", { exact: true }).fill("catalog");
        await resourceCreateForm(page).getByLabel("Name", { exact: true }).fill("Browser catalog");
        await page.getByRole("button", { name: "Create resource" }).click();
        await acknowledgeOperation(page, "Resource created");
        await expect(page.getByRole("article")).toBeVisible();
        await page.getByRole("button", { name: "Save draft" }).click();
        await acknowledgeOperation(page, "Saved");
        const catalog = await compiler.publish();
        const metadataResponse = await page.request.get(
            `/api/v1/workspaces/${workspace.id}/resources/${catalog.resourceId}/versions/${catalog.id}` +
                `/compiled-source`,
        );
        expect(metadataResponse.status()).toBe(200);
        const metadata = (await metadataResponse.json()).data;
        expect(metadata.files.length).toBeGreaterThan(0);
        const file = metadata.files.find((f: { path: string }) => f.path.endsWith(".ts"));
        const sourceBase =
            `/api/v1/workspaces/${workspace.id}/resources/${catalog.resourceId}/versions/` +
            `${catalog.id}/compiled-source`;
        const exactResponse = await page.request.get(sourceBase, {
            params: { path: file.path },
        });
        expect(exactResponse.status()).toBe(200);
        const exact = await exactResponse.body();
        expect(exact.length).toBe(file.sizeBytes);
        expect(createHash("sha256").update(exact).digest("hex")).toBe(file.sha256);
        expect(exactResponse.headers()["content-type"]).toContain("text/plain");
        expect(exactResponse.headers()["x-content-type-options"]).toBe("nosniff");
        for (const path of ["package.json", "../../secrets", "trace.zip", "source/asset-snapshot.json"])
            expect((await page.request.get(sourceBase, { params: { path } })).status()).toBe(404);

        await expect(page.getByLabel("Retained file")).toBeVisible();
        await selectResourceOption(page.getByLabel("Retained file"), `${file.path} · ${file.sha256}`);
        await expect(
            page
                .getByRole("heading", { name: "Actual generated TypeScript (read only)" })
                .locator("..")
                .locator(".vq-monaco"),
        ).toBeVisible();
        await closeResourceEditor(page);
        await openResourceCreateForm(page, "CASE");
        await resourceCreateForm(page).getByLabel("Key", { exact: true }).fill("smoke");
        await resourceCreateForm(page).getByLabel("Name", { exact: true }).fill("Smoke case");
        await page.getByRole("button", { name: "Create resource" }).click();
        await acknowledgeOperation(page, "Resource created");
        await expect(page.getByLabel("Catalog version")).toBeVisible();
        await selectResourceOption(page.getByLabel("Catalog version"), new RegExp(` · ${catalog.id}$`));
        await page.getByRole("button", { name: "Add After assertions" }).click();
        await expect(
            page.getByRole("heading", { name: "After assertions" }).locator("..").getByLabel("Assertion type"),
        ).toHaveValue("ui");
        await page.getByRole("button", { name: "Save draft" }).click();
        await acknowledgeOperation(page, "Saved");
        expect(await page.locator('ul[role="alert"]').count()).toBe(0);
        const version = await compiler.publish();
        const files = (
            await (
                await page.request.get(
                    `/api/v1/workspaces/${workspace.id}/resources/${version.resourceId}/versions/${version.id}` +
                        `/compiled-source`,
                )
            ).json()
        ).data;
        const generated = files.files.find((f: { path: string }) => f.path.startsWith("cases/"));
        await expect(page.getByLabel("Retained file")).toBeVisible();
        await selectResourceOption(page.getByLabel("Retained file"), `${generated.path} · ${generated.sha256}`);
        await expect(
            page
                .getByRole("heading", { name: "Actual generated TypeScript (read only)" })
                .locator("..")
                .locator(".vq-monaco"),
        ).toContainText("registerCase");
        await page.setViewportSize({ width: 1280, height: 1000 });
        await page.screenshot({
            path: testInfo.outputPath("editor-1280.png"),
            fullPage: true,
        });
    }, compiler.close);
});

test("environment manager creates immutable auth and credential versions without echoing secrets", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const alpha = await editorScope(page, `identity-immutable-${randomUUID()}`);
    await page.goto("/workspaces?tab=auth-credentials");
    await chooseWorkspace(page, alpha.workspaceId);
    const manager = page.getByRole("tabpanel", { name: "Authentication and credentials", exact: true });
    await expect(manager).toBeVisible();
    await expect(manager.getByRole("heading", { name: "Authentication and credentials", exact: true })).toHaveCount(0);
    await expect(
        manager.getByText("Create immutable versions; values are never returned. Republish environments", {
            exact: false,
        }),
    ).toBeVisible();
    const sections = manager.getByRole("tablist", { name: "Authentication and credentials sections" });
    const adapterTab = sections.getByRole("tab", { name: "Authentication adapters" });
    const credentialTab = sections.getByRole("tab", { name: "Credential versions" });
    const adapterPanel = page.getByRole("tabpanel", { name: "Authentication adapters" });
    const credentialPanel = page.getByRole("tabpanel", { name: "Credential versions" });
    await expect(sections).toHaveAttribute("aria-orientation", "vertical");
    await expect(adapterTab).toHaveAttribute("aria-selected", "true");
    await expect(adapterPanel).toBeVisible();
    await expect(credentialPanel).toHaveCount(0);
    const authType = page.getByRole("combobox", { name: "Type", exact: true });
    await expect(authType).toHaveAccessibleDescription(
        "Choose HTTP_BEARER for bearer tokens, HTTP_SESSION for a login API, or BROWSER_SSO for browser sign-in.",
    );
    const identityPath = page.getByRole("textbox", { name: "Identity path", exact: true });
    await expect(identityPath).toHaveAccessibleDescription(
        "GET path for the current identity. Start with /, for example /me.",
    );
    await identityPath.fill("/me");
    const identityFieldPath = page.getByRole("textbox", { name: "Identity field path", exact: true });
    await expect(identityFieldPath).toHaveAccessibleDescription(
        "For example, enter /user/id to read user.id from the response JSON. The value must be a string.",
    );
    await identityFieldPath.fill("/user/id");
    await page.getByRole("button", { name: "Create adapter version" }).click();
    const result = page.getByRole("dialog", { name: "Operation succeeded", exact: true });
    const acknowledge = result.getByRole("button", { name: "OK", exact: true });
    await expect(result).toContainText("Adapter created:");
    await acknowledge.click();
    const adapterTable = adapterPanel.getByRole("table", { name: "Authentication adapter versions" });
    await expect(adapterTable.getByRole("columnheader", { name: "Identity field path" })).toBeVisible();
    const adapterSummary = adapterTable.getByRole("row").filter({ hasText: "HTTP_BEARER" });
    await expect(adapterSummary.getByRole("cell", { name: "/user/id", exact: true })).toBeVisible();
    await expect(adapterSummary.getByRole("button", { name: "Details" })).toHaveCount(0);
    const revoke = adapterSummary.getByRole("button", { name: "Revoke", exact: true });
    const confirmation = page.getByRole("dialog", { name: "Revoke adapter version", exact: true });
    const cancel = confirmation.getByRole("button", { name: "Cancel", exact: true });
    const revocations: string[] = [];
    const revokePrefix = `/api/v1/workspaces/${alpha.workspaceId}/auth-adapters/`;
    page.on("request", (request) => {
        const { pathname } = new URL(request.url());
        if (request.method() === "POST" && pathname.startsWith(revokePrefix) && pathname.endsWith("/revoke"))
            revocations.push(pathname);
    });
    await revoke.click();
    await expect(confirmation).toBeVisible();
    await expect(cancel).toBeFocused();
    await cancel.click();
    await expect(confirmation).toHaveCount(0);
    await expect(revoke).toBeFocused();
    await expect(adapterSummary.getByRole("cell", { name: "ACTIVE", exact: true })).toBeVisible();
    expect(revocations).toHaveLength(0);
    await revoke.click();
    await confirmation.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(result).toContainText("Adapter version revoked.");
    await acknowledge.click();
    await expect(adapterSummary.getByRole("cell", { name: "REVOKED", exact: true })).toBeVisible();
    expect(revocations).toHaveLength(1);
    await adapterTab.press("ArrowDown");
    await expect(credentialTab).toBeFocused();
    await expect(adapterTab).toHaveAttribute("aria-selected", "true");
    await credentialTab.press("Home");
    await expect(adapterTab).toBeFocused();
    await adapterTab.press("End");
    await expect(credentialTab).toBeFocused();
    await credentialTab.press("Enter");
    await expect(credentialPanel).toBeVisible();
    await expect(adapterPanel).toHaveCount(0);
    const operation = credentialPanel.getByRole("combobox", { name: "Operation", exact: true });
    const newRef = credentialPanel.getByRole("textbox", { name: "Secret ref", exact: true });
    const existingRef = credentialPanel.getByRole("combobox", { name: "Secret ref", exact: true });
    const saveCredential = credentialPanel.getByRole("button", { name: "Save credential version" });
    const identities = credentialPanel.getByRole("textbox", { name: "Allowed identities", exact: true });
    const operationHint =
        "Choose Create reference to save the first version under a new key. " +
        "Choose New version to add a version under an existing key.";
    await expect(operation).toHaveAccessibleDescription(operationHint);
    await expect(credentialPanel.getByText(operationHint, { exact: true })).toBeVisible();
    const identitiesHint =
        "Separate identity IDs with an ASCII comma (,). In the employee Demo, GET /me returns " +
        '{"id":"editor"}. With identity field path /id, enter editor. For multiple IDs, enter editor, reviewer.';
    await expect(newRef).toHaveAccessibleDescription(
        "Start with an ASCII letter or underscore. Remaining characters can be ASCII letters, digits, _ or -. " +
            "Use at most 160 characters and a unique key in this Workspace, for example employee_sso_login.",
    );
    await expect(identities).toHaveJSProperty("type", "text");
    await expect(identities).toHaveAccessibleDescription(identitiesHint);
    const token = credentialPanel.getByLabel("Bearer token");
    const tokenExample = "Enter your actual test token. The sample demo_token_example_123 is for illustration.";
    await expect(token).toHaveAccessibleName("Bearer token");
    await expect(token).toHaveAccessibleDescription(tokenExample);
    await expect(credentialPanel.getByText(tokenExample, { exact: true })).toBeVisible();
    await expect(token).toHaveValue("");
    await expect(token).toHaveAttribute("type", "password");
    const credentialType = credentialPanel.getByRole("combobox", { name: "Credential type", exact: true });
    const credentialTypeHint =
        "Choose HTTP_BEARER for a Bearer token. " +
        "Choose HTTP_SESSION for a username and password, including BROWSER_SSO.";
    await expect(credentialType).toHaveCSS("border-radius", "10px");
    await expect(credentialType).toContainText("HTTP_BEARER");
    await expect(credentialType).toHaveAccessibleDescription(credentialTypeHint);
    await expect(credentialPanel.getByText(credentialTypeHint, { exact: true })).toBeVisible();
    const [bearerType, bearerToken] = await Promise.all([credentialType.boundingBox(), token.boundingBox()]);
    if (!bearerType || !bearerToken) throw new Error("Expected Bearer controls to be visible");
    expect(Math.abs(bearerToken.y - bearerType.y)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(bearerToken.height - bearerType.height)).toBeLessThanOrEqual(0.5);
    await token.fill("test-only-switch-value");
    await credentialType.click();
    const credentialChoices = page.getByRole("listbox");
    await expect(credentialChoices).toHaveCSS("border-radius", "16px");
    await credentialChoices.getByRole("option", { name: "HTTP_SESSION", exact: true }).click();
    await expect(token).toHaveCount(0);
    await expect(credentialType).toHaveAccessibleDescription(credentialTypeHint);
    const username = credentialPanel.getByRole("textbox", { name: "Username", exact: true });
    const password = credentialPanel.getByLabel("Password");
    const usernameExample = "Enter the username for your test account. The sample employee.demo is for illustration.";
    const passwordExample =
        "Enter the password for your test account. The sample Demo-only-password-2026! is for illustration.";
    await expect(username).toHaveAccessibleDescription(usernameExample);
    await expect(credentialPanel.getByText(usernameExample, { exact: true })).toBeVisible();
    await expect(password).toHaveAccessibleName("Password");
    await expect(password).toHaveAccessibleDescription(passwordExample);
    await expect(credentialPanel.getByText(passwordExample, { exact: true })).toBeVisible();
    await expect(username).toHaveValue("");
    await expect(password).toHaveValue("");
    await expect(password).toHaveAttribute("type", "password");
    const [sessionType, sessionUser, sessionPassword] = await Promise.all([
        credentialType.boundingBox(),
        username.boundingBox(),
        password.boundingBox(),
    ]);
    if (!sessionType || !sessionUser || !sessionPassword)
        throw new Error("Expected three session controls to be visible");
    expect(sessionType.x).toBeLessThan(sessionUser.x);
    expect(sessionUser.x).toBeLessThan(sessionPassword.x);
    for (const control of [sessionUser, sessionPassword]) {
        expect(Math.abs(control.y - sessionType.y)).toBeLessThanOrEqual(0.5);
        expect(Math.abs(control.width - sessionType.width)).toBeLessThanOrEqual(0.5);
        expect(Math.abs(control.height - sessionType.height)).toBeLessThanOrEqual(0.5);
    }
    expect(Math.abs(bearerType.width - sessionType.width)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(bearerToken.x - sessionUser.x)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(bearerToken.x + bearerToken.width - sessionPassword.x - sessionPassword.width)).toBeLessThanOrEqual(
        0.5,
    );
    await credentialType.click();
    await credentialChoices.getByRole("option", { name: "HTTP_BEARER", exact: true }).click();
    await expect(token).toHaveValue("");
    await expect(operation).toHaveCSS("border-radius", "10px");
    await expectCredentialTargetHalves(operation, newRef);
    await chooseCredentialOperation(page, "New version");
    await expect(existingRef).toBeDisabled();
    await expect(operation).toHaveAccessibleDescription(operationHint);
    await expect(credentialPanel.getByText(rotationReferenceHint, { exact: true })).toBeVisible();
    await expect(existingRef).toHaveAccessibleDescription(
        `${rotationReferenceHint} No existing credential references.`,
    );
    await expect(existingRef).not.toHaveAccessibleDescription(/Start with an ASCII/);
    await expect(identities).toHaveAccessibleDescription(identitiesHint);
    await expect(credentialPanel.getByText("No existing credential references.", { exact: true })).toBeVisible();
    await expect(saveCredential).toBeDisabled();
    await expect(existingRef).toHaveCSS("border-radius", "10px");
    await expectCredentialTargetHalves(operation, existingRef);
    await chooseCredentialOperation(page, "Create reference");
    const credentialKey = "browser_business_" + "a".repeat(143);
    await newRef.fill(credentialKey);
    await page.getByLabel("Allowed identities").fill("reader");
    await page.getByLabel("Bearer token").fill("browser-secret-only-once");
    await saveCredential.click();
    await expect(result).toContainText("Credential saved:");
    await acknowledge.click();
    const credentialTable = credentialPanel.getByRole("table", { name: "Credential version list", exact: true });
    const credentialCells = credentialTable.getByRole("cell", { name: credentialKey, exact: true });
    await expect(credentialCells).toHaveCount(1);
    await expect(page.getByLabel("Bearer token")).toHaveValue("");
    await expect(page.locator("body")).not.toContainText("browser-secret-only-once");
    await newRef.fill("future_reference");
    await chooseCredentialOperation(page, "New version");
    await expect(newRef).toHaveCount(0);
    await expect(existingRef).toContainText("Select an existing reference");
    await expect(existingRef).toHaveAccessibleDescription(rotationReferenceHint);
    await expect(saveCredential).toBeDisabled();
    await existingRef.click();
    await page.getByRole("option", { name: credentialKey, exact: true }).click();
    await chooseCredentialOperation(page, "Create reference");
    await expect(newRef).toHaveValue("future_reference");
    await chooseCredentialOperation(page, "New version");
    await expect(existingRef).toContainText(credentialKey);
    await identities.fill(" reader, , auditor ");
    await page.getByLabel("Bearer token").fill("browser-rotated-only-once");
    const rotationPath = `/api/v1/workspaces/${alpha.workspaceId}/credentials/${credentialKey}/versions`;
    const rotated = page.waitForResponse(
        (response) => new URL(response.url()).pathname === rotationPath && response.request().method() === "POST",
    );
    await saveCredential.click();
    const rotation = await rotated;
    expect(rotation.status()).toBe(201);
    const rotationVersion = (await rotation.json()).data;
    expect(rotationVersion.allowedIdentityIds).toEqual(["reader", "auditor"]);
    await expect(result).toContainText(`Credential saved: ${rotationVersion.versionId}`);
    await acknowledge.click();
    await expect(credentialCells).toHaveCount(2);
    await expect(page.getByLabel("Bearer token")).toHaveValue("");
    await expect(page.locator("body")).not.toContainText("browser-rotated-only-once");
    const rotationRow = credentialTable.getByRole("row").filter({
        has: page.getByRole("cell", { name: rotationVersion.versionId, exact: true }),
    });
    const siblingRow = credentialTable.getByRole("row").filter({
        has: page.getByRole("cell", { name: credentialKey, exact: true }),
        hasNot: page.getByRole("cell", { name: rotationVersion.versionId, exact: true }),
    });
    await expect(rotationRow.getByRole("cell", { name: "reader, auditor", exact: true })).toBeVisible();
    const credentialRevoke = rotationRow.getByRole("button", { name: "Revoke", exact: true });
    const credentialConfirmation = page.getByRole("dialog", { name: "Revoke credential version", exact: true });
    const cancelCredentialRevoke = credentialConfirmation.getByRole("button", { name: "Cancel", exact: true });
    const credentialRevocations: string[] = [];
    const credentialRevokePrefix = `/api/v1/workspaces/${alpha.workspaceId}/credentials/`;
    page.on("request", (request) => {
        const { pathname } = new URL(request.url());
        if (request.method() === "POST" && pathname.startsWith(credentialRevokePrefix) && pathname.endsWith("/revoke"))
            credentialRevocations.push(pathname);
    });
    const credentialDetailsButton = rotationRow.getByRole("button", { name: /Credential details for/ });
    const credentialDetails = page.getByRole("dialog", { name: "Credential version details", exact: true });
    await credentialDetailsButton.click();
    await expect(credentialDetails.getByText(credentialKey, { exact: true })).toBeVisible();
    const detailVersion = credentialDetails.getByText(rotationVersion.versionId, { exact: true });
    await expect(detailVersion).toBeVisible();
    await expect(detailVersion).toHaveCSS("white-space", "nowrap");
    await expect(credentialDetails.getByText("reader, auditor", { exact: true })).toBeVisible();
    await expect(credentialDetails.getByText("ACTIVE", { exact: true })).toBeVisible();
    await expect(credentialDetails.locator("time")).toHaveAttribute("datetime", rotationVersion.createdAt);
    await expect(credentialDetails).not.toContainText(/browser-(secret|rotated)-only-once/);
    expect(await credentialDetails.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
    const closeCredentialDetails = credentialDetails.getByRole("button", { name: "Close", exact: true });
    await expect(closeCredentialDetails).toBeFocused();
    await closeCredentialDetails.press("Escape");
    await expect(credentialDetails).toHaveCount(0);
    await expect(credentialDetailsButton).toBeFocused();
    expect(credentialRevocations).toEqual([]);
    await credentialRevoke.click();
    const confirmationKey = credentialConfirmation.getByText(credentialKey, { exact: true });
    const confirmationVersion = credentialConfirmation.getByText(rotationVersion.versionId, { exact: true });
    await expect(confirmationKey).toBeVisible();
    await expect(confirmationVersion).toBeVisible();
    const versionLayout = await confirmationVersion.evaluate((value) => {
        const range = document.createRange();
        range.selectNodeContents(value);
        const rects = [...range.getClientRects()];
        const cell = value.closest("dd")?.getBoundingClientRect();
        return {
            lines: new Set(rects.map((rect) => rect.top)).size,
            fits: cell && rects.every((rect) => rect.left >= cell.left && rect.right <= cell.right + 0.5),
        };
    });
    expect(versionLayout).toEqual({ lines: 1, fits: true });
    const keyLines = await confirmationKey.evaluate((value) => {
        const range = document.createRange();
        range.selectNodeContents(value);
        return new Set([...range.getClientRects()].map((rect) => rect.top)).size;
    });
    expect(keyLines).toBeGreaterThan(1);
    await expect(credentialConfirmation).toContainText("After revocation, the Runtime can no longer use this version.");
    expect(await credentialConfirmation.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
    await expect(cancelCredentialRevoke).toBeFocused();
    await cancelCredentialRevoke.click();
    await expect(credentialConfirmation).toHaveCount(0);
    await expect(credentialRevoke).toBeFocused();
    await expect(rotationRow.getByRole("cell", { name: "ACTIVE", exact: true })).toBeVisible();
    expect(credentialRevocations).toEqual([]);
    await credentialRevoke.click();
    await cancelCredentialRevoke.press("Escape");
    await expect(credentialConfirmation).toHaveCount(0);
    await expect(credentialRevoke).toBeFocused();
    expect(credentialRevocations).toEqual([]);
    await credentialRevoke.click();
    await credentialConfirmation.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(credentialConfirmation).toHaveCount(0);
    await expect(result).toContainText("Credential version revoked.");
    await acknowledge.click();
    await expect(rotationRow.getByRole("cell", { name: "REVOKED", exact: true })).toBeVisible();
    await expect(credentialRevoke).toBeDisabled();
    await expect(rotationRow).toBeFocused();
    await expect(siblingRow.getByRole("cell", { name: "ACTIVE", exact: true })).toBeVisible();
    expect(credentialRevocations).toEqual([
        `${credentialRevokePrefix}${credentialKey}/versions/${rotationVersion.versionId}/revoke`,
    ]);
    await credentialDetailsButton.click();
    await expect(credentialDetails.getByText("REVOKED", { exact: true })).toBeVisible();
    await closeCredentialDetails.click();
    await expect(credentialDetailsButton).toBeFocused();
});

/**
 * 用真实浏览器重放挂载与效果清理，后一次轮换读取必须使用新信号，旧控制器已取消不应阻断后续工作区请求。
 */
test("credential reference lookup survives React effect replay", async ({ page }) => {
    const { workspaceId, headers } = await editorScope(page, `rotation-replay-${randomUUID()}`);
    const response = await page.request.post(`/api/v1/workspaces/${workspaceId}/credentials`, {
        headers,
        data: { secretRef: "replay_example", value: { token: "strict-test-only" }, allowedIdentityIds: ["editor"] },
    });
    expect(response.status()).toBe(201);
    await page.goto(`/tests/identity-strict-fixture.html?workspaceId=${workspaceId}`);
    await page.getByRole("tab", { name: "Credential versions", exact: true }).click();
    await chooseCredentialOperation(page, "New version");
    const existing = page.getByRole("combobox", { name: "Secret ref", exact: true });
    await expect(existing).toBeEnabled();
    await expect(page.getByText("signal is aborted without reason", { exact: true })).toHaveCount(0);
    await existing.click();
    await expect(page.getByRole("option", { name: "replay_example", exact: true })).toBeVisible();
});

/**
 * 两个真实工作区的凭证列表含不同行，首个列表跨页且含重复版本；轮换下拉只能读取当前工作区的唯一引用。
 */
test("credential rotation lists distinct current Workspace references across all pages", async ({ page }) => {
    const { workspaceId, headers } = await editorScope(page, `rotation-list-${randomUUID()}`);
    const peer = await page.request.post("/api/v1/workspaces", {
        headers,
        data: { key: `rotation-peer-${randomUUID()}`, name: "Credential rotation peer" },
    });
    expect(peer.status()).toBe(201);
    const peerId: string = (await peer.json()).data.id;
    const path = `/api/v1/workspaces/${workspaceId}/credentials`;
    const data = { value: { token: "rotation-list-test-only" }, allowedIdentityIds: ["reader"] };
    const longIdentity = `test_identity_${"w".repeat(120)}`;
    for (let index = 0; index < 26; index++) {
        const result = await page.request.post(path, {
            headers,
            data: {
                ...data,
                secretRef: `test_ref_${index}`,
                allowedIdentityIds: index === 0 ? [longIdentity] : data.allowedIdentityIds,
            },
        });
        expect(result.status()).toBe(201);
    }
    expect((await page.request.post(`${path}/test_ref_1/versions`, { headers, data })).status()).toBe(201);
    const peerCredential = await page.request.post(`/api/v1/workspaces/${peerId}/credentials`, {
        headers,
        data: { ...data, secretRef: "peer_only_ref" },
    });
    expect(peerCredential.status()).toBe(201);
    const firstPage = (await (await page.request.get(path)).json()).data;
    expect(firstPage.items).toHaveLength(25);
    expect(firstPage.nextCursor).toBeTruthy();

    const credentialsRequests: boolean[] = [];
    page.on("request", (request) => {
        const url = new URL(request.url());
        if (request.method() === "GET" && url.pathname === path)
            credentialsRequests.push(url.searchParams.has("cursor"));
    });
    await page.route(
        (url) => url.pathname === path && url.searchParams.has("cursor"),
        (route) => route.abort(),
        { times: 1 },
    );
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/workspaces?tab=auth-credentials&workspaceId=${workspaceId}`);
    const credentialTab = page.getByRole("tab", { name: "Credential versions", exact: true });
    const panel = page.getByRole("tabpanel", { name: "Credential versions", exact: true });
    const table = panel.getByRole("table", { name: "Credential version list", exact: true });
    const existingRef = panel.getByRole("combobox", { name: "Secret ref", exact: true });
    const choices = page.getByRole("listbox").getByRole("option");
    await credentialTab.click();
    await chooseCredentialOperation(page, "New version");
    await expect(panel.getByRole("textbox", { name: "Secret ref", exact: true })).toHaveCount(0);
    const retry = panel.getByRole("alert").getByRole("button", { name: "Retry", exact: true });
    await expect(retry).toBeVisible();
    await expect(panel.getByText(rotationReferenceHint, { exact: true })).toBeVisible();
    await expect(existingRef).toHaveAccessibleDescription(/Choose the existing reference to update.*Retry/);
    await expect(existingRef).toBeDisabled();
    await expect(panel.getByRole("button", { name: "Save credential version" })).toBeDisabled();
    await retry.click();
    await expect(table.getByRole("row")).toHaveCount(11);
    const search = panel.getByRole("searchbox", { name: "Search credential versions" });
    await search.fill(longIdentity);
    await expect(table.getByRole("cell", { name: longIdentity, exact: true })).toHaveCSS("white-space", "nowrap");
    await expect(table.getByRole("row")).toHaveCount(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1280);
    const scrollArea = table.locator("..");
    expect(await scrollArea.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
    const revoke = table.getByRole("button", { name: "Revoke", exact: true });
    await revoke.scrollIntoViewIfNeeded();
    await expect(revoke).toBeInViewport();
    expect(await scrollArea.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
    await existingRef.click();
    await expect(choices).toHaveCount(26);
    await expect(choices.filter({ hasText: /^test_ref_1$/ })).toHaveCount(1);
    await expect(choices.filter({ hasText: "peer_only_ref" })).toHaveCount(0);
    await choices.filter({ hasText: /^test_ref_1$/ }).click();
    expect(credentialsRequests).toEqual([false, true, false, true]);
    await page.goto(`/workspaces?tab=auth-credentials&workspaceId=${peerId}`);
    await credentialTab.click();
    await chooseCredentialOperation(page, "New version");
    await expect(search).toHaveValue("");
    await expect(existingRef).toContainText("Select an existing reference");
    await expect(table.getByRole("cell", { name: "peer_only_ref", exact: true })).toBeVisible();
    await expect(table.getByRole("row")).toHaveCount(2);
    await existingRef.click();
    await expect(choices).toHaveText(["peer_only_ref"]);
});

/**
 * 使用真实管理接口保存浏览器认证适配器，核对填写的是公开表单标签与固定路径，切回 HTTP 模式会隐藏专用字段。
 */
test("authentication settings create a Browser SSO adapter version", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const { workspaceId } = await editorScope(page, `sso-adapter-${randomUUID()}`);
    await page.goto(`/workspaces?tab=auth-credentials&workspaceId=${workspaceId}`);
    const panel = page.getByRole("tabpanel", { name: "Authentication adapters", exact: true });
    const type = panel.getByRole("combobox", { name: "Type", exact: true });
    const entry = panel.getByRole("textbox", { name: "Protected entry path", exact: true });
    await expect(entry).toHaveCount(0);
    await type.click();
    await page.getByRole("option", { name: "BROWSER_SSO", exact: true }).click();
    const fields = [
        ["Protected entry path", "/employees"],
        ["IdP origin", "https://idp.sso.test:8443"],
        ["IdP sign-in page path", "/login"],
        ["IdP form submission path", "/session"],
        ["Application callback path", "/sso/callback"],
        ["Username field label", "Username"],
        ["Password field label", "Password"],
        ["Submit button name", "Sign in"],
        ["Identity path", "/me"],
    ] as const;
    for (const [label, value] of fields) {
        const input = panel.getByRole("textbox", { name: label, exact: true });
        await expect(input).toHaveAccessibleDescription(/\S/);
        await input.fill(value);
    }
    await expect(panel.getByRole("textbox", { name: "Login path", exact: true })).toHaveCount(0);
    const saved = page.waitForResponse((response) => {
        const path = `/api/v1/workspaces/${workspaceId}/auth-adapters`;
        return new URL(response.url()).pathname === path && response.request().method() === "POST";
    });
    await panel.getByRole("button", { name: "Create adapter version", exact: true }).click();
    expect((await saved).status()).toBe(201);
    const result = page.getByRole("dialog", { name: "Operation succeeded", exact: true });
    const acknowledge = result.getByRole("button", { name: "OK", exact: true });
    await expect(result).toContainText("Adapter created:");
    await acknowledge.click();
    const table = panel.getByRole("table", { name: "Authentication adapter versions" });
    const summary = table.getByRole("row").filter({ hasText: "BROWSER_SSO" });
    const detailButton = summary.getByRole("button", { name: "Details" });
    const details = page.getByRole("dialog", { name: "Authentication adapter details", exact: true });
    await detailButton.press("Enter");
    const idpOrigin = details.getByText("https://idp.sso.test:8443", { exact: true });
    await expect(idpOrigin).toBeVisible();
    await expect(idpOrigin).toHaveCSS("font-size", "11px");
    await expect(details.locator("dl")).toHaveCSS("row-gap", "10px");
    await expect(details.getByText("/sso/callback", { exact: true })).toBeVisible();
    await details.getByRole("button", { name: "Close", exact: true }).press("Escape");
    await expect(details).toHaveCount(0);
    await expect(detailButton).toBeFocused();
    await type.click();
    await page.getByRole("option", { name: "HTTP_SESSION", exact: true }).click();
    await expect(entry).toHaveCount(0);
    await expect(panel.getByRole("textbox", { name: "Login path", exact: true })).toBeVisible();
    await summary.getByRole("button", { name: "Revoke", exact: true }).click();
    const confirmation = page.getByRole("dialog", { name: "Revoke adapter version", exact: true });
    await confirmation.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(result).toContainText("Adapter version revoked.");
    await acknowledge.click();
    await expect(summary.getByRole("cell", { name: "REVOKED", exact: true })).toBeVisible();
    await detailButton.click();
    await expect(details.getByText("/sso/callback", { exact: true })).toBeVisible();
});

/**
 * 创建跨越默认服务端页上限的适配器，再搜索仅存在于后端后续页的版本，检查本地筛选覆盖真实游标读取的完整结果。
 */
test("authentication adapter table search includes every server page", async ({ page }) => {
    const { workspaceId, headers } = await editorScope(page, `adapter-table-${randomUUID()}`);
    const path = `/api/v1/workspaces/${workspaceId}/auth-adapters`;
    for (let index = 0; index < 26; index++) {
        const response = await page.request.post(path, {
            headers,
            data: {
                configuration: { kind: "HTTP_BEARER", identityPath: `/identity-${index}`, identityPointer: "/id" },
            },
        });
        expect(response.status()).toBe(201);
    }
    const firstResponse = await page.request.get(path);
    expect(firstResponse.status()).toBe(200);
    const firstPage = (await firstResponse.json()).data;
    expect(firstPage.items).toHaveLength(25);
    expect(firstPage.nextCursor).toBeTruthy();
    const finalResponse = await page.request.get(`${path}?cursor=${encodeURIComponent(firstPage.nextCursor)}`);
    expect(finalResponse.status()).toBe(200);
    const finalPage = (await finalResponse.json()).data;
    expect(finalPage.items).toHaveLength(1);
    const versionId: string = finalPage.items[0].versionId;
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/workspaces?tab=auth-credentials&workspaceId=${workspaceId}`);
    const table = page.getByRole("table", { name: "Authentication adapter versions" });
    await expect(table.getByRole("row")).toHaveCount(11);
    await expect(table.getByRole("cell", { name: versionId, exact: true })).toHaveCount(0);
    await page.getByRole("searchbox", { name: "Search adapter versions" }).fill(versionId);
    await expect(table.getByRole("row")).toHaveCount(2);
    await expect(table.getByRole("cell", { name: versionId, exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1280);
});

/**
 * 使用真实身份管理器和服务端凭证提交验证表单生命周期，认证类型的无关重渲染必须保留未提交输入；旧空间请求已提交但响应尚
 * 未交付时切换空间，随后仅允许原空间显示已保存摘要。
 */
test("identity manager retains scope across rerenders and late credential responses", async ({ page }) => {
    const alpha = await editorScope(page, `identity-lifetime-alpha-${randomUUID()}`);
    const betaResponse = await page.request.post("/api/v1/workspaces", {
        headers: alpha.headers,
        data: { key: `identity-lifetime-beta-${randomUUID()}`, name: "Identity lifetime Beta" },
    });
    expect(betaResponse.status()).toBe(201);
    const betaId: string = (await betaResponse.json()).data.id;
    await page.goto("/workspaces?tab=auth-credentials");
    const selector = workspacePicker(page);
    await chooseWorkspace(page, alpha.workspaceId);
    const manager = page.getByRole("tabpanel", { name: "Authentication and credentials", exact: true });
    await expect(manager).toBeVisible();
    const adapterTab = manager.getByRole("tab", { name: "Authentication adapters" });
    const credentialTab = manager.getByRole("tab", { name: "Credential versions" });
    const secretRef = "identity_late";
    const secret = "identity-lifetime-private-value";
    const identityDraft = "reader, auditor";
    await credentialTab.click();
    await page.getByLabel("Secret ref").fill(secretRef);
    await page.getByLabel("Allowed identities").fill(identityDraft);
    await page.getByLabel("Bearer token").fill(secret);
    await adapterTab.click();
    const authType = manager.getByRole("combobox", { name: "Type", exact: true });
    const loginPath = manager.getByRole("textbox", { name: "Login path", exact: true });
    const loginHint = "POST path that establishes a cookie session. Start with /, for example /login.";
    await expect(loginPath).toHaveCount(0);
    await expect(manager.getByText(loginHint, { exact: true })).toHaveCount(0);
    await expect(authType).toHaveCSS("border-radius", "10px");
    await authType.press("ArrowDown");
    const options = page.getByRole("listbox");
    await expect(options).toBeVisible();
    await expect(options).toHaveCSS("border-radius", "16px");
    const bearerOption = options.getByRole("option", { name: "HTTP_BEARER", exact: true });
    const sessionOption = options.getByRole("option", { name: "HTTP_SESSION", exact: true });
    await expect(bearerOption).toBeFocused();
    await expect(bearerOption).toHaveCSS("border-radius", "8px");
    await bearerOption.press("ArrowDown");
    await expect(sessionOption).toBeFocused();
    await sessionOption.press("Enter");
    await expect(authType).toContainText("HTTP_SESSION");
    await expect(loginPath).toHaveAccessibleDescription(loginHint);
    await loginPath.fill("/session/login");
    await manager.getByRole("button", { name: "Create adapter version", exact: true }).click();
    const result = page.getByRole("dialog", { name: "Operation succeeded", exact: true });
    await expect(result).toContainText("Adapter created:");
    await result.getByRole("button", { name: "OK", exact: true }).click();
    const adapterTable = manager.getByRole("table", { name: "Authentication adapter versions" });
    const sessionSummary = adapterTable.getByRole("row").filter({ hasText: "HTTP_SESSION" });
    await sessionSummary.getByRole("button", { name: "Details" }).click();
    const details = page.getByRole("dialog", { name: "Authentication adapter details", exact: true });
    await expect(details.getByText("/session/login", { exact: true })).toBeVisible();
    await details.getByRole("button", { name: "Close", exact: true }).click();
    await authType.click();
    await bearerOption.click();
    await expect(authType).toContainText("HTTP_BEARER");
    await expect(loginPath).toHaveCount(0);
    await expect(manager.getByText(loginHint, { exact: true })).toHaveCount(0);
    await credentialTab.click();
    await expect(page.getByLabel("Secret ref")).toHaveValue(secretRef);
    await expect(page.getByLabel("Allowed identities")).toHaveValue(identityDraft);
    await expect(page.getByLabel("Bearer token")).toHaveValue(secret);

    // 仅拦截 Alpha 的同源凭证创建请求并等待真实提交完成，持有原响应直到浏览器确认旧请求被取消；释放时只销毁响应，绝不向
    // 已中止的 Chromium 请求伪造或补发成功。
    const credentialUrl = new URL(`/api/v1/workspaces/${alpha.workspaceId}/credentials`, page.url()).href;
    const matches = (url: URL) => url.href === credentialUrl;
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
        release = resolve;
    });
    let committed!: (versionId: string) => void;
    const backendCommitted = new Promise<string>((resolve) => {
        committed = resolve;
    });
    let handler: Promise<void> | undefined;
    await page.route(matches, (route) => {
        if (route.request().method() !== "POST") return route.continue();
        handler = (async () => {
            const response = await route.fetch();
            try {
                expect(response.status()).toBe(201);
                const saved = (await response.json()).data;
                expect(saved.allowedIdentityIds).toEqual(["reader", "auditor"]);
                const versionId: string = saved.versionId;
                expect(versionId).toBeTruthy();
                committed(versionId);
                await released;
            } finally {
                await response.dispose();
            }
        })();
        return handler;
    });
    let versionId = "";
    try {
        const aborted = page.waitForEvent("requestfailed", {
            predicate: (request) => request.url() === credentialUrl && request.method() === "POST",
        });
        await page.getByRole("button", { name: "Save credential version" }).click();
        versionId = await backendCommitted;
        await chooseWorkspace(page, betaId);
        expect((await aborted).failure()?.errorText).toContain("ERR_ABORTED");
    } finally {
        release();
        try {
            await handler;
        } finally {
            await page.unroute(matches);
        }
    }
    await expect(selector).toHaveAttribute("data-workspace-id", betaId);
    await expect(adapterTab).toHaveAttribute("aria-selected", "true");
    await credentialTab.click();
    const credentialTable = manager.getByRole("table", { name: "Credential version list", exact: true });
    await expect(credentialTable.getByRole("cell", { name: "No credentials.", exact: true })).toBeVisible();
    await expect(manager).not.toContainText(versionId);
    await expect(result).toHaveCount(0);
    await expect(manager).not.toContainText(secret);
    await expect(page.getByLabel("Secret ref")).toHaveValue("");
    await expect(page.getByLabel("Allowed identities")).toHaveValue("");
    await expect(page.getByLabel("Bearer token")).toHaveValue("");
    await expect(page.getByRole("button", { name: "Save credential version" })).toBeEnabled();
    await chooseWorkspace(page, alpha.workspaceId);
    await credentialTab.click();
    const savedCredential = credentialTable.getByRole("row").filter({
        has: page.getByRole("cell", { name: versionId, exact: true }),
    });
    await expect(savedCredential.getByRole("cell", { name: secretRef, exact: true })).toBeVisible();
    await expect(savedCredential.getByRole("cell", { name: "reader, auditor", exact: true })).toBeVisible();
    await expect(page.getByLabel("Secret ref")).toHaveValue("");
    await expect(page.getByLabel("Allowed identities")).toHaveValue("");
    await expect(page.getByLabel("Bearer token")).toHaveValue("");
    await expect(result).toHaveCount(0);
    await expect(manager).not.toContainText(secret);
});

test("all eight kinds expose usable typed controls and preserve literal business values", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/login");
    await page.getByRole("textbox", { name: "Email" }).fill("browser-admin@example.com");
    await page.getByLabel("Password").fill("Browser password 123!");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("dl")).toBeVisible();
    const session = (await (await page.request.get("/api/v1/auth/session")).json()).data;
    const workspaceResponse = await page.request.post("/api/v1/workspaces", {
        headers: {
            Origin: "http://127.0.0.1:5173",
            "X-CSRF-Token": session.csrfToken,
        },
        data: { key: "editor-types", name: "Typed editor" },
    });
    expect(workspaceResponse.status()).toBe(201);
    const workspace = (await workspaceResponse.json()).data;
    await page.goto("/resources/datasets");
    await chooseWorkspace(page, workspace.id);
    const kinds = [
        "CASE",
        "ELEMENT_CATALOG",
        "ASSERTION_TEMPLATE",
        "DATASET",
        "FLOW",
        "FIXTURE",
        "SUITE",
        "ENVIRONMENT",
    ];
    for (const kind of kinds) {
        await closeResourceEditor(page);
        await openResourceCreateForm(page, kind);
        await resourceCreateForm(page)
            .getByLabel("Key", { exact: true })
            .fill("typed_" + kind.toLowerCase());
        await resourceCreateForm(page)
            .getByLabel("Name", { exact: true })
            .fill("Typed " + kind);
        const response = page.waitForResponse((r) => r.url().endsWith("/resources") && r.request().method() === "POST");
        await page.getByRole("button", { name: "Create resource" }).click();
        const created = await response;
        expect(created.status(), await created.text()).toBe(201);
        await acknowledgeOperation(page, "Resource created");
        const datasetPage = kind === "DATASET";
        const heading = datasetPage
            ? page.getByRole("main").getByRole("heading", { name: "Typed DATASET", exact: true, level: 1 })
            : page.getByRole("article").getByRole("heading", { name: `Typed ${kind} · ${kind}` });
        await expect(heading).toBeVisible();
        if (kind === "CASE" || kind === "FLOW") {
            await selectResourceOption(page.getByRole("combobox", { name: "Action", exact: true }), "fill");
            await page.getByLabel("Value (bindings allowed)", { exact: true }).fill("{{data.name}}");
            await page.getByRole("button", { name: "Add Observers" }).click();
            await selectResourceOption(page.getByLabel("Observer kind"), "dialog");
            await selectResourceOption(page.getByLabel("Dialog type"), "prompt");
            await selectResourceOption(page.getByLabel("Handling"), "accept");
            await page.getByLabel("Prompt text").fill("{{vars.answer}}");
            await selectResourceOption(page.getByLabel("Observer kind"), "newPage");
            await page.getByLabel("Captured page key").fill("detail");
            await page.getByRole("button", { name: "Add After assertions" }).click();
            const assertionPage = page
                .getByRole("heading", { name: "After assertions" })
                .locator("..")
                .getByLabel("Page (omit for original page)");
            if (kind === "FLOW") {
                await assertionPage.fill("detail");
                await expect(assertionPage).toHaveValue("detail");
            } else {
                await selectResourceOption(assertionPage, "detail");
                await expect(assertionPage).toHaveText("detail");
            }
            await selectResourceOption(
                page.getByRole("heading", { name: "After assertions" }).locator("..").getByLabel("Assertion type"),
                "eventually",
            );
            await page
                .getByRole("heading", { name: "After assertions" })
                .locator("..")
                .getByLabel("Read-only query path")
                .fill("/status");
            await page
                .getByRole("heading", { name: "After assertions" })
                .locator("..")
                .getByLabel("JSON Pointer (RFC6901)")
                .fill("/ok");
            await selectResourceOption(page.getByLabel("Observer kind"), "download");
            // 事件观察器不能提供网络响应的正文或请求头，所以提取来源列表必须排除该类观察器；这里使用真实编辑控件核对来
            // 源选项，防止不可执行的引用被保存进用例。
            await page.getByRole("button", { name: "Add Extractions" }).click();
            await expect(
                page.getByRole("heading", { name: "Extractions" }).locator("..").getByLabel("Network source"),
            ).toBeDisabled();
            await page
                .getByRole("heading", { name: "Extractions" })
                .locator("..")
                .getByRole("button", { name: "Move row 1 up" })
                .locator("..")
                .getByRole("button", { name: "Remove" })
                .click();
            await page.getByRole("button", { name: "Add Steps" }).click();
            const steps = page.getByRole("heading", { name: "Steps", exact: true }).locator("..");
            const lastStep = steps.locator(".vq-item").filter({
                has: page.getByRole("button", { name: "Move row 2 up", exact: true }),
            });
            await lastStep.getByLabel("Step ID", { exact: true }).fill("last");
            await lastStep.getByRole("button", { name: "Remove", exact: true }).click();
        }
        if (kind === "ELEMENT_CATALOG") {
            await selectResourceOption(page.getByLabel("Locator"), "role");
            await page.getByLabel("ARIA role").fill("button");
            await page.getByLabel("Accessible name").fill("保存");
            await page.getByLabel("Exact").check();
        }
        if (kind === "ASSERTION_TEMPLATE") {
            await page
                .getByRole("heading", { name: "Template parameter types" })
                .locator("..")
                .getByLabel("Name")
                .fill("expectedName");
            await page.getByRole("button", { name: "Add Template parameter types" }).click();
            await selectResourceOption(page.getByRole("combobox", { name: "Operator", exact: true }), "textEquals");
            await page.getByLabel("Expected", { exact: true }).fill("{{data.expectedName}}");
            await selectResourceOption(
                page.getByRole("combobox", { name: "Assertion type", exact: true }),
                "responseField",
            );
            await page.getByLabel("Network source").fill("response:save");
            const expectedType = page.getByRole("combobox", {
                name: "Expected value Type",
                exact: true,
            });
            await selectResourceOption(expectedType, "null");
            await expect(expectedType).toHaveText("null");
        }
        if (kind === "DATASET") {
            await page.getByLabel("name", { exact: true }).fill("{{literal.notEvaluated()}}");
            await page.getByRole("button", { name: "Add row", exact: true }).click();
            const rowKey = page
                .getByRole("heading", { name: "Dataset rows", exact: true })
                .locator("..")
                .getByLabel("Row key", { exact: true })
                .last();
            await rowKey.fill("second");
            await rowKey.press("Tab");
        }
        if (kind === "FIXTURE") {
            await selectResourceOption(page.getByLabel("Cleanup method"), "DELETE");
            await page.getByLabel("TTL seconds").fill("600");
            await page
                .getByRole("heading", { name: "Input schema", exact: true })
                .locator("..")
                .getByRole("button", { name: "Add schema property", exact: true })
                .click();
        }
        if (kind === "SUITE") {
            await page.getByLabel("firefox", { exact: true }).check();
            await page.getByRole("button", { name: "Add Roles" }).click();
            await page.getByRole("textbox", { name: "Roles 1", exact: true }).fill("reader");
        }
        if (kind === "ENVIRONMENT") {
            await page.getByLabel("Frontend URL").fill("https://example.com");
            await page.getByRole("button", { name: "Add Allowed origins" }).click();
            await page
                .getByRole("textbox", {
                    name: "Allowed origins 2",
                    exact: true,
                })
                .fill("https://example.com");
            await page.getByRole("button", { name: "Add Allowed identity IDs" }).click();
            await page
                .getByRole("textbox", {
                    name: "Allowed identity IDs 1",
                    exact: true,
                })
                .fill("reader");
        }
        expect(await page.locator('ul[role="alert"]').count()).toBe(0);
        const saved = page.waitForResponse((r) => r.url().endsWith("/draft") && r.request().method() === "PUT");
        await page.getByRole("button", { name: "Save draft" }).click();
        const result = await saved;
        expect(result.status(), await result.text()).toBe(200);
        const document = (await result.json()).data.content.document;
        if (kind === "DATASET")
            expect(document).toMatchObject({
                schemaVersion: "2.0",
                shape: "TABLE",
                source: {
                    kind: "STATIC",
                    rows: [
                        { key: "row_1", values: { name: "{{literal.notEvaluated()}}" } },
                        { key: "second", values: { name: "" } },
                    ],
                },
            });
        if (kind === "ELEMENT_CATALOG")
            expect(document.elements[0].locator).toEqual({
                by: "role",
                role: "button",
                name: "保存",
                exact: true,
            });
        if (kind === "CASE" || kind === "FLOW")
            expect(document.steps[0].observers[0]).toMatchObject({
                kind: "download",
            });
        await acknowledgeOperation(page, "Saved");
        const editorMode = datasetPage ? "tab" : "button";
        await page.getByRole(editorMode, { name: datasetPage ? "Data (JSON)" : "JSON source", exact: true }).click();
        const editor = page.getByRole(datasetPage ? "article" : "dialog");
        await expect(editor.getByRole("textbox", { name: "JSON source", exact: true })).toBeVisible();
        await page.getByRole(editorMode, { name: datasetPage ? "Data (Form)" : "Visual form", exact: true }).click();
    }
});

test("JSON Apply is lossless, blocks unapplied writes, and revision recovery retains local edits", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto("/login");
    await page.getByRole("textbox", { name: "Email" }).fill("browser-admin@example.com");
    await page.getByLabel("Password").fill("Browser password 123!");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("dl")).toBeVisible();
    const scopeSession = (await (await page.request.get("/api/v1/auth/session")).json()).data;
    const ownWorkspaceResponse = await page.request.post("/api/v1/workspaces", {
        headers: {
            Origin: "http://127.0.0.1:5173",
            "X-CSRF-Token": scopeSession.csrfToken,
        },
        data: { key: "editor-json", name: "JSON editor" },
    });
    expect(ownWorkspaceResponse.status()).toBe(201);
    const ownWorkspace = (await ownWorkspaceResponse.json()).data;
    await page.goto("/resources/datasets");
    await chooseWorkspace(page, ownWorkspace.id);
    await openResourceCreateForm(page, "ELEMENT_CATALOG");
    await resourceCreateForm(page).getByLabel("Key", { exact: true }).fill("conflict_catalog");
    await resourceCreateForm(page).getByLabel("Name", { exact: true }).fill("Conflict catalog");
    const creation = page.waitForResponse((r) => r.url().endsWith("/resources") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Create resource" }).click();
    const resource = (await (await creation).json()).data;
    await acknowledgeOperation(page, "Resource created");
    await expect(page.getByLabel("Element key")).toBeVisible();
    const source = {
        kind: "ELEMENT_CATALOG",
        document: {
            schemaVersion: "1.0",
            elements: [
                {
                    key: "literal",
                    locator: {
                        by: "role",
                        role: "button",
                        name: "{{data.label}}",
                        exact: false,
                    },
                    scope: "scope",
                    recordKey: "{{vars.record}}",
                },
                { key: "scope", locator: { by: "veriqId", value: "scope" } },
            ],
        },
    };
    await page.getByRole("button", { name: "JSON source" }).click();
    const replaceJson = async (text: string) => {
        await replaceEditorJson(page, text);
    };
    await replaceJson(JSON.stringify(source, null, 2));
    await expect(page.getByText("Unapplied JSON changes")).toBeVisible();
    let writes = 0;
    const record = (request: import("@playwright/test").Request) => {
        if (request.method() === "PUT" && request.url().endsWith("/draft")) writes++;
    };
    page.on("request", record);
    await page.getByRole("button", { name: "Save draft" }).click();
    await acknowledgeOperation(
        page,
        "Unapplied JSON changes: apply or discard them before saving, validating or publishing.",
        "failed",
    );
    expect(writes).toBe(0);
    await page.getByRole("button", { name: "Apply JSON" }).click();
    await expect(page.getByText("Unapplied JSON changes")).toHaveCount(0);
    await page.getByRole("button", { name: "Visual form" }).click();
    await expect(page.getByLabel("Accessible name")).toHaveValue("{{data.label}}");
    await expect(page.getByLabel("Exact")).not.toBeChecked();
    const saving = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith("/draft"));
    await page.getByRole("button", { name: "Save draft" }).click();
    const draft = (await (await saving).json()).data;
    expect(draft.content).toEqual(source);
    await acknowledgeOperation(page, "Saved");
    const session = (await (await page.request.get("/api/v1/auth/session")).json()).data;
    const base = `/api/v1/workspaces/${resource.workspaceId}/resources/${resource.id}`;
    const changed = await page.request.put(base + "/draft", {
        headers: {
            Origin: "http://127.0.0.1:5173",
            "X-CSRF-Token": session.csrfToken,
        },
        data: {
            revision: draft.revision,
            content: {
                ...source,
                document: {
                    ...source.document,
                    elements: source.document.elements.map((e, i) => (i ? e : { ...e, recordKey: "remote" })),
                },
            },
        },
    });
    expect(changed.status()).toBe(200);
    const saveElement = page.locator(".vq-item").filter({
        has: page
            .getByRole("textbox", { name: "Element key", exact: true })
            .and(page.locator('input[value="literal"]')),
    });
    await expect(saveElement).toHaveCount(1);
    await saveElement.getByLabel("Record key", { exact: true }).fill("local");
    await page.getByRole("button", { name: "Save draft" }).click();
    await acknowledgeOperation(page, "STALE_REVISION", "failed");
    await expect(page.getByRole("heading", { name: "The remote draft changed" }).locator("..")).toBeVisible();
    await expect(saveElement.getByLabel("Record key", { exact: true })).toHaveValue("local");
    await page.getByRole("button", { name: "Keep local content with remote revision" }).click();
    await page.getByRole("button", { name: "Save draft" }).click();
    await acknowledgeOperation(page, "Saved");
    const retained = (await (await page.request.get(base + "/draft")).json()).data;
    expect(retained.content.document.elements[0].recordKey).toBe("local");
    expect(retained.revision).toBe(draft.revision + 2);
    page.off("request", record);
    const second = await page.request.post("/api/v1/workspaces", {
        headers: {
            Origin: "http://127.0.0.1:5173",
            "X-CSRF-Token": session.csrfToken,
        },
        data: { key: "editor-isolation", name: "Editor isolation" },
    });
    expect(second.status()).toBe(201);
    await page.goto("/resources/element-catalogs");
    const secondWorkspace = (await second.json()).data;
    await openWorkspaceMenu(page);
    await expect(workspaceOption(page, secondWorkspace.id)).toHaveText("Editor isolation");
    await chooseWorkspace(page, ownWorkspace.id);
    await page.getByRole("button", { name: "Conflict catalog" }).click();
    await page.getByRole("button", { name: "JSON source" }).click();
    await replaceJson("{ invalid");
    await page.getByRole("button", { name: "Apply JSON" }).click();
    await acknowledgeOperation(page, /JSON/u, "failed");
    await closeResourceEditor(page);
    await chooseWorkspace(page, secondWorkspace.id);
    await expect(page.getByRole("article")).toHaveCount(0);
    await expect(page.getByText("Unapplied JSON changes")).toHaveCount(0);
    await expect(page.getByText("No resources in this Workspace.")).toBeVisible();
});

test("fixture binding picker exposes declared initial variables without future outputs", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("textbox", { name: "Email" }).fill("browser-admin@example.com");
    await page.getByLabel("Password").fill("Browser password 123!");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("dl")).toBeVisible();
    const session = (await (await page.request.get("/api/v1/auth/session")).json()).data;
    const response = await page.request.post("/api/v1/workspaces", {
        headers: {
            Origin: "http://127.0.0.1:5173",
            "X-CSRF-Token": session.csrfToken,
        },
        data: { key: "editor-bindings", name: "Binding editor" },
    });
    expect(response.status()).toBe(201);
    const workspace = (await response.json()).data;
    await page.goto("/resources/datasets");
    await chooseWorkspace(page, workspace.id);
    await openResourceCreateForm(page, "CASE");
    await resourceCreateForm(page).getByLabel("Key", { exact: true }).fill("bindings");
    await resourceCreateForm(page).getByLabel("Name", { exact: true }).fill("Binding source");
    await page.getByRole("button", { name: "Create resource" }).click();
    await acknowledgeOperation(page, "Resource created");
    await page
        .getByRole("heading", { name: "Initial variable declarations" })
        .locator("..")
        .getByLabel("Name")
        .fill("initialAnswer");
    await page.getByRole("button", { name: "Add Initial variable declarations" }).click();
    await page
        .getByRole("textbox", {
            name: "Fixture input bindings Field name",
            exact: true,
        })
        .fill("answer");
    await page
        .locator(".vq-value")
        .filter({
            has: page.getByRole("textbox", { name: "Fixture input bindings Field name", exact: true }),
        })
        .getByRole("button", { name: "Add field", exact: true })
        .click();
    const picker = page.getByRole("combobox", {
        name: "Fixture input bindings.answer Insert binding",
        exact: true,
    });
    await expect(picker).toBeVisible();
    await picker.press("Enter");
    const bindings = page.getByRole("listbox");
    await expect(bindings.getByRole("option")).toHaveText(["Select binding", "{{vars.initialAnswer}}"]);
    await bindings.getByRole("option", { name: "{{vars.initialAnswer}}", exact: true }).click();
    await expect(
        page.getByRole("textbox", {
            name: "Fixture input bindings.answer",
            exact: true,
        }),
    ).toHaveValue("{{vars.initialAnswer}}");
});

test("T11-R1 schema add/remove/add preserves existing property constraints", async ({ page }) => {
    await editorScope(page, "fix1-schema");
    await createResource(page, "FIXTURE", "schema-survivor");
    const section = page.getByRole("heading", { name: "Input schema", exact: true }).locator("..");
    await section
        .getByRole("button", {
            name: "Add schema property",
            exact: true,
        })
        .click();
    await section
        .getByRole("button", {
            name: "Add schema property",
            exact: true,
        })
        .click();
    await selectResourceOption(
        page.getByRole("combobox", {
            name: "Input schema.field_2 type",
            exact: true,
        }),
        "integer",
    );
    const initial = await saveDraft(page);
    if (initial.content.kind !== "FIXTURE") throw new Error("Expected fixture");
    const surviving = {
        type: "integer",
        minimum: 7,
        maximum: 31,
        description: "Keep this contract",
    };
    await applyDocument(page, {
        ...initial.content,
        document: {
            ...initial.content.document,
            inputSchema: {
                type: "object",
                properties: { field_1: { type: "string" }, field_2: surviving },
                required: ["field_2"],
            },
        },
    });
    const first = page
        .getByRole("textbox", {
            name: "Input schema property field_1",
            exact: true,
        })
        .locator("..")
        .locator("..");
    await first.getByRole("button", { name: "Remove", exact: true }).click();
    await section
        .getByRole("button", {
            name: "Add schema property",
            exact: true,
        })
        .click();
    const saved = await saveDraft(page);
    if (saved.content.kind !== "FIXTURE") throw new Error("Expected fixture");
    expect(saved.content.document.inputSchema).toMatchObject({
        type: "object",
        properties: { field_2: surviving },
        required: ["field_2"],
    });
    expect(Object.keys(saved.content.document.inputSchema.properties as object)).toHaveLength(2);
});

test("T11-R2 BEFORE and AFTER observer choices match actual compiler phases", async ({ page }) => {
    test.setTimeout(180_000);
    const scope = await editorScope(page, "fix1-phases");
    const compiler = await managedCompiler(page, scope);
    try {
        await createResource(page, "ELEMENT_CATALOG", "phase-catalog");
        await saveDraft(page);
        const catalog = await compiler.publish();
        await createResource(page, "CASE", "phase-case");
        await selectResourceOption(page.getByLabel("Catalog version"), new RegExp(` · ${catalog.id}$`));
        await selectResourceOption(page.getByRole("combobox", { name: "Action", exact: true }), "apiRequest");
        await page.getByLabel("Origin-relative path", { exact: true }).fill("/status");
        await page.getByRole("button", { name: "Add Observers" }).click();
        await page.getByLabel("Observer ID").fill("save");
        await page.getByLabel("Exact path").fill("/status");
        await page.getByRole("button", { name: "Add Before assertions" }).click();
        const before = page
            .getByRole("heading", { name: "Before assertions" })
            .locator("..")
            .getByLabel("Assertion type");
        await before.press("Enter");
        const types = page.getByRole("listbox");
        for (const name of ["httpStatus", "responseField", "requestCount"]) {
            await expect(types.getByRole("option", { name, exact: true })).toHaveCount(0);
        }
        await types.getByRole("option", { name: "url", exact: true }).click();
        await page.getByRole("button", { name: "Add After assertions" }).click();
        await selectResourceOption(
            page.getByRole("heading", { name: "After assertions" }).locator("..").getByLabel("Assertion type"),
            "httpStatus",
        );
        const source = page
            .getByRole("heading", { name: "After assertions" })
            .locator("..")
            .getByLabel("Network source");
        await source.press("Enter");
        const sources = page.getByRole("listbox");
        await expect(sources.getByRole("option")).toHaveText(["response:save"]);
        await sources.getByRole("option", { name: "response:save", exact: true }).click();
        await saveDraft(page);
        const version = await compiler.publish();
        expect(version.content.kind).toBe("CASE");
    } finally {
        await compiler.close();
    }
});

test("T11-R3 reusable flow/template page keys round-trip and resolve only in caller scope", async ({ page }) => {
    test.setTimeout(240_000);
    const scope = await editorScope(page, "fix1-pages");
    const compiler = await managedCompiler(page, scope);
    try {
        await createResource(page, "ELEMENT_CATALOG", "page-catalog");
        await saveDraft(page);
        const catalog = await compiler.publish();
        await createResource(page, "FLOW", "caller-flow");
        await selectResourceOption(page.getByRole("combobox", { name: "Action", exact: true }), "click");
        await page.getByLabel("Action page").fill("detail");
        const flowSource: ResourceDocumentV1 = {
            kind: "FLOW",
            document: {
                schemaVersion: "1.0",
                steps: [
                    { id: "caller", action: "click", target: "name", pageKey: "detail" },
                    {
                        id: "capture",
                        action: "click",
                        target: "name",
                        pageKey: "detail",
                        observers: [{ id: "local", kind: "newPage", pageKey: "inside" }],
                    },
                    {
                        id: "local-child",
                        action: "click",
                        target: "name",
                        pageKey: "inside",
                    },
                ],
            },
        };
        await applyDocument(page, flowSource);
        await expect(
            page
                .locator(".vq-item")
                .filter({
                    has: page.getByLabel("Step ID", { exact: true }).and(page.locator('input[value="caller"]')),
                })
                .getByLabel("Action page"),
        ).toHaveValue("detail");
        const flowDraft = await saveDraft(page);
        expect(flowDraft.content).toEqual(flowSource);
        const flow = await compiler.publish();
        await createResource(page, "ASSERTION_TEMPLATE", "caller-template");
        await page.getByLabel("Page (omit for original page)").fill("detail");
        const templateSource: ResourceDocumentV1 = {
            kind: "ASSERTION_TEMPLATE",
            document: {
                schemaVersion: "1.0",
                assertions: [
                    {
                        id: "visible",
                        type: "ui",
                        target: "name",
                        pageKey: "detail",
                        operator: "visible",
                        expected: true,
                        severity: "BLOCK",
                        expectedSource: "REQ caller page",
                    },
                ],
            },
        };
        await applyDocument(page, templateSource);
        await expect(page.getByLabel("Page (omit for original page)")).toHaveValue("detail");
        expect((await saveDraft(page)).content).toEqual(templateSource);
        const template = await compiler.publish();
        await createResource(page, "CASE", "caller-case");
        const callerSource: ResourceDocumentV1 = {
            kind: "CASE",
            document: {
                schemaVersion: "1.0",
                caseKey: "caller-case",
                title: "Caller pages",
                kind: "READ",
                roleKey: "reader",
                catalogVersionId: catalog.id,
                steps: [
                    {
                        id: "capture",
                        action: "click",
                        target: "name",
                        observers: [{ id: "popup", kind: "newPage", pageKey: "detail" }],
                    },
                    {
                        id: "flow",
                        action: "callFlow",
                        versionId: flow.id,
                        afterAssertions: [
                            {
                                id: "template",
                                type: "template",
                                versionId: template.id,
                                severity: "BLOCK",
                                expectedSource: "REQ caller scope",
                            },
                        ],
                    },
                    {
                        id: "after-flow",
                        action: "click",
                        target: "name",
                        pageKey: "detail",
                    },
                ],
            },
        };
        await applyDocument(page, callerSource);
        const callerPages = page
            .locator(".vq-item")
            .filter({
                has: page.getByLabel("Step ID", { exact: true }).and(page.locator('input[value="after-flow"]')),
            })
            .getByLabel("Action page");
        await expect(callerPages).toHaveText("detail");
        await callerPages.press("Enter");
        const availablePages = page.getByRole("listbox");
        await expect(availablePages.getByRole("option")).toHaveText(["—", "detail"]);
        await page.keyboard.press("Escape");
        await expect(callerPages).toBeFocused();
        expect((await saveDraft(page)).content).toEqual(callerSource);
        await compiler.publish();
        // 导入文档里的未解析引用仍应以原始标识清晰显示在编辑器中，不能把它冒充为当前空间已有页面；断言保留引用值以便用
        // 户后续通过支持的真实资产流程修复。
        const invalid: ResourceDocumentV1 = {
            ...callerSource,
            document: {
                ...callerSource.document,
                steps: [
                    callerSource.document.steps[0],
                    ...callerSource.document.steps.slice(1, 2),
                    {
                        id: "after-flow",
                        action: "click",
                        target: "name",
                        pageKey: "inside",
                    },
                ],
            },
        };
        await applyDocument(page, invalid);
        await expect(callerPages).toContainText("inside");
        await callerPages.press("Enter");
        const unavailablePage = page.getByRole("option", { name: /inside/ });
        await expect(unavailablePage).toBeDisabled();
        await page.keyboard.press("Escape");
        await saveDraft(page);
        const failed = await queueValidation(page);
        await compiler.compile();
        await expect
            .poll(
                async () =>
                    (await (await page.request.get(`/api/v1/workspaces/${scope.workspaceId}/jobs/${failed.id}`)).json())
                        .data.outcome,
            )
            .toBe("ERROR");
        expect(
            (
                await page.request.get(`/api/v1/workspaces/${scope.workspaceId}/jobs/${failed.id}/validation-receipt`)
            ).status(),
        ).toBe(409);
        await expect(page.getByRole("button", { name: "Publish version" })).toBeDisabled();
    } finally {
        await compiler.close();
    }
});

test("T11-R4 delayed real J1 receipt cannot validate a saved candidate or queued J2", async ({ page }) => {
    test.setTimeout(180_000);
    const scope = await editorScope(page, "fix1-receipt");
    const compiler = await managedCompiler(page, scope);
    let heldJob = "";
    let receipts: Awaited<ReturnType<typeof holdValidationReceipt>> | undefined;
    await withCleanup(
        async () => {
            receipts = await holdValidationReceipt(
                page,
                (url) =>
                    url.origin === "http://127.0.0.1:5173" &&
                    url.pathname === `/api/v1/workspaces/${scope.workspaceId}/jobs/${heldJob}/validation-receipt`,
            );
            await createResource(page, "ELEMENT_CATALOG", "receipt-catalog");
            const firstDraft = await saveDraft(page);
            const j1 = await queueValidation(page);
            heldJob = j1.id;
            await compiler.compile();
            await receipts.holding();
            await page
                .getByRole("dialog")
                .filter({ has: page.getByRole("article") })
                .getByRole("textbox", { name: "veriqId", exact: true })
                .fill("next-revision");
            const next = await saveDraft(page);
            expect(next.revision).toBe(firstDraft.revision + 1);
            const j2 = await queueValidation(page);
            expect(j2.id).not.toBe(j1.id);
            receipts.release();
            await receipts.delivered();
            // 等待下一次真实 J2 状态轮询再核对界面，使旧回调获得浏览器和渲染调度机会，避免凭切换后立即出现的新内容
            // 误判迟到响应已被隔离；屏障只持有一次 J1 回执，后续 J2 请求仍正常到达服务器。
            await page.waitForResponse((response) => response.url().endsWith(`/jobs/${j2.id}`));
            await expect(
                page.getByText(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} · /),
            ).toHaveCount(0);
            await expect(page.getByRole("button", { name: "Publish version" })).toBeDisabled();
            await compiler.compile();
            await acknowledgeOperation(page, "Compilation validated");
            await expect(
                page.getByText(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} · /),
            ).toBeVisible({
                timeout: 20_000,
            });
            const receipt = (
                await (
                    await page.request.get(`/api/v1/workspaces/${scope.workspaceId}/jobs/${j2.id}/validation-receipt`)
                ).json()
            ).data;
            expect(receipt.revision).toBe(next.revision);
            await expect(
                page.getByText(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} · /),
            ).toContainText(receipt.id);
            await expect(page.getByRole("button", { name: "Publish version" })).toBeEnabled();
            if (next.content.kind !== "ELEMENT_CATALOG") throw new Error("Expected catalog");
            await applyDocument(page, {
                ...next.content,
                document: {
                    ...next.content.document,
                    elements: [{ key: "name", locator: { by: "veriqId", value: "applied-only" } }],
                },
            });
            await expect(
                page.getByText(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} · /),
            ).toHaveCount(0);
            await expect(page.getByRole("button", { name: "Publish version" })).toBeDisabled();
        },
        () =>
            withCleanup(
                async () => {
                    await receipts?.close();
                },
                () => compiler.close(),
            ),
    );
});

/**
 * 通过真实资源创建、JSON Apply 和草稿保存观察字符串及混合 JSON 数组，重复值不能合并节点，输入不能重挂载，删除祖先行必
 * 须保留嵌套存活节点，最终正文只能含原始业务值而无私有行标记。
 */
test("primitive rows preserve focused survivors and persist only business values", async ({ page }) => {
    await editorScope(page, `primitive-rows-${randomUUID()}`);
    await createResource(page, "DATASET", `primitive-dataset-${randomUUID()}`);
    const dataset: ResourceDocumentV1 = {
        kind: "DATASET",
        document: {
            schemaVersion: "1.0",
            columns: { payload: "array" },
            rows: [
                {
                    key: "row_1",
                    values: { payload: ["same", "same", "", ["same", "same"], { flag: true }] },
                },
            ],
        },
    };
    await applyDocument(page, dataset);
    const nested = page.getByRole("textbox", { name: "payload[3][1]", exact: true });
    const survivor = await nested.elementHandle();
    if (!survivor) throw new Error("Missing nested primitive row");
    await nested.focus();
    await nested.press("End");
    await nested.pressSequentially(" edited");
    await expect(nested).toHaveValue("same edited");
    expect(await survivor.evaluate((node) => node === document.activeElement)).toBe(true);
    const root = page.getByRole("heading", { name: "payload (array)", exact: true }).locator("..");
    const addValue = root.getByRole("button", { name: "Add value", exact: true }).last();
    // 原生 click 激活前面的删除按钮而不把键盘焦点移到该按钮，以便直接观察存活输入节点的焦点；不改写 DOM、值或产品事件处
    // 理，增删仍完全经过真实 React 控件。
    await root
        .getByRole("button", { name: "Remove 0", exact: true })
        .first()
        .evaluate((button) => (button as HTMLButtonElement).click());
    const shifted = page.getByRole("textbox", { name: "payload[2][1]", exact: true });
    await expect(shifted).toHaveValue("same edited");
    expect(await shifted.evaluate((node, retained) => node === retained, survivor)).toBe(true);
    expect(await survivor.evaluate((node) => node === document.activeElement)).toBe(true);
    await addValue.click();
    await root.getByRole("button", { name: "Remove 4", exact: true }).click();
    await addValue.click();
    const expected: ResourceDocumentV1 = {
        ...dataset,
        document: {
            ...dataset.document,
            rows: [
                {
                    key: "row_1",
                    values: { payload: ["same", "", ["same", "same edited"], { flag: true }, ""] },
                },
            ],
        },
    };
    expect((await saveDraft(page)).content).toEqual(expected);
    // 相同长度以及更短、更长的权威导入都开启新行生命周期，不能把旧重复值的标记猜测成新数组身份；每轮都经受支持的 JSON
    // Apply 保存并读取服务端实际草稿。
    for (const payload of [["fresh", "", ["x", "y"], { flag: false }, ""], [], ["a", "b", "c", "d", "e", "f"]]) {
        const replacement: ResourceDocumentV1 = {
            ...dataset,
            document: { ...dataset.document, rows: [{ key: "row_1", values: { payload } }] },
        };
        await applyDocument(page, replacement);
        expect(await survivor.evaluate((node) => node.isConnected)).toBe(false);
        expect((await saveDraft(page)).content).toEqual(replacement);
    }
    await createResource(page, "ENVIRONMENT", `primitive-environment-${randomUUID()}`);
    const environment = (await saveDraft(page)).content;
    if (environment.kind !== "ENVIRONMENT") throw new Error("Expected environment document");
    const origins: [string, ...string[]] = ["http://one.example", "http://two.example", "http://two.example"];
    const [firstRole, ...otherRoles] = environment.document.roles;
    if (!firstRole) throw new Error("Expected environment role");
    await applyDocument(page, {
        ...environment,
        document: { ...environment.document, allowedOrigins: origins, roles: [firstRole, ...otherRoles] },
    });
    const group = page.getByRole("group", { name: "Allowed origins", exact: true });
    const last = group.getByRole("textbox", { name: "Allowed origins 3", exact: true });
    const stringSurvivor = await last.elementHandle();
    if (!stringSurvivor) throw new Error("Missing string row");
    await last.focus();
    await last.press("End");
    await last.pressSequentially("/path");
    await group
        .getByRole("button", { name: "Remove", exact: true })
        .first()
        .evaluate((button) => (button as HTMLButtonElement).click());
    const remaining = group.getByRole("textbox", { name: "Allowed origins 2", exact: true });
    expect(await remaining.evaluate((node, retained) => node === retained, stringSurvivor)).toBe(true);
    expect(await stringSurvivor.evaluate((node) => node === document.activeElement)).toBe(true);
    await group.getByRole("button", { name: "Add Allowed origins" }).click();
    await group.getByRole("button", { name: "Remove", exact: true }).last().click();
    await group.getByRole("button", { name: "Add Allowed origins" }).click();
    await group.getByRole("textbox", { name: "Allowed origins 3", exact: true }).fill("http://three.example");
    expect((await saveDraft(page)).content).toEqual({
        ...environment,
        document: {
            ...environment.document,
            allowedOrigins: ["http://two.example", "http://two.example/path", "http://three.example"],
        },
    });
    await createResource(page, "CASE", `field-labels-${randomUUID()}`);
    // 关联检查跨越文本、枚举、数字、复选框及版本下拉分支，并保留原有测试标识与 RHF 输入；只检查真实
    // input.labels/htmlFor/id，不把可见文字或 aria-label 当作标签关联的替代品。
    for (const label of ["Title", "Case kind", "Timeout", "Critical", "Catalog version"]) {
        expect(
            await page.getByLabel(label).evaluate((element) => {
                const control = element as HTMLInputElement | HTMLSelectElement;
                return (
                    !!control.id && [...(control.labels ?? [])].some((fieldLabel) => fieldLabel.htmlFor === control.id)
                );
            }),
        ).toBe(true);
    }
});

/**
 * 通过实际服务端编译与发布接口为编辑流程创建固定数据版本，调用者可以继续核对可见控件和保存的草稿。
 */
async function publishWriterDataset(page: Page, scope: Awaited<ReturnType<typeof editorScope>>) {
    const source = await createResource(page, "DATASET", "source-data");
    await saveDraft(page);
    const job = await queueValidation(page);
    const compiler = await managedCompiler(page, scope);
    await withCleanup(compiler.compile, compiler.close);
    const base = "/api/v1/workspaces/" + scope.workspaceId;
    const receipt = await page.request.get(base + "/jobs/" + job.id + "/validation-receipt");
    expect(receipt.status(), await receipt.text()).toBe(200);
    const frozen = (await receipt.json()).data;
    await expect(page.getByRole("dialog", { name: "Operation succeeded", exact: true })).toContainText(frozen.id);
    await acknowledgeOperation(page, "Compilation validated");
    const publication = await page.request.post(base + "/resources/" + source.id + "/publish", {
        headers: scope.headers,
        data: { revision: frozen.revision, validationReceiptId: frozen.id },
    });
    expect(publication.status(), await publication.text()).toBe(201);
    return (await publication.json()).data;
}

/**
 * 已上线的编译服务仍负责执行和签发回执；拦截一个真实回执的首次读取失败，用以验证对话框中重试原作业。
 */
test("dataset JSON actions report their results and keep compiler feedback in one dialog", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1280, height: 800 });
    const { workspaceId, headers } = await editorScope(page, `dataset-json-feedback-${randomUUID()}`);
    const base = `/api/v1/workspaces/${workspaceId}/resources`;
    const content = {
        kind: "DATASET",
        document: {
            schemaVersion: "2.0",
            shape: "TABLE",
            fields: { label: { type: "string", required: true, nullable: false } },
            source: { kind: "STATIC", rows: [{ key: "before", values: { label: "Original" } }] },
        },
    };
    const created = await page.request.post(base, {
        headers,
        data: { kind: "DATASET", name: "JSON feedback dataset", key: "json_feedback_dataset", content },
    });
    expect(created.status(), await created.text()).toBe(201);
    const { id } = (await created.json()).data;
    await page.goto(`/resources/datasets/${id}?workspaceId=${workspaceId}`);
    await page.getByRole("tab", { name: "Data (JSON)", exact: true }).click();
    const panel = page.getByRole("tabpanel", { name: "Data (JSON)", exact: true });
    const discard = panel.getByRole("button", { name: "Discard JSON changes", exact: true });
    const apply = panel.getByRole("button", { name: "Apply JSON", exact: true });
    const save = panel.getByRole("button", { name: "Save draft", exact: true });
    const publish = panel.getByRole("button", { name: "Publish version", exact: true });
    await replaceEditorJson(page, "{");
    await apply.click();
    await acknowledgeOperation(page, /JSON|property name/, "failed");
    await discard.click();
    await acknowledgeOperation(page, "JSON changes discarded");
    await expect(discard).toBeFocused();

    content.document.source.rows[0].values.label = "Updated locally";
    await replaceEditorJson(page, JSON.stringify(content));
    await apply.click();
    await acknowledgeOperation(page, "JSON applied to the draft editor");
    await save.click();
    await acknowledgeOperation(page, "Saved");
    await chooseLanguage(page, "zh");
    const compile = page.getByRole("button", { name: "编译校验", exact: true });

    // 暂缓浏览器收到首个回执的时机，以便先观察已打开的进度弹窗，再通过当前作业回执的重试确认成功。
    const receipt = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await page.route(
        (url) =>
            url.pathname.startsWith(`/api/v1/workspaces/${workspaceId}/jobs`) &&
            url.pathname.endsWith("/validation-receipt"),
        async (route) => {
            receipt.resolve();
            await release.promise;
            await route.abort("failed");
        },
        { times: 1 },
    );
    const waiting = page.getByRole("dialog", { name: "正在处理", exact: true });
    const compilationFailed = page.getByRole("dialog", { name: "操作失败", exact: true });
    const compiled = page.getByRole("dialog", { name: "操作成功", exact: true });
    const compiler = await managedCompiler(page, { workspaceId }, "dataset-json-feedback");
    const queuedResponse = page.waitForResponse((response) => response.url().endsWith(`/${id}/validate`));
    try {
        await compile.click();
        const queued = await queuedResponse;
        expect(queued.status(), await queued.text()).toBe(202);
        await expect(waiting).toBeVisible();
        await expect(waiting).toContainText("编译");
        await waiting.evaluate((dialog) => dialog.setAttribute("data-test-original-dialog", "true"));
        await compiler.compile();
        await receipt.promise;
    } finally {
        release.resolve();
        await compiler.close();
    }
    await expect(compilationFailed).toHaveAttribute("data-test-original-dialog", "true");
    await expect(compilationFailed).toContainText("无法读取编译校验回执");
    const proved = page.waitForResponse((response) => response.url().endsWith("/validation-receipt") && response.ok());
    await compilationFailed.getByRole("button", { name: "重试", exact: true }).click();
    await expect(compiled).toHaveAttribute("data-test-original-dialog", "true");
    const compileStatus = compiled.getByRole("status");
    await expect(compileStatus).toHaveText("编译已结束 · 通过");
    await expect(compiled.getByText("编译校验通过", { exact: true })).toHaveCount(0);
    await expect(compileStatus).toHaveCSS("color", "rgb(24, 91, 64)");
    const proof = (await (await proved).json()).data;
    for (const value of [proof.id, proof.engineVersion, proof.sourceHash, proof.compiledBundleSha256]) {
        await expect(compiled).not.toContainText(value);
    }
    await compiled.getByRole("button", { name: "确定", exact: true }).click();
    await expect(compiled).toBeHidden();
    await expect(compile).toBeFocused();
    await chooseLanguage(page, "en");
    const succeeded = page.getByRole("dialog", { name: "Operation succeeded", exact: true });
    const failed = page.getByRole("dialog", { name: "Operation failed", exact: true });
    await expect(panel.getByText(/Compilation finished|No successful validation receipt/)).toHaveCount(0);

    await expect(save).toHaveClass(/\bvq-btn-secondary\b/u);
    await expect(publish).toHaveClass(/\bvq-btn-primary\b/u);
    let requeued = 0;
    page.on("request", (request) => {
        if (request.method() === "POST" && request.url().endsWith(`/${id}/validate`)) requeued++;
    });
    const published = page.waitForResponse((response) => response.url().endsWith(`/${id}/publish`));
    await publish.click();
    const versionResponse = await published;
    expect(versionResponse.status(), await versionResponse.text()).toBe(201);
    const version = (await versionResponse.json()).data;
    expect(versionResponse.request().postDataJSON()).toEqual({
        revision: proof.revision,
        validationReceiptId: proof.id,
    });
    await expect(succeeded).toContainText("Version published");
    for (const value of [`v${version.versionNo}`, version.id, version.sha256]) {
        await expect(succeeded).not.toContainText(value);
    }
    await acknowledgeOperation(page, "Version published");
    expect(requeued).toBe(0);
    await page.getByRole("tab", { name: "Versions", exact: true }).click();
    const versions = page.getByRole("tabpanel", { name: "Versions", exact: true });
    await expect(versions.getByRole("combobox", { name: "Base version" })).toContainText(
        `v${version.versionNo} · ${version.sha256}`,
    );
    await page.getByRole("tab", { name: "Data (JSON)", exact: true }).click();

    // 重复行键可以编辑和保存，但必须被真实编译器拒绝；图形页签也只能在对话框中看到该作业诊断。
    content.document.source.rows.push({ key: "before", values: { label: "Duplicate row key" } });
    await replaceEditorJson(page, JSON.stringify(content));
    await apply.click();
    await acknowledgeOperation(page, "JSON applied to the draft editor");
    await save.click();
    await acknowledgeOperation(page, "Saved");
    await page.getByRole("tab", { name: "Data (Form)", exact: true }).click();
    const form = page.getByRole("tabpanel", { name: "Data (Form)", exact: true });
    const badJob = await queueValidation(page);
    const badCompiler = await managedCompiler(page, { workspaceId }, "dataset-json-diagnostics");
    await withCleanup(badCompiler.compile, badCompiler.close);
    await expect(failed.getByRole("list", { name: "Compiler diagnostics" })).toContainText("DATASET_DUPLICATE_ROW_KEY");
    await acknowledgeOperation(page, "Compilation validation failed", "failed");
    await expect(form.getByText("DATASET_DUPLICATE_ROW_KEY", { exact: true })).toHaveCount(0);
    await expect(form.getByRole("button", { name: "Publish version", exact: true })).toBeDisabled();
    const status = await page.request.get(`/api/v1/workspaces/${workspaceId}/jobs/${badJob.id}`);
    expect((await status.json()).data).toMatchObject({ state: "FINISHED", outcome: "ERROR" });
});

/**
 * 没有回执时，发布按钮必须通过真实编译作业获得当前回执，成功后继续发布，同一对话框也要报告编译失败。
 */
test("dataset JSON publishes after real compilation and stops on unsafe drafts", async ({ page }) => {
    test.setTimeout(120_000);
    const scope = await editorScope(page, `json-autopublish-${randomUUID()}`);
    const dataset = await createResource(page, "DATASET", "json_auto_publish");
    const base = `/api/v1/workspaces/${scope.workspaceId}`;
    const source = `${base}/resources/${dataset.id}`;
    await page.getByRole("tab", { name: "Data (JSON)", exact: true }).click();
    const publish = page.getByRole("button", { name: "Publish version", exact: true });
    await expect(publish).toBeEnabled();
    const writes: string[] = [];
    page.on("request", (request) => {
        if (["PUT", "POST"].includes(request.method()) && new URL(request.url()).pathname.startsWith(`${source}/`)) {
            writes.push(new URL(request.url()).pathname);
        }
    });
    await replaceEditorJson(page, "{");
    await publish.click();
    await acknowledgeOperation(page, /Unapplied JSON changes/u, "failed");
    expect(writes).toEqual([]);
    await page.getByRole("button", { name: "Discard JSON changes", exact: true }).click();
    await acknowledgeOperation(page, "JSON changes discarded");

    const waiting = page.getByRole("dialog", { name: "Operation in progress", exact: true });
    const succeeded = page.getByRole("dialog", { name: "Operation succeeded", exact: true });
    const compiler = await managedCompiler(page, scope, "dataset-json-autopublish");
    const queued = page.waitForResponse((response) => response.url().endsWith(`${source}/validate`));
    const published = page.waitForResponse((response) => response.url().endsWith(`${source}/publish`));
    try {
        await publish.click();
        const jobResponse = await queued;
        expect(jobResponse.status(), await jobResponse.text()).toBe(202);
        const { id: jobId } = (await jobResponse.json()).data;
        await expect(waiting).toContainText(/compil/iu);
        await waiting.evaluate((dialog) => dialog.setAttribute("data-original-dialog", "true"));
        expect(writes).toEqual([`${source}/validate`]);
        await compiler.compile();
        const version = await published;
        expect(version.status(), await version.text()).toBe(201);
        const receipt = await page.request.get(`${base}/jobs/${jobId}/validation-receipt`);
        expect(receipt.status(), await receipt.text()).toBe(200);
        const { id, revision } = (await receipt.json()).data;
        expect(version.request().postDataJSON()).toEqual({ revision, validationReceiptId: id });
        await expect(succeeded).toHaveAttribute("data-original-dialog", "true");
        const publishedVersion = (await version.json()).data;
        for (const value of [`v${publishedVersion.versionNo}`, publishedVersion.id, publishedVersion.sha256]) {
            await expect(succeeded).not.toContainText(value);
        }
        await acknowledgeOperation(page, "Version published");
        expect(writes).toEqual([`${source}/validate`, `${source}/publish`]);

        // 重复键通过结构校验但被编译器拒绝，确认一次失败的编译没有触发第二次发布或隐式保存。
        const invalid = {
            kind: "DATASET",
            document: {
                schemaVersion: "2.0",
                shape: "TABLE",
                fields: { label: { type: "string", required: true, nullable: false } },
                source: {
                    kind: "STATIC",
                    rows: ["first", "second"].map((label) => ({ key: "duplicate", values: { label } })),
                },
            },
        };
        await replaceEditorJson(page, JSON.stringify(invalid));
        await page.getByRole("button", { name: "Apply JSON", exact: true }).click();
        await acknowledgeOperation(page, "JSON applied to the draft editor");
        await publish.click();
        await acknowledgeOperation(page, "Unsaved changes. Save before validation or publication.", "failed");
        expect(writes).toEqual([`${source}/validate`, `${source}/publish`]);
        await saveDraft(page);
        const failingQueue = page.waitForResponse((response) => response.url().endsWith(`${source}/validate`));
        await publish.click();
        const failingJob = await failingQueue;
        expect(failingJob.status(), await failingJob.text()).toBe(202);
        await compiler.compile();
        const failed = page.getByRole("dialog", { name: "Operation failed", exact: true });
        await expect(failed.getByRole("list", { name: "Compiler diagnostics" })).toContainText(
            "DATASET_DUPLICATE_ROW_KEY",
        );
        await acknowledgeOperation(page, "Compilation validation failed", "failed");
        expect(writes).toEqual([`${source}/validate`, `${source}/publish`, `${source}/draft`, `${source}/validate`]);
    } finally {
        await compiler.close();
    }
});

/**
 * 暂缓已签发的有效回执并从另一请求更新草稿；回执送回时不得提交发布，请求必须提示用户处理新的修订。
 */
test("dataset JSON refuses an automatic publication after the saved revision moves", async ({ page }) => {
    test.setTimeout(90_000);
    const scope = await editorScope(page, `json-stale-publish-${randomUUID()}`);
    const dataset = await createResource(page, "DATASET", "json_stale_publish");
    const base = `/api/v1/workspaces/${scope.workspaceId}`;
    const source = `${base}/resources/${dataset.id}`;
    const initial = await page.request.get(`${source}/draft`);
    expect(initial.status(), await initial.text()).toBe(200);
    const { revision, content } = (await initial.json()).data;
    await page.getByRole("tab", { name: "Data (JSON)", exact: true }).click();
    const published: string[] = [];
    page.on("request", (request) => {
        if (request.method() === "POST" && request.url().endsWith(`${source}/publish`)) published.push(request.url());
    });
    const compiler = await managedCompiler(page, scope, "dataset-json-stale");
    const receipt = await holdValidationReceipt(
        page,
        (url) => url.pathname.startsWith(`${base}/jobs/`) && url.pathname.endsWith("/validation-receipt"),
    );
    await withCleanup(
        async () => {
            const queued = page.waitForResponse((response) => response.url().endsWith(`${source}/validate`));
            await page.getByRole("button", { name: "Publish version", exact: true }).click();
            const job = await queued;
            expect(job.status(), await job.text()).toBe(202);
            await compiler.compile();
            await receipt.holding();
            content.document.source.rows[0].values.name = "Saved by another session";
            const updated = await page.request.put(`${source}/draft`, {
                headers: scope.headers,
                data: { revision, content },
            });
            expect(updated.status(), await updated.text()).toBe(200);
            expect((await updated.json()).data.revision).toBe(revision + 1);
            receipt.release();
            await receipt.delivered();
            await acknowledgeOperation(page, /STALE_REVISION/u, "failed");
            expect(published).toEqual([]);
            await expect(page.getByRole("button", { name: "Reload remote draft", exact: true })).toBeVisible();
        },
        () => withCleanup(receipt.close, compiler.close),
    );
});

/**
 * 发布已收到实际编译回执时仍可关闭等待框；正在读取的发布前预览须取消，确认不会再向控制服务发送写入。
 */
test("closing automatic dataset JSON publication stops before the write", async ({ page }) => {
    test.setTimeout(90_000);
    const scope = await editorScope(page, `json-cancel-publish-${randomUUID()}`);
    const dataset = await createResource(page, "DATASET", "json_cancel_publish");
    const source = `/api/v1/workspaces/${scope.workspaceId}/resources/${dataset.id}`;
    await page.getByRole("tab", { name: "Data (JSON)", exact: true }).click();
    const publish = page.getByRole("button", { name: "Publish version", exact: true });
    const waiting = page.getByRole("dialog", { name: "Operation in progress", exact: true });
    const writes: string[] = [];
    page.on("request", (request) => {
        if (request.method() === "POST" && request.url().endsWith(`${source}/publish`)) writes.push(request.url());
    });
    const compiler = await managedCompiler(page, scope, "dataset-json-cancel");
    let preview: Awaited<ReturnType<typeof holdValidationReceipt>> | undefined;
    await withCleanup(
        async () => {
            const queued = page.waitForResponse((response) => response.url().endsWith(`${source}/validate`));
            await publish.click();
            const job = await queued;
            expect(job.status(), await job.text()).toBe(202);
            // 先等待编译任务入队，再暂缓下一次预览响应，使关闭等待框的断言只覆盖编译回执之后的最终检查。
            preview = await holdValidationReceipt(page, (url) => url.pathname === `${source}/validation-preview`);
            await compiler.compile();
            await preview.holding();
            await expect(waiting).toContainText("Publishing version");
            const aborted = page.waitForEvent("requestfailed", (request) =>
                request.url().endsWith(`${source}/validation-preview`),
            );
            await waiting.getByRole("button", { name: "Close", exact: true }).click();
            await aborted;
            preview.release();
            await preview.delivered();
            await expect(publish).toBeEnabled();
            expect(writes).toEqual([]);
        },
        () => withCleanup(async () => await preview?.close(), compiler.close),
    );
});

test("copy dataset opens an independent target draft", async ({ page }) => {
    test.setTimeout(180_000);
    const scope = await editorScope(page, "copy-source");
    const target = await page.request.post("/api/v1/workspaces", {
        headers: scope.headers,
        data: { key: "copy-target", name: "Copy target" },
    });
    expect(target.status()).toBe(201);
    const targetId = (await target.json()).data.id;
    await expect(page.getByRole("button", { name: "Copy dataset" })).toBeVisible();
    const version = await publishWriterDataset(page, scope);
    await closeResourceEditor(page);
    await page.reload();
    await chooseWorkspace(page, targetId);
    await page.getByRole("button", { name: "Copy dataset" }).click();
    const dialog = page.getByRole("dialog", { name: "Copy dataset" });
    await selectResourceOption(dialog.getByLabel("Source workspace"), scope.key);
    await selectResourceOption(
        dialog.getByLabel("Published version"),
        `source-data · source-data · v${version.versionNo}`,
    );
    await dialog.getByLabel("Key", { exact: true }).fill("checkout.copied-data");
    await dialog.getByLabel("Name", { exact: true }).fill("Copied data");
    const response = page.waitForResponse(
        (r) => r.url().endsWith("/dataset-copies") && r.request().method() === "POST",
    );
    await dialog.getByRole("button", { name: "Create draft" }).click();
    const copied = await response;
    expect(copied.status(), await copied.text()).toBe(201);
    await acknowledgeOperation(page, "Dataset draft copied");
    const resource = (await copied.json()).data;
    expect(resource.id).not.toBe(version.resourceId);
    expect(resource.key).toBe("checkout.copied-data");
    await expect(page.getByRole("main").getByRole("heading", { name: "Copied data", level: 1 })).toBeVisible();
    const draft = await page.request.get(`/api/v1/workspaces/${targetId}/resources/${resource.id}/draft`);
    expect((await draft.json()).data.content).toEqual(version.content);
});

test("copy dataset respects viewer and editor roles in the shared dialog", async ({ page, browser }) => {
    const target = await editorScope(page, `role-target-${randomUUID()}`);
    const source = await page.request.post("/api/v1/workspaces", {
        headers: target.headers,
        data: { key: `role-source-${randomUUID()}`, name: "Read only source" },
    });
    expect(source.status()).toBe(201);
    const sourceId = (await source.json()).data.id;
    const dataset = await page.request.post(`/api/v1/workspaces/${sourceId}/resources`, {
        headers: target.headers,
        data: {
            kind: "DATASET",
            key: "visible_dataset",
            name: "Visible dataset",
            content: {
                kind: "DATASET",
                document: {
                    schemaVersion: "2.0",
                    shape: "TABLE",
                    fields: { name: { type: "string", required: true, nullable: false } },
                    source: {
                        kind: "STATIC",
                        rows: Array.from({ length: 7 }, (_, index) => ({
                            key: `sample_${index + 1}`,
                            values: { name: `Example ${index + 1}` },
                        })),
                    },
                },
            },
        },
    });
    expect(dataset.status()).toBe(201);
    const email = [`dataset-member-${randomUUID()}`, "example.com"].join("@");
    const password = "Dataset member 123!";
    const origin = new URL(page.url()).origin;
    const member = await browser.newContext({ baseURL: origin });
    try {
        const user = await page.request.post("/api/v1/admin/users", {
            headers: target.headers,
            data: { email, displayName: "Dataset member", password, systemAdmin: false },
        });
        expect(user.status()).toBe(201);
        const setup = await member.request.get("/api/v1/setup");
        const login = await member.request.post("/api/v1/auth/login", {
            headers: { Origin: origin, "X-CSRF-Token": (await setup.json()).data.csrfToken },
            data: { email, password },
        });
        expect(login.status()).toBe(200);
        const headers = { Origin: origin, "X-CSRF-Token": (await login.json()).data.csrfToken };
        for (const [id, role] of [
            [sourceId, "VIEWER"],
            [target.workspaceId, "EDITOR"],
        ]) {
            const invite = await page.request.post(`/api/v1/workspaces/${id}/invitations`, {
                headers: target.headers,
                data: { email, role },
            });
            expect(invite.status()).toBe(201);
            const fragment = new URL((await invite.json()).data.invitationUrl).hash;
            const token = new URLSearchParams(fragment.slice(1)).get("token");
            expect(
                (await member.request.post("/api/v1/auth/invitations/accept", { headers, data: { token } })).status(),
            ).toBe(200);
        }
        const view = await member.newPage();
        await view.goto("/resources/datasets");
        await chooseWorkspace(view, sourceId);
        await expect(view.getByRole("cell", { name: "Visible dataset", exact: true })).toBeVisible();
        await expect(view.getByRole("button", { name: "Download", exact: true })).toBeDisabled();
        await expect(view.getByRole("button", { name: "New dataset", exact: true })).toBeDisabled();
        await expect(view.getByRole("button", { name: "Copy dataset" })).toHaveCount(0);
        await view.getByRole("link", { name: "Details for Visible dataset (visible_dataset)" }).click();
        const editor = view.getByRole("article");
        const size = editor.getByRole("combobox", { name: "Dataset rows per page" });
        await expect(size).toBeEnabled();
        await selectResourceOption(size, "5");
        await editor
            .getByRole("navigation", { name: "Dataset row pagination", exact: true })
            .getByRole("button", { name: "Next", exact: true })
            .click();
        const key = editor.getByRole("textbox", { name: "Row key", exact: true }).first();
        await expect(key).toHaveValue("sample_6");
        await expect(key).toBeDisabled();
        await expect(editor.getByRole("button", { name: "Add row", exact: true })).toBeDisabled();
        const downloads = editor.getByRole("button", { name: "Download", exact: true });
        await expect(downloads).toHaveCount(2);
        for (const download of await downloads.all()) await expect(download).toBeDisabled();
        await closeResourceEditor(view);
        await chooseWorkspace(view, target.workspaceId);
        const loaded = view.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/workspaces");
        await view.getByRole("button", { name: "Copy dataset" }).click();
        // 首次打开会读取当前会话的成员关系。这里检查实际查询完成后的候选列表，防止空加载状态伪装成正确过滤。
        const dialog = view.getByRole("dialog", { name: "Copy dataset" });
        await expect(dialog).toBeVisible();
        await loaded;
        await expect(dialog.getByRole("status")).toHaveCount(0);
        await dialog.getByLabel("Source workspace").press("Enter");
        const sources = view.getByRole("listbox");
        await expect(sources.getByRole("option")).toHaveText(["Select"]);
        await expect(sources.getByRole("option", { name: "Read only source" })).toHaveCount(0);
        await view.keyboard.press("Escape");
    } finally {
        await member.close();
    }
});

/**
 * 使用真实创建表单与草稿接口检验表格和树的两阶段导入，失败或成功预检均不得提前覆盖服务端数据。
 */
test("imports table and tree drafts with validation preview", async ({ page }) => {
    test.setTimeout(90_000);
    const scope = await editorScope(page, `static-import-${randomUUID()}`);
    for (const shape of ["TABLE", "TREE"]) {
        await closeResourceEditor(page);
        const form = await openResourceCreateForm(page, "DATASET");
        await expect(form.getByLabel("Dataset format")).toBeVisible();
        await selectResourceOption(
            form.getByLabel("Dataset format"),
            shape === "TABLE" ? "Static table" : "Static tree",
        );
        const key = "static_" + shape;
        await form.getByLabel("Key", { exact: true }).fill(key);
        await form.getByLabel("Name", { exact: true }).fill(key);
        const creating = page.waitForResponse((r) => r.url().endsWith("/resources") && r.request().method() === "POST");
        await form.getByRole("button", { name: "Create resource" }).click();
        const id = (await (await creating).json()).data.id;
        await acknowledgeOperation(page, "Resource created");
        const url = `/api/v1/workspaces/${scope.workspaceId}/resources/${id}/draft`;
        const original = (await (await page.request.get(url)).json()).data;
        const formTab = page.getByRole("tab", { name: "Data (Form)", exact: true });
        const importTab = page.getByRole("tab", { name: "Import", exact: true });
        await expect(page.getByLabel("Row key", { exact: true }).first()).toHaveValue("row_1");
        await importTab.click();
        const textFormat = page.getByRole("radio", { name: "Text", exact: true });
        const csvFormat = page.getByRole("radio", { name: "CSV", exact: true });
        await textFormat.check();
        const input = page.getByLabel("Import text");
        const preview = page.getByRole("button", { name: "Preview import" });
        const apply = page.getByRole("button", { name: "Apply import" });
        const tree = shape === "TREE";
        const header = tree ? "key,parentKey,order,name" : "key,name";
        const row = tree ? "leaf,root,3," : "leaf,";
        const sample = tree ? "root,,0,x,y" : `${row}x,y`;
        await input.fill(`${header},extra\n${sample}`);
        await preview.click();
        const mappings = page.getByRole("table", { name: "Imported column mapping" });
        await expect(mappings.getByRole("row", { name: "extra extra string" })).toBeVisible();
        await expect(apply).toBeEnabled();
        expect((await (await page.request.get(url)).json()).data).toEqual(original);
        await csvFormat.check();
        await expect(apply).toBeDisabled();
        await expect(input).toHaveCount(0);
        await textFormat.check();
        await input.fill(header + "\n" + row + "x\n" + row + "y");
        await preview.click();
        await expect(page.getByText("3 · key · DATASET_DUPLICATE_ROW_KEY")).toBeVisible();
        await expect(apply).toBeDisabled();
        if (tree) {
            await input.fill(header + "\n" + row + "x");
            await preview.click();
            await expect(page.getByText("2 · parentKey · DATASET_ORPHAN_NODE")).toBeVisible();
            await expect(apply).toBeDisabled();
        }
        const name = 'hello, "world"\r\n  again\n\tlast';
        const csv = header + "\n" + row + '"hello, ""world""\r\n  again\n\tlast"' + (tree ? "\nroot,,0,root" : "");
        await csvFormat.check();
        await page
            .getByLabel("Import file", { exact: true })
            .setInputFiles({ name: "rows.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
        await preview.click();
        await expect(apply).toBeEnabled();
        await apply.click();
        await acknowledgeOperation(page, "Import applied to the draft. Save the draft to keep the changes.");
        await formTab.click();
        await expect(page.getByLabel("Row key", { exact: true }).first()).toHaveValue("leaf");
        expect((await (await page.request.get(url)).json()).data).toEqual(original);
        const draft = await saveDraft(page);
        expect(draft.content.document).toMatchObject({
            shape,
            source: {
                rows: [
                    { key: "leaf", values: { name }, ...(tree ? { parentKey: "root", order: 3 } : {}) },
                    ...(tree ? [{ key: "root", values: { name: "root" }, parentKey: null, order: 0 }] : []),
                ],
            },
        });
        const cell = page.getByRole("article").getByRole("textbox", { name: "name", exact: true }).first();
        await expect(cell).toBeEditable();
        await expect(cell).toHaveValue(name.replaceAll("\r\n", "\n"));
        await cell.focus();
        await cell.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
        await cell.pressSequentially(" edited");
        const edited = await saveDraft(page);
        expect(
            (edited.content.document as { source: { rows: { values: { name: string } }[] } }).source.rows[0]!.values
                .name,
        ).toBe(name + " edited");
        if (tree) {
            // 父键的重命名必须同步子行引用；随后编辑排序再保存，检查编辑器没有靠重排数组模拟同级顺序。
            const rootKey = page.getByLabel("Row key", { exact: true }).last();
            await rootKey.fill("renamed");
            await rootKey.press("Tab");
            await expect(page.getByLabel("Parent node").first()).toHaveValue("renamed");
            await page.getByLabel("Sibling order").first().fill("7");
            expect((await saveDraft(page)).content.document).toMatchObject({
                source: { rows: [{ parentKey: "renamed", order: 7 }, { key: "renamed" }] },
            });
        } else {
            // 真实表单库会深拷贝对象，必须经过文件预检、应用和再次保存检查原型同名字段及带点字段的值。
            const field = page.getByRole("textbox", { name: "Field name" });
            await field.fill("__proto__");
            await field.press("Tab");
            await page.getByRole("button", { name: "Add field", exact: true }).click();
            await field.last().fill("price.usd");
            await field.last().press("Tab");
            await page.getByRole("combobox", { name: "Field type" }).last().click();
            await page.getByRole("listbox").getByRole("option", { name: "number", exact: true }).click();
            await page.getByLabel("Required", { exact: true }).last().uncheck();
            await page.getByLabel("Nullable").last().check();
            const imported = [
                { key: "item", values: { ["__proto__"]: "typed", "price.usd": null } },
                { key: "absent", values: { ["__proto__"]: "still here" } },
            ];
            await importTab.click();
            await page.getByRole("radio", { name: "JSON", exact: true }).check();
            await expect(input).toHaveCount(0);
            const file = page.getByLabel("Import file", { exact: true });
            const uploadLimit = 10 * 1024 * 1024;
            await file.setInputFiles({
                name: "large.json",
                mimeType: "application/json",
                buffer: Buffer.alloc(uploadLimit + 1),
            });
            await expect(page.getByRole("alert")).toContainText("DATASET_SIZE_LIMIT");
            await expect(preview).toBeDisabled();
            const payload = Buffer.from(JSON.stringify(imported));
            const buffer = Buffer.alloc(uploadLimit, " ");
            payload.copy(buffer, buffer.length - payload.length);
            await file.setInputFiles({ name: "rows.json", mimeType: "application/json", buffer });
            await expect(preview).toBeEnabled();
            await preview.click();
            await expect(apply).toBeEnabled();
            await apply.click();
            await acknowledgeOperation(page, "Import applied to the draft. Save the draft to keep the changes.");
            const saved = (await saveDraft(page)).content;
            expect(saved.document).toMatchObject({
                fields: {
                    ["__proto__"]: { type: "string", required: true, nullable: false },
                    "price.usd": { type: "number", required: false, nullable: true },
                },
            });
            expect((saved.document as { source: { rows: unknown[] } }).source.rows).toEqual(imported);
        }
    }
});

/**
 * 稀疏资源的声明数量与行数可独立增长，检查只渲染当前页并仍能定位到后续行及字段，真实保存保留未显示数据。
 */
test("pages sparse static dataset rows and fields", async ({ page }) => {
    test.setTimeout(90_000);
    const scope = await editorScope(page, `sparse-form-${randomUUID()}`);
    const fields = Object.fromEntries(
        Array.from({ length: 97 }, (_, i) => ["f_" + i, { type: "string", required: false, nullable: false }]),
    );
    const rows = Array.from({ length: 113 }, (_, i) => ({ key: "r_" + i, values: i === 112 ? { f_96: "tail" } : {} }));
    const created = await page.request.post(`/api/v1/workspaces/${scope.workspaceId}/resources`, {
        headers: scope.headers,
        data: {
            kind: "DATASET",
            key: "sparse",
            name: "sparse",
            content: {
                kind: "DATASET",
                document: { schemaVersion: "2.0", shape: "TABLE", fields, source: { kind: "STATIC", rows } },
            },
        },
    });
    expect(created.status(), await created.text()).toBe(201);
    await page.goto("/resources/datasets");
    await chooseWorkspace(page, scope.workspaceId);
    await page.getByRole("link", { name: "Details for sparse (sparse)", exact: true }).click();
    await expect(page.getByRole("main").getByRole("heading", { name: "sparse", level: 1 })).toBeVisible();
    const article = page.getByRole("article");
    expect(await article.getByLabel("Row key", { exact: true }).count()).toBeLessThanOrEqual(20);
    expect(await article.getByLabel("Field name", { exact: true }).count()).toBeLessThanOrEqual(20);
    const rowPages = article.getByRole("navigation", { name: "Dataset row pagination" });
    const fieldPages = article.getByRole("navigation", { name: "Dataset field pagination" });
    for (const page of ["5", "7", "9", "11", "12"]) {
        await rowPages.getByRole("button", { name: page, exact: true }).click();
    }
    for (const page of ["5", "7", "9", "10"]) {
        await fieldPages.getByRole("button", { name: page, exact: true }).click();
    }
    await expect(article.getByLabel("Row key", { exact: true }).last()).toHaveValue("r_112");
    const tail = article.getByRole("textbox", { name: "f_96", exact: true });
    await tail.fill("edited tail");
    const saved = await saveDraft(page);
    expect(saved.content.document).toMatchObject({
        source: { rows: rows.map((r, i) => (i === 112 ? { ...r, values: { f_96: "edited tail" } } : r)) },
    });
});

/**
 * 通过实际键盘删除指定位置，区分两个看起来相同的换行符；另检查删除分隔字符后仍保留两个可见行界。
 */
test("deletes the selected physical line break in a static dataset", async ({ page }) => {
    const scope = await editorScope(page, `line-edit-${randomUUID()}`);
    const rows = [
        { key: "adjacent", values: { body: "a\r\n\nb" } },
        { key: "separate", values: { body: "a\rX\nb" } },
    ];
    const created = await page.request.post(`/api/v1/workspaces/${scope.workspaceId}/resources`, {
        headers: scope.headers,
        data: {
            kind: "DATASET",
            key: "text_rows",
            name: "Text rows",
            content: {
                kind: "DATASET",
                document: {
                    schemaVersion: "2.0",
                    shape: "TABLE",
                    fields: { body: { type: "string", required: true, nullable: false } },
                    source: { kind: "STATIC", rows: [] },
                },
            },
        },
    });
    expect(created.status(), await created.text()).toBe(201);
    await page.goto("/resources/datasets");
    await chooseWorkspace(page, scope.workspaceId);
    await page.getByRole("link", { name: "Details for Text rows (text_rows)", exact: true }).click();
    await page.getByRole("tab", { name: "Import", exact: true }).click();
    await page.getByRole("radio", { name: "Text", exact: true }).check();
    await page.getByLabel("Import text").fill(`\uFEFF  ${JSON.stringify(rows)}`);
    await page.getByRole("button", { name: "Preview import" }).click();
    await page.getByRole("button", { name: "Apply import" }).click();
    await acknowledgeOperation(page, "Import applied to the draft. Save the draft to keep the changes.");
    await page.getByRole("tab", { name: "Data (Form)", exact: true }).click();
    const cells = page.getByRole("article").getByRole("textbox", { name: "body", exact: true });
    const first = cells.first(),
        second = cells.last();
    const documentStart = process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home";
    await first.focus();
    await first.press(documentStart);
    await first.press("ArrowRight");
    await first.press("Delete");
    await expect(first).toHaveValue("a\nb");
    await second.focus();
    await second.press(documentStart);
    await second.press("ArrowRight");
    await second.press("ArrowRight");
    await second.press("Delete");
    expect.soft(await second.inputValue()).toBe("a\n\nb");
    const saved = await saveDraft(page);
    const [adjacent, separate] = (saved.content.document as { source: { rows: { values: { body: string } }[] } }).source
        .rows;
    expect.soft(adjacent!.values.body).toBe("a\nb");
    expect(separate!.values.body.replace(/\r\n?/gu, "\n")).toBe("a\n\nb");
});

test("writes named dataset queries without changing the expected provenance", async ({ page }) => {
    test.setTimeout(120_000);
    const scope = await editorScope(page, "named-queries");
    const version = await publishWriterDataset(page, scope);
    await page.reload();
    await chooseWorkspace(page, scope.workspaceId);
    await createResource(page, "CASE", "named-case");
    await expect(page.getByLabel("New dataset alias")).toBeVisible();
    await applyDocument(page, {
        kind: "CASE",
        document: {
            schemaVersion: "1.0",
            caseKey: "read",
            title: "Read",
            kind: "READ",
            roleKey: "reader",
            catalogVersionId: randomUUID(),
            steps: [
                {
                    id: "open",
                    action: "goto",
                    path: "/",
                    afterAssertions: [
                        {
                            id: "match",
                            type: "url",
                            source: "page",
                            operator: "equals",
                            expected: "/",
                            severity: "BLOCK",
                            expectedSource: "policy",
                        },
                    ],
                },
            ],
        },
    });
    await page.getByLabel("New dataset alias").fill("names");
    await selectResourceOption(page.getByLabel("Named dataset version"), new RegExp(` · ${version.id}$`));
    await page.getByRole("button", { name: "Add alias", exact: true }).click();
    await selectResourceOption(page.getByLabel("Expected value mode"), "Dataset query");
    await page.getByLabel("Query alias").fill("names");
    await page.getByLabel("Query field").fill("path");
    const saved = (await saveDraft(page)).content;
    if (saved.kind !== "CASE") throw new Error("Expected CASE");
    expect(saved.document.datasetBindings).toEqual({ names: version.id });
    const assertion = saved.document.steps[0]!.afterAssertions![0]!;
    expect(assertion).toMatchObject({
        expectedSource: "policy",
        datasetExpected: { alias: "names", op: "field", field: "path" },
    });
    expect(assertion).not.toHaveProperty("expected");
    await selectResourceOption(page.getByLabel("Expected value mode"), "Literal value");
    const literal = (await saveDraft(page)).content;
    if (literal.kind !== "CASE") throw new Error("Expected CASE");
    expect(literal.document.steps[0]!.afterAssertions![0]).not.toHaveProperty("datasetExpected");
});

test("edits and previews HTTP datasets", async ({ page }) => {
    test.setTimeout(90_000);
    const scope = await editorScope(page, "remote-form");
    await closeResourceEditor(page);
    const form = await openResourceCreateForm(page, "DATASET");
    await selectResourceOption(form.getByLabel("Dataset format"), "HTTP table");
    await form.getByLabel("Key", { exact: true }).fill("remote");
    await form.getByLabel("Name", { exact: true }).fill("Remote catalog");
    await form.getByRole("button", { name: "Create resource" }).click();
    await acknowledgeOperation(page, "Resource created");
    const editor = page.getByRole("article");
    await expect(editor.getByLabel("HTTP path")).toHaveValue("/items");
    await selectResourceOption(editor.getByLabel("HTTP method"), "POST");
    await selectResourceOption(editor.getByLabel("Body format"), "RAW");
    await editor.getByLabel("Raw UTF-8 body").fill("雪 +");
    expect((await saveDraft(page)).content.document).toMatchObject({ source: { body: { raw: "雪 +" } } });
    await selectResourceOption(editor.getByLabel("Body format"), "FORM");
    await editor.getByRole("button", { name: "Add form parameter" }).click();
    await editor.getByLabel("Form name").fill("q");
    await editor.getByLabel("Form value").fill("雪 +");
    expect((await saveDraft(page)).content.document).toMatchObject({
        source: { body: { form: [{ name: "q", value: "雪 +" }] } },
    });
    await selectResourceOption(editor.getByLabel("HTTP method"), "GET");
    await editor.getByRole("button", { name: "Add query parameter" }).click();
    await editor.getByRole("button", { name: "Add query parameter" }).click();
    await editor.getByLabel("Query name").nth(0).fill("q");
    await editor.getByLabel("Query name").nth(1).fill("q");
    await editor.getByLabel("Query value").nth(0).fill("first");
    const saved = await saveDraft(page);
    expect(saved.content.kind).toBe("DATASET");
    const response = page.waitForResponse((item) => item.url().endsWith("/http-preview"));
    await editor.getByRole("button", { name: "Preview mapped rows" }).click();
    expect((await response).status()).toBe(422);
    await acknowledgeOperation(page, "DATASET_CONNECTION_UNAVAILABLE", "failed");
    const base = "/api/v1/workspaces/" + scope.workspaceId;
    const credential = await page.request.post(base + "/credentials", {
        headers: scope.headers,
        data: {
            secretRef: "browser_catalog",
            allowedIdentityIds: ["dataset-reader"],
            value: { value: "browser-only-material" },
        },
    });
    expect(credential.status(), await credential.text()).toBe(201);
    const credentialId = (await credential.json()).data.versionId;
    await editor.getByLabel("Connection version", { exact: true }).fill("00000000-0000-4000-8000-000000000001");
    await editor.getByLabel("Environment version", { exact: true }).fill("00000000-0000-4000-8000-000000000002");
    await selectResourceOption(editor.getByLabel("Authentication mode"), "BEARER");
    await editor.getByLabel("Credential reference").fill("browser_catalog");
    await editor.getByLabel("Credential version").fill(credentialId);
    const result = page.waitForResponse((item) => item.url().endsWith("/http-preview"));
    await editor.getByRole("button", { name: "Preview mapped rows" }).click();
    const ok = await result;
    expect(ok.status(), await ok.text()).toBe(200);
    await acknowledgeOperation(page, "Mapped rows · 1");
    expect(await ok.text()).not.toContain("browser-only-material");
    await editor
        .getByRole("heading", { name: "Declared parameters", exact: true })
        .locator("..")
        .getByLabel("Name")
        .fill("search");
    await editor.getByRole("button", { name: "Add Declared parameters" }).click();
    const bound = await saveDraft(page);
    expect(JSON.stringify(bound)).not.toContain("browser-only-material");
    expect(bound.content.document).toMatchObject({
        source: {
            query: [
                { name: "q", value: "first" },
                { name: "q", value: "" },
            ],
        },
    });
    const job = await queueValidation(page);
    const compiler = await managedCompiler(page, scope);
    await withCleanup(compiler.compile, compiler.close);
    await acknowledgeOperation(page, "Compilation validated");
    const receipt = (await (await page.request.get(base + "/jobs/" + job.id + "/validation-receipt")).json()).data;
    const pub = await page.request.post(base + "/resources/" + bound.resourceId + "/publish", {
        headers: scope.headers,
        data: { revision: receipt.revision, validationReceiptId: receipt.id },
    });
    expect(pub.status(), await pub.text()).toBe(201);
    const target = (
        await (
            await page.request.post("/api/v1/workspaces", {
                headers: scope.headers,
                data: { key: "remote-copy", name: "remote-copy" },
            })
        ).json()
    ).data.id;
    const copy = await page.request.post("/api/v1/workspaces/" + target + "/resources/dataset-copies", {
        headers: scope.headers,
        data: {
            sourceWorkspaceId: scope.workspaceId,
            sourceDatasetVersionId: (await pub.json()).data.id,
            key: "copy",
            name: "copy",
        },
    });
    expect(copy.status(), await copy.text()).toBe(201);
    await closeResourceEditor(page);
    await page.reload();
    await chooseWorkspace(page, target);
    await page.getByRole("link", { name: "Details for copy (copy)", exact: true }).click();
    await expect(editor.getByLabel("Connection version", { exact: true })).toHaveValue("");
    await expect(editor.getByLabel("Credential version")).toHaveValue("");
    await expect(editor.getByLabel("Query value").nth(0)).toHaveValue("first");
    await closeResourceEditor(page);
    await chooseWorkspace(page, scope.workspaceId);
    const local = await publishWriterDataset(page, scope);
    await page.reload();
    await chooseWorkspace(page, scope.workspaceId);
    await createResource(page, "CASE", "http-source-arguments");
    const remoteId = (await pub.json()).data.id;
    await applyDocument(page, {
        kind: "CASE",
        document: {
            schemaVersion: "1.0",
            caseKey: "sample",
            title: "Sample",
            kind: "READ",
            roleKey: "reader",
            catalogVersionId: randomUUID(),
            datasetBindings: { remote: remoteId },
            steps: [
                {
                    id: "open",
                    action: "goto",
                    path: "/",
                    afterAssertions: [
                        {
                            id: "match",
                            type: "url",
                            source: "page",
                            operator: "equals",
                            severity: "WARN",
                            expectedSource: "catalog",
                            datasetExpected: { op: "field", alias: "remote", key: "one", field: "label" },
                        },
                    ],
                },
            ],
        },
    });
    const args = page.getByLabel("HTTP source arguments Field name");
    await args.fill("search");
    await args.locator("../..").getByRole("button", { name: "Add field" }).click();
    await page.getByRole("textbox", { name: "HTTP source arguments.search", exact: true }).fill("{{data.name}}");
    await selectResourceOption(page.getByLabel("Query operation"), "contains");
    const stored = (await saveDraft(page)).content;
    expect(stored.document).toMatchObject({
        steps: [
            {
                afterAssertions: [
                    {
                        datasetExpected: {
                            op: "contains",
                            alias: "remote",
                            parameters: { search: "{{data.name}}" },
                        },
                    },
                ],
            },
        ],
    });
    await selectResourceOption(
        page.getByRole("group", { name: "Named datasets" }).getByRole("combobox", { name: "remote", exact: true }),
        new RegExp(` · ${local.id}$`),
    );
    const rebound = (await saveDraft(page)).content;
    if (rebound.kind !== "CASE") throw new Error("Expected CASE");
    const reboundAssertion = rebound.document.steps[0]!.afterAssertions![0]!;
    expect(reboundAssertion).toHaveProperty("datasetExpected.alias", "remote");
    expect(reboundAssertion).not.toHaveProperty("datasetExpected.parameters");
});
