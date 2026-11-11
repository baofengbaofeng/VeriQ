/** Test-only real UI/API/CLI helpers; never a production compiler or receipt writer. */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import type {
  PlatformComponents,
  ResourceDocumentV1,
  ResourceKind,
} from "@veriq/contracts";
type S = PlatformComponents["schemas"];
const origin = "http://127.0.0.1:5173";
export type EditorScope = {
  workspaceId: string;
  key: string;
  headers: Record<string, string>;
};
export async function editorScope(
  page: Page,
  key: string,
): Promise<EditorScope> {
  await page.goto("/login");
  await page.getByTestId("email").fill("browser-admin@example.com");
  await page.getByTestId("password").fill("Browser password 123!");
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("account-info")).toBeVisible();
  const session = (
    await (await page.request.get("/api/v1/auth/session")).json()
  ).data;
  const headers = { Origin: origin, "X-CSRF-Token": session.csrfToken };
  const response = await page.request.post("/api/v1/workspaces", {
    headers,
    data: { key, name: key },
  });
  expect(response.status(), await response.text()).toBe(201);
  const workspaceId = (await response.json()).data.id;
  await page.goto("/resources");
  await page.getByTestId("resource-workspace").selectOption(workspaceId);
  return { workspaceId, key, headers };
}
export async function createResource(
  page: Page,
  kind: ResourceKind,
  key: string,
): Promise<S["ResourceDTO"]> {
  await page.getByTestId("resource-kind").selectOption(kind);
  await page.getByTestId("resource-key").fill(key);
  await page.getByTestId("resource-name").fill(key);
  const response = page.waitForResponse(
    (r) => r.url().endsWith("/resources") && r.request().method() === "POST",
  );
  await page.getByTestId("resource-create").click();
  const created = await response;
  expect(created.status(), await created.text()).toBe(201);
  await expect(
    page
      .getByTestId("resource-editor")
      .getByRole("heading", { name: `${key} · ${kind}`, exact: true }),
  ).toBeVisible();
  return (await created.json()).data;
}
export async function saveDraft(page: Page): Promise<S["DraftDTO"]> {
  await expect(page.getByTestId("case.validation-errors")).toHaveCount(0);
  const response = page.waitForResponse(
    (r) => r.url().endsWith("/draft") && r.request().method() === "PUT",
  );
  await page.getByTestId("resource-save").click();
  const saved = await response;
  expect(saved.status(), await saved.text()).toBe(200);
  await expect(page.getByTestId("resource-status")).toContainText("已保存");
  return (await saved.json()).data;
}
export async function replaceEditorJson(page: Page, text: string) {
  const editor = page.getByTestId("resource-json");
  await editor.locator(".view-lines").click();
  await page.keyboard.press("Control+A");
  // Monaco0.57 mirrors selection into native EditContext at render time.
  // Wait for actual browser selection before bulk text input, without changing a model.
  await expect
    .poll(() =>
      editor.locator(".native-edit-context").evaluate((element) => {
        const context = (
          element as HTMLElement & {
            editContext?: {
              text: string;
              selectionStart: number;
              selectionEnd: number;
            };
          }
        ).editContext;
        return (
          !!context &&
          context.selectionStart === 0 &&
          context.selectionEnd === context.text.length
        );
      }),
    )
    .toBe(true);
  await page
    .context()
    .grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
  await page.keyboard.press("Control+V");
}
export async function applyDocument(page: Page, content: ResourceDocumentV1) {
  await page.getByTestId("resource-json-tab").click();
  await replaceEditorJson(page, JSON.stringify(content, null, 2));
  await page.getByTestId("resource-json-apply").click();
  await expect(page.getByTestId("resource-json-pending")).toHaveCount(0);
  await page.getByTestId("resource-form-tab").click();
  await expect(page.getByTestId("case.validation-errors")).toHaveCount(0);
}
export async function queueValidation(page: Page): Promise<S["JobDTO"]> {
  const response = page.waitForResponse(
    (r) => r.url().endsWith("/validate") && r.request().method() === "POST",
  );
  await page.getByTestId("case.validate").click();
  const queued = await response;
  expect(queued.status(), await queued.text()).toBe(202);
  return (await queued.json()).data;
}
export async function managedCompiler(page: Page, scope: EditorScope) {
  const profile = await mkdtemp("/tmp/vq11-f-");
  const command = (args: string[], input = "") =>
    new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", "--config-dir", profile, ...args],
        {
          cwd: fileURLToPath(new URL("../../runtime/", import.meta.url)),
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (data) => (output += String(data)));
      child.stderr.on("data", (data) => (output += String(data)));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, output }));
      child.stdin.end(input);
    });
  const base = `/api/v1/workspaces/${scope.workspaceId}`;
  const accountResponse = await page.request.post(base + "/service-accounts", {
    headers: scope.headers,
    data: { name: scope.key },
  });
  expect(accountResponse.status(), await accountResponse.text()).toBe(201);
  const account = (await accountResponse.json()).data;
  const tokenResponse = await page.request.post(
    base + `/service-accounts/${account.id}/tokens`,
    { headers: scope.headers, data: { purpose: "RUNTIME_ENROLLMENT" } },
  );
  expect(tokenResponse.status()).toBe(201);
  const token = (await tokenResponse.json()).data.token;
  const enrolled = await command(
    [
      "enroll-service",
      "--server",
      origin,
      "--name",
      scope.key,
      "--share-workspace",
      "--browser-executable",
      "/usr/bin/chromium",
    ],
    token,
  );
  expect(enrolled.code, enrolled.output).toBe(0);
  const device = JSON.parse(
    await readFile(join(profile, "device.json"), "utf8"),
  );
  expect(
    (
      await page.request.put(base + `/runtimes/${device.runnerId}/trust`, {
        headers: scope.headers,
        data: { trustStatus: "MANAGED", allowCredentialDelivery: false },
      })
    ).status(),
  ).toBe(200);
  const compile = async (expectedCode = 0) => {
    const result = await command([
      "runtime",
      "start",
      "--release-dir",
      fileURLToPath(
        new URL("../../../.superpowers/cache/t11/release/", import.meta.url),
      ),
      "--browser-executable",
      "/usr/bin/chromium",
      "--once",
    ]);
    expect(result.code, result.output).toBe(expectedCode);
  };
  const publish = async (): Promise<S["ResourceVersionDTO"]> => {
    const job = await queueValidation(page);
    await expect(page.getByTestId("case.publish")).toBeDisabled();
    await compile();
    await expect(page.getByTestId("case.validation-receipt")).toBeVisible({
      timeout: 20_000,
    });
    const status = (
      await (await page.request.get(base + `/jobs/${job.id}`)).json()
    ).data;
    expect(status.outcome).toBe("PASSED");
    const response = page.waitForResponse(
      (r) => r.url().endsWith("/publish") && r.request().method() === "POST",
    );
    await page.getByTestId("case.publish").click();
    const published = await response;
    expect(published.status(), await published.text()).toBe(201);
    await expect(page.getByTestId("case.published-version")).toBeVisible();
    return (await published.json()).data;
  };
  const close = async () => {
    let entries: string[] = [];
    try {
      entries = await readdir(join(profile, "agent/processes"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const stops = [];
    for (const name of entries.filter((name) =>
      name.endsWith(".process.json"),
    )) {
      const journal = JSON.parse(
        await readFile(join(profile, "agent/processes", name), "utf8"),
      );
      stops.push({
        attemptId: journal.attemptId,
        state: journal.state,
        workerPid: journal.pid,
        guardianPid: journal.guardianPid,
      });
    }
    await writeFile(
      fileURLToPath(
        new URL(
          `../../../.superpowers/sdd/veriq-1/evidence/t11/fix1-stops-${scope.key}.json`,
          import.meta.url,
        ),
      ),
      JSON.stringify(stops, null, 2),
    );
    expect(
      stops.every((stop) => stop.state === "STOPPED"),
      "Unconfirmed stop; private profile retained at " + profile,
    ).toBe(true);
    await rm(profile, { recursive: true, force: true });
  };
  return { compile, publish, close };
}
