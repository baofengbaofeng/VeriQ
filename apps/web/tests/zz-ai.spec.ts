import { test, expect } from "@playwright/test";
import { editorScope } from "./editor-fixture";

test.beforeAll(async ({ request }) => {
  const state = (await (await request.get("/api/v1/setup")).json()).data;
  const headers = {
    Origin: "http://127.0.0.1:5173",
    "X-CSRF-Token": state.csrfToken,
  };
  if (!state.initialized) {
    const r = await request.post("/api/v1/setup", {
      headers,
      data: {
        installationSecret: "browser-operator-secret",
        email: "browser-admin@example.com",
        displayName: "AI administrator",
        password: "Browser password 123!",
      },
    });
    expect(r.status()).toBe(201);
  }
});

test("AI configuration is a real workspace page and explains no-provider execution", async ({
  page,
}) => {
  await editorScope(page, "ai-browser");
  await page.getByRole("link", { name: "AI", exact: true }).click();
  await expect(page.getByTestId("ai-empty")).toBeVisible();
  await expect(page.getByTestId("ai-execution-independent")).toBeVisible();
});

import { createServer, type Server } from "node:http";
import { createResource, managedCompiler } from "./editor-fixture";
let model: Server,
  calls = 0;
let catalogId = "";
let release: (() => void) | undefined;
let hold = false;
test.beforeAll(async () => {
  model = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    calls++;
    const body = JSON.parse(raw);
    const context = JSON.parse(body.messages[1].content).context;
    if (hold)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    const output =
      context.purpose === "CASE_DRAFT"
        ? {
            kind: "CASE",
            document: {
              schemaVersion: "1.0",
              caseKey: "ai-case",
              title: "Requirement-backed draft",
              kind: "READ",
              roleKey: "reader",
              catalogVersionId: catalogId,
              steps: [{ id: "open", action: "goto", path: "/" }],
            },
          }
        : {
            suggestions: ["An empty password should be rejected."],
            basis: "REQ-LOGIN",
          };
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        id: "chatcmpl_local",
        object: "chat.completion",
        created: 0,
        model: "emulator",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: JSON.stringify(output) },
          },
        ],
        usage: { prompt_tokens: 80, completion_tokens: 40, total_tokens: 120 },
      }),
    );
  });
  await new Promise<void>((resolve) =>
    model.listen(18890, "127.0.0.1", resolve),
  );
});
test.afterAll(async () => {
  release?.();
  await new Promise<void>((resolve, reject) =>
    model.close((e) => (e ? reject(e) : resolve())),
  );
});

test("real UI config, paid-call preview, review, genuine compiler, cancel and scoped history", async ({
  page,
}) => {
  test.setTimeout(180000);
  const scope = await editorScope(page, "ai-full");
  const compiler = await managedCompiler(page, scope);
  try {
    await createResource(page, "ELEMENT_CATALOG", "catalog");
    catalogId = (await compiler.publish()).id;
    await page.getByRole("link", { name: "AI", exact: true }).click();
    await page.getByTestId("ai-workspace").selectOption(scope.workspaceId);
    await page.getByLabel("语言 / Language").selectOption("en");
    await page.getByTestId("ai-name").fill("Local HTTP protocol emulator");
    await page.getByTestId("ai-baseURL").fill("http://127.0.0.1:18890/v1");
    await page.getByTestId("ai-model").fill("emulator");
    await page.getByTestId("ai-key").fill("synthetic-browser-provider-key");
    await page.getByTestId("ai-enabled").check();
    await page.getByTestId("ai-save").click();
    await expect(page.getByTestId("ai-key")).toHaveValue("");
    await expect(page.getByTestId("ai-budget")).toContainText("Available");
    await page.getByTestId("ai-test").click();
    await expect(page.getByTestId("ai-history")).toContainText(
      "CONNECTION_TEST · SUCCEEDED",
    );
    const prior = calls;
    await page
      .getByTestId("ai-prompt")
      .fill(
        "REQ-LOGIN: open the login page. Expected results must cite this requirement.",
      );
    await page.getByTestId("ai-versions").fill(catalogId);
    await page
      .getByTestId("ai-data")
      .fill('{"password":"do-not-send","username":"test-user"}');
    await page.getByTestId("ai-preview").click();
    await expect(page.getByTestId("ai-context")).toContainText("[REDACTED]");
    await expect(page.getByTestId("ai-context")).not.toContainText(
      "do-not-send",
    );
    expect(calls).toBe(prior);
    await page.getByTestId("ai-generate").click();
    await expect(page.getByTestId("ai-review")).toContainText("SUCCEEDED");
    await expect(page.getByTestId("ai-output")).toContainText(
      "Requirement-backed draft",
    );
    const caseList = await page.request.get(
      "/api/v1/workspaces/" + scope.workspaceId + "/resources?kind=CASE",
    );
    expect((await caseList.json()).data.items).toHaveLength(0);
    await page.getByTestId("ai-resource-key").fill("reviewed-ai-case");
    await page.getByTestId("ai-resource-name").fill("Reviewed AI case");
    await page.getByTestId("ai-accept").click();
    await expect(page.getByTestId("ai-review")).toContainText("REVIEWED");
    await page.screenshot({
      path: "../../.superpowers/sdd/veriq-1/evidence/t13/ai-reviewed.png",
      fullPage: true,
    });
    await page.getByTestId("ai-open-editor").click();
    await expect(page.getByTestId("resource-editor")).toBeVisible();
    const beforeCompile = calls;
    await compiler.publish();
    expect(calls).toBe(beforeCompile);
    await page.getByTestId("ai-purpose").selectOption("BOUNDARY_SUGGESTION");
    await page.getByTestId("ai-preview").click();
    await expect(page.getByTestId("ai-generate")).toBeEnabled();
    hold = true;
    await page.getByTestId("ai-generate").click();
    await expect.poll(() => !!release).toBe(true);
    await page.getByTestId("ai-refresh").click();
    await expect(page.getByTestId("ai-cancel")).toBeVisible();
    await page.getByTestId("ai-cancel").click();
    await expect(page.getByTestId("ai-history")).toContainText("CANCELLED");
    release?.();
    hold = false;
    await expect(page.getByTestId("ai-review")).toContainText("CANCELLED");
    await page.getByTestId("ai-edit-provider").click();
    await page.getByTestId("ai-enabled").uncheck();
    await page.getByTestId("ai-save").click();
    await expect(page.getByTestId("ai-preview")).toBeDisabled();
    await expect(page.locator("body")).not.toContainText(
      "synthetic-browser-provider-key",
    );
    const other = await page.request.post("/api/v1/workspaces", {
      headers: scope.headers,
      data: { key: "ai-other", name: "Other AI Workspace" },
    });
    expect(other.status()).toBe(201);
    await page.reload();
    await page
      .getByTestId("ai-workspace")
      .selectOption((await other.json()).data.id);
    await expect(page.getByTestId("ai-empty")).toBeVisible();
    await expect(page.getByTestId("ai-review")).toHaveCount(0);
  } finally {
    release?.();
    hold = false;
    await compiler.close();
  }
});
