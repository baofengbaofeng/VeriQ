import { test, expect } from "@playwright/test";
import { editorScope, managedCompiler } from "./editor-fixture";
import { mkdtemp, readFile, rm, chmod, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const command = promisify(execFile);
test("real Agent publications export through keyboard GUI and verify offline with exact generated source", async ({
  page,
}) => {
  test.setTimeout(240000);
  await page.setViewportSize({ width: 1280, height: 800 });
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
  const scope = await editorScope(page, "bundles-actual"),
    compiler = await managedCompiler(page, scope, "t14"),
    base = `/api/v1/workspaces/${scope.workspaceId}`;
  const temp = await mkdtemp("/tmp/veriq-bundle-ui-");
  async function publish(kind: string, key: string, document: unknown) {
    const create = await page.request.post(base + "/resources", {
      headers: scope.headers,
      data: { kind, key, name: key, content: { kind, document } },
    });
    expect(create.status(), await create.text()).toBe(201);
    const resource = (await create.json()).data;
    return publishVersion(resource);
  }
  async function publishVersion(resource: { id: string }) {
    const path = base + `/resources/${resource.id}`,
      preview = (
        await (await page.request.get(path + "/validation-preview")).json()
      ).data;
    const queued = await page.request.post(path + "/validate", {
      headers: scope.headers,
      data: { revision: preview.revision, sourceHash: preview.sourceHash },
    });
    expect(queued.status()).toBe(202);
    const job = (await queued.json()).data;
    await compiler.compile();
    const receiptResponse = await page.request.get(
      base + `/jobs/${job.id}/validation-receipt`,
    );
    expect(receiptResponse.status(), await receiptResponse.text()).toBe(200);
    const receipt = (await receiptResponse.json()).data;
    const published = await page.request.post(path + "/publish", {
      headers: scope.headers,
      data: { revision: preview.revision, validationReceiptId: receipt.id },
    });
    expect(published.status(), await published.text()).toBe(201);
    return { resource, version: (await published.json()).data };
  }
  try {
    const secret = (
      await (
        await page.request.post(base + "/credentials", {
          headers: scope.headers,
          data: {
            secretRef: "reader",
            value: { token: "synthetic-bundle-browser-secret" },
            allowedIdentityIds: ["reader"],
          },
        })
      ).json()
    ).data;
    const adapter = (
      await (
        await page.request.post(base + "/auth-adapters", {
          headers: scope.headers,
          data: {
            configuration: {
              kind: "HTTP_BEARER",
              identityPath: "/me",
              identityPointer: "/id",
            },
          },
        })
      ).json()
    ).data;
    const env = await publish("ENVIRONMENT", "bundle-env", {
      schemaVersion: "1.0",
      baseURL: "https://business.test",
      apiBaseURL: "https://business.test",
      allowedOrigins: ["https://business.test"],
      locale: "en",
      timezone: "UTC",
      roles: [
        {
          roleKey: "reader",
          authAdapterVersionId: adapter.versionId,
          secretRef: "reader",
          secretVersionId: secret.versionId,
          allowedIdentityIds: ["reader"],
        },
      ],
    });
    const catalog = await publish("ELEMENT_CATALOG", "bundle-catalog", {
      schemaVersion: "1.0",
      elements: [{ key: "ready", locator: { by: "testId", value: "ready" } }],
    });
    const testcase = await publish("CASE", "bundle-case", {
      schemaVersion: "1.0",
      caseKey: "bundle-case",
      title: "REQ-bundle",
      kind: "READ",
      roleKey: "reader",
      catalogVersionId: catalog.version.id,
      steps: [{ id: "open", action: "goto", path: "/" }],
    });
    const second = await publish("CASE", "bundle-case-two", {
      schemaVersion: "1.0",
      caseKey: "bundle-case-two",
      title: "REQ-bundle-two",
      kind: "READ",
      roleKey: "reader",
      catalogVersionId: catalog.version.id,
      steps: [{ id: "open", action: "goto", path: "/two" }],
    });
    // 30 listing-only history rows, never selected/exported or claimed as compiled.
    // Selected IDs/source/receipt/generated TS remain the real Agent publications.
    await command(
      "uv",
      [
        "run",
        "--project",
        "apps/srv",
        "python",
        "apps/srv/tests/bundles/pagination_fixture.py",
        testcase.version.id,
        env.version.id,
      ],
      { cwd: resolve("../..") },
    );
    for (const resource of [testcase.resource, env.resource]) {
      const path = base + `/resources/${resource.id}`;
      const draft = (await (await page.request.get(path + "/draft")).json())
        .data;
      expect(
        (
          await page.request.put(path + "/draft", {
            headers: scope.headers,
            data: { revision: draft.revision, content: draft.content },
          })
        ).status(),
      ).toBe(200);
      const latest = await publishVersion(resource);
      expect(latest.version.versionNo).toBe(32);
    }
    await page.getByRole("link", { name: "Bundles", exact: true }).click();
    await page.getByLabel("Bundle Workspace").selectOption(scope.workspaceId);
    await page
      .getByTestId("bundle-resource")
      .selectOption(testcase.resource.id);
    await expect(
      page
        .getByTestId("bundle-version")
        .locator(`option[value="${testcase.version.id}"]`),
    ).toHaveCount(0);
    const casePage = page.waitForResponse((r) =>
      r.url().includes(`/resources/${testcase.resource.id}/versions?cursor=`),
    );
    await page.getByTestId("bundle-more-versions").click();
    expect((await casePage).status()).toBe(200);
    await expect(
      page
        .getByTestId("bundle-version")
        .locator(`option[value="${testcase.version.id}"]`),
    ).toContainText("v31");
    await page.getByTestId("bundle-version").selectOption(testcase.version.id);
    await page.getByTestId("bundle-add-case").click();
    await page.getByTestId("bundle-resource").selectOption(second.resource.id);
    await page.getByTestId("bundle-version").selectOption(second.version.id);
    await page.getByTestId("bundle-add-case").click();
    await expect(page.getByTestId("bundle-selected-case")).toHaveCount(2);
    await page.getByTestId("bundle-environment").selectOption(env.resource.id);
    await expect(
      page
        .getByTestId("bundle-environment-version")
        .locator(`option[value="${env.version.id}"]`),
    ).toHaveCount(0);
    const envPage = page.waitForResponse((r) =>
      r.url().includes(`/resources/${env.resource.id}/versions?cursor=`),
    );
    await page.getByTestId("bundle-more-environments").click();
    expect((await envPage).status()).toBe(200);
    await expect(
      page
        .getByTestId("bundle-environment-version")
        .locator(`option[value="${env.version.id}"]`),
    ).toContainText("v31");
    await page
      .getByTestId("bundle-environment-version")
      .selectOption(env.version.id);
    const exported = page.waitForResponse(
      (r) => r.url().endsWith("/bundles") && r.request().method() === "POST",
    );
    await page.getByTestId("bundle-export").focus();
    await page.keyboard.press("Enter");
    const response = await exported;
    expect(response.status(), await response.text()).toBe(201);
    await expect(page.getByTestId("bundle-item")).toHaveCount(1);
    const downloading = page.waitForEvent("download");
    await page.getByTestId("bundle-download").click();
    const download = await downloading,
      archive = join(temp, "bundle.zip");
    await download.saveAs(archive);
    const pub = JSON.parse(
      await readFile(
        resolve("../../.superpowers/cache/t14/browser-issuer-public.json"),
        "utf8",
      ),
    );
    const cli = [
      "--filter",
      "@veriq/runtime",
      "exec",
      "node",
      "--import",
      "tsx",
      "src/cli.ts",
      "--config-dir",
      join(temp, "profile"),
    ];
    const cwd = resolve("../..");
    await command(
      "pnpm",
      [
        ...cli,
        "trust",
        "bind",
        resolve("../../.superpowers/cache/t14/browser-issuer-public.json"),
        "--origin",
        "http://127.0.0.1:5173",
        "--fingerprint",
        pub.keys[0].fingerprint,
      ],
      { cwd },
    );
    const verified = await command(
      "pnpm",
      [
        ...cli,
        "bundle",
        "verify",
        archive,
        "--destination",
        join(temp, "verified"),
      ],
      { cwd },
    );
    expect(verified.stdout).toContain("revocation UNKNOWN");
    const inspected = await command(
      "pnpm",
      [
        "--filter",
        "@veriq/runtime",
        "exec",
        "node",
        "--import",
        "tsx",
        "tests/inspect-offline.mjs",
        archive,
        join(temp, "profile"),
        join(temp, "inspected"),
      ],
      { cwd },
    );
    expect(inspected.stdout).toContain("Verified local resource adapter");
    const snapshot = JSON.parse(
      await readFile(join(temp, "verified/snapshot.json"), "utf8"),
    );
    expect(snapshot.entryCaseVersionIds.sort()).toEqual(
      [testcase.version.id, second.version.id].sort(),
    );
    expect(
      snapshot.assets.map((a: { versionId: string }) => a.versionId).sort(),
    ).toEqual(
      [
        testcase.version.id,
        second.version.id,
        env.version.id,
        catalog.version.id,
      ].sort(),
    );
    const source = await readFile(
      join(
        temp,
        "verified",
        `compiled/${testcase.version.id}/cases/${testcase.version.id}.test.ts`,
      ),
      "utf8",
    );
    expect(source).toContain("registerCase");
    expect(source).not.toContain("synthetic-bundle-browser-secret");
    const another = await page.request.post("/api/v1/workspaces", {
      headers: scope.headers,
      data: { key: "bundles-empty", name: "bundles-empty" },
    });
    expect(another.status()).toBe(201);
    await page.reload();
    await page
      .getByLabel("Bundle Workspace")
      .selectOption((await another.json()).data.id);
    await expect(page.getByTestId("bundle-item")).toHaveCount(0);
    await expect(page.getByTestId("bundle-export")).toBeDisabled();
  } finally {
    await compiler.close();
    async function writable(path: string) {
      await chmod(path, 0o700);
      for (const e of await readdir(path, { withFileTypes: true }))
        if (e.isDirectory()) await writable(join(path, e.name));
    }
    await writable(temp);
    await rm(temp, { recursive: true, force: true });
  }
});
