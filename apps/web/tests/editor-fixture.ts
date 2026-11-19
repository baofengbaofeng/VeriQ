/**
 * 这些测试辅助通过真实的编辑器界面和控制接口准备数据，并启动 Runtime CLI 处理验证，回执由正式执行链产生。
 */
import { chooseWorkspace } from "./support/console-controls";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, type Page } from "@playwright/test";
import type { PlatformComponents, ResourceDocumentV1, ResourceKind } from "@veriq/contracts";
type S = PlatformComponents["schemas"];
const origin = "http://127.0.0.1:5173";
export type EditorScope = {
    workspaceId: string;
    key: string;
    headers: Record<string, string>;
};
export async function editorScope(page: Page, key: string): Promise<EditorScope> {
    await page.goto("/login");
    await page.getByRole("textbox", { name: "Email" }).fill("browser-admin@example.com");
    await page.getByLabel("Password").fill("Browser password 123!");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("dl")).toBeVisible();
    const session = (await (await page.request.get("/api/v1/auth/session")).json()).data;
    const headers = { Origin: origin, "X-CSRF-Token": session.csrfToken };
    const response = await page.request.post("/api/v1/workspaces", {
        headers,
        data: { key, name: key },
    });
    expect(response.status(), await response.text()).toBe(201);
    const workspaceId = (await response.json()).data.id;
    await page.goto("/resources");
    await chooseWorkspace(page, workspaceId);
    return { workspaceId, key, headers };
}
export async function createResource(page: Page, kind: ResourceKind, key: string): Promise<S["ResourceDTO"]> {
    await closeResourceEditor(page);
    await page.getByRole("button", { name: "New resource", exact: true }).click();
    const form = resourceCreateForm(page);
    await form.getByRole("combobox", { name: "Kind", exact: true }).selectOption(kind);
    await form.getByLabel("Key", { exact: true }).fill(key);
    await form.getByLabel("Name", { exact: true }).fill(key);
    const response = page.waitForResponse((r) => r.url().endsWith("/resources") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Create resource" }).click();
    const created = await response;
    expect(created.status(), await created.text()).toBe(201);
    await expect(
        page.getByRole("article").getByRole("heading", { name: `${key} · ${kind}`, exact: true }),
    ).toBeVisible();
    return (await created.json()).data;
}
/**
 * 创建表单通过自己的提交按钮确定范围，使目录中的元素名称和记录标识不会与后台创建字段发生严格匹配冲突。
 */
export function resourceCreateForm(page: Page) {
    return page.locator("form").filter({ has: page.getByRole("button", { name: "Create resource", exact: true }) });
}
/**
 * 仅关闭含资源文章的当前编辑抽屉并等待其消失，再访问背景控件；嵌套确认框必须由拥有该操作的用例明确处理。
 */
export async function closeResourceEditor(page: Page) {
    const drawer = page.getByRole("dialog").filter({ has: page.getByRole("article") });
    if ((await drawer.count()) === 0) return;
    await expect(drawer).toHaveCount(1);
    await drawer.getByRole("button", { name: "Close", exact: true }).click();
    await expect(drawer).toBeHidden();
}
export async function saveDraft(page: Page): Promise<S["DraftDTO"]> {
    await expect(page.locator('ul[role="alert"]')).toHaveCount(0);
    const response = page.waitForResponse((r) => r.url().endsWith("/draft") && r.request().method() === "PUT");
    await page.getByRole("button", { name: "Save draft" }).click();
    const saved = await response;
    expect(saved.status(), await saved.text()).toBe(200);
    await expect(page.getByText("Saved")).toContainText("Saved");
    return (await saved.json()).data;
}
export async function replaceEditorJson(page: Page, text: string) {
    const editor = page
        .getByRole("dialog")
        .locator(".vq-monaco")
        .filter({
            has: page.getByRole("textbox", { name: "JSON source", exact: true }),
        });
    await editor.locator(".view-lines").click();
    await page.keyboard.press("Control+A");
    // Monaco 0.57 在渲染时同步原生 EditContext 的选区，测试等选中范围覆盖完整文本后才继续输入。
    // 随后通过浏览器剪贴板粘贴，测试不直接改写编辑器模型。
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
                return !!context && context.selectionStart === 0 && context.selectionEnd === context.text.length;
            }),
        )
        .toBe(true);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    await page.evaluate((value) => navigator.clipboard.writeText(value), text);
    await page.keyboard.press("Control+V");
}
export async function applyDocument(page: Page, content: ResourceDocumentV1) {
    await page.getByRole("button", { name: "JSON source" }).click();
    await replaceEditorJson(page, JSON.stringify(content, null, 2));
    await page.getByRole("button", { name: "Apply JSON" }).click();
    await expect(page.getByText("Unapplied JSON changes")).toHaveCount(0);
    await page.getByRole("button", { name: "Visual form" }).click();
    await expect(page.locator('ul[role="alert"]')).toHaveCount(0);
}
export async function queueValidation(page: Page): Promise<S["JobDTO"]> {
    const response = page.waitForResponse((r) => r.url().endsWith("/validate") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Compile and validate" }).click();
    const queued = await response;
    expect(queued.status(), await queued.text()).toBe(202);
    return (await queued.json()).data;
}
export async function managedCompiler(page: Page, scope: EditorScope, evidenceTask = "t11") {
    const profile = await mkdtemp("/tmp/vq11-f-");
    const command = (args: string[], input = "") =>
        new Promise<{ code: number | null; output: string }>((resolve, reject) => {
            const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "--config-dir", profile, ...args], {
                cwd: fileURLToPath(new URL("../../runtime/", import.meta.url)),
                stdio: ["pipe", "pipe", "pipe"],
            });
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
    const tokenResponse = await page.request.post(base + `/service-accounts/${account.id}/tokens`, {
        headers: scope.headers,
        data: { purpose: "RUNTIME_ENROLLMENT" },
    });
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
            chromium.executablePath(),
        ],
        token,
    );
    expect(enrolled.code, enrolled.output).toBe(0);
    const device = JSON.parse(await readFile(join(profile, "device.json"), "utf8"));
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
            fileURLToPath(new URL("../../../.superpowers/cache/t11/release/", import.meta.url)),
            "--browser-executable",
            chromium.executablePath(),
            "--once",
        ]);
        expect(result.code, result.output).toBe(expectedCode);
    };
    const publish = async (): Promise<S["ResourceVersionDTO"]> => {
        const job = await queueValidation(page);
        await expect(page.getByRole("button", { name: "Publish version" })).toBeDisabled();
        await compile();
        await expect(page.getByText(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} · /)).toBeVisible({
            timeout: 20_000,
        });
        const status = (await (await page.request.get(base + `/jobs/${job.id}`)).json()).data;
        expect(status.outcome).toBe("PASSED");
        const response = page.waitForResponse((r) => r.url().endsWith("/publish") && r.request().method() === "POST");
        await page.getByRole("button", { name: "Publish version" }).click();
        const published = await response;
        expect(published.status(), await published.text()).toBe(201);
        await expect(page.getByText(/^v\d+ · .+ · .+$/)).toBeVisible();
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
        for (const name of entries.filter((name) => name.endsWith(".process.json"))) {
            const journal = JSON.parse(await readFile(join(profile, "agent/processes", name), "utf8"));
            stops.push({
                attemptId: journal.attemptId,
                state: journal.state,
                workerPid: journal.pid,
                guardianPid: journal.guardianPid,
            });
        }
        const evidencePath = fileURLToPath(
            new URL(
                `../../../.superpowers/sdd/veriq-1/evidence/${evidenceTask}/fix1-stops-${scope.key}.json`,
                import.meta.url,
            ),
        );
        // 全新持续集成检出没有旧证据目录，仅建立当前夹具自己的输出父目录；写入失败仍保留私有恢复现场。
        await mkdir(dirname(evidencePath), { recursive: true });
        await writeFile(evidencePath, JSON.stringify(stops, null, 2));
        expect(
            stops.every((stop) => stop.state === "STOPPED"),
            "Unconfirmed stop; private profile retained at " + profile,
        ).toBe(true);
        await rm(profile, { recursive: true, force: true });
    };
    return { compile, publish, close };
}
