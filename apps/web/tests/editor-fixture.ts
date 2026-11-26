/**
 * 这些测试辅助通过真实的编辑器界面和控制接口准备数据，并启动独立服务端编译进程生成可信回执。
 */
import { chooseWorkspace } from "./support/console-controls";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page } from "@playwright/test";
import type { PlatformComponents, ResourceDocumentV1, ResourceKind } from "@veriq/contracts";
type S = PlatformComponents["schemas"];
const origin = "http://127.0.0.1:5173";
const resourceEntry = {
    ELEMENT_CATALOG: { path: "element-catalogs", link: "Element catalogs", create: "New resource" },
    DATASET: { path: "datasets", link: "Datasets", create: "New dataset" },
    FIXTURE: { path: "fixtures", link: "Fixtures", create: "New fixture" },
    ASSERTION_TEMPLATE: { path: "assertion", link: "Assertion", create: "New assertion" },
    FLOW: { path: "flows", link: "Flows", create: "New flow" },
    CASE: { path: "cases", link: "Cases", create: "New case" },
    SUITE: { path: "suites", link: "Suites", create: "New suite" },
    ENVIRONMENT: { path: "environments", link: "Environments", create: "New execution environment" },
} satisfies Record<ResourceKind, { path: string; link: string; create: string }>;
export type EditorScope = {
    workspaceId: string;
    key: string;
    headers: Record<string, string>;
};
export async function editorScope(page: Page, key: string, entry = "/resources/datasets"): Promise<EditorScope> {
    await page.goto("/login");
    await page.getByRole("textbox", { name: "Email" }).fill("browser-admin@example.com");
    await page.getByLabel("Password").fill("Browser password 123!");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("dl")).toBeVisible();
    const session = (await (await page.request.get("/api/v1/auth/session")).json()).data;
    const headers = { Origin: new URL(page.url()).origin, "X-CSRF-Token": session.csrfToken };
    const response = await page.request.post("/api/v1/workspaces", {
        headers,
        data: { key, name: key },
    });
    expect(response.status(), await response.text()).toBe(201);
    const workspaceId = (await response.json()).data.id;
    await page.goto(entry);
    await chooseWorkspace(page, workspaceId);
    return { workspaceId, key, headers };
}
/**
 * 资源选择器打开真实的可访问列表框后按展示名称点选，使用正则时可定位带版本编号或摘要的完整可见选项。
 */
export async function selectResourceOption(control: Locator, name: string | RegExp) {
    await control.click();
    await control
        .page()
        .getByRole("listbox")
        .getByRole("option", { name, exact: typeof name === "string" })
        .click();
}

/**
 * 在对应资源目录进入创建表单，保持当前工作区，并确保资源种类由实际页面入口决定而无需在表单里再选择。
 */
export async function openResourceCreateForm(page: Page, kind: ResourceKind) {
    await closeResourceEditor(page);
    const { path, link, create } = resourceEntry[kind];
    if (new URL(page.url()).pathname !== `/resources/${path}`) {
        await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: link }).click();
    }
    await page.getByRole("button", { name: create, exact: true }).click();
    return resourceCreateForm(page);
}

export async function createResource(page: Page, kind: ResourceKind, key: string): Promise<S["ResourceDTO"]> {
    const form = await openResourceCreateForm(page, kind);
    await form.getByLabel("Key", { exact: true }).fill(key);
    await form.getByLabel("Name", { exact: true }).fill(key);
    const response = page.waitForResponse((r) => r.url().endsWith("/resources") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Create resource" }).click();
    const created = await response;
    expect(created.status(), await created.text()).toBe(201);
    await acknowledgeOperation(page, "Resource created");
    const label = kind === "FIXTURE" ? "Fixture" : kind === "ASSERTION_TEMPLATE" ? "Assertion" : kind;
    const heading =
        kind === "DATASET"
            ? page.getByRole("main").getByRole("heading", { name: key, exact: true, level: 1 })
            : page.getByRole("article").getByRole("heading", { name: `${key} · ${label}`, exact: true });
    await expect(heading).toBeVisible();
    return (await created.json()).data;
}
/**
 * 创建表单通过自己的提交按钮确定范围，使目录中的元素名称和记录标识不会与后台创建字段发生严格匹配冲突。
 */
export function resourceCreateForm(page: Page) {
    return page.locator("form").filter({ has: page.getByRole("button", { name: "Create resource", exact: true }) });
}
/**
 * 独立数据集页通过面包屑返回，仍在抽屉中的编辑器则通过自己的关闭按钮退出；嵌套确认由对应操作处理。
 */
export async function closeResourceEditor(page: Page) {
    if (new URL(page.url()).pathname.startsWith("/resources/datasets/")) {
        const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb", exact: true });
        await breadcrumb.getByRole("link", { name: "Datasets", exact: true }).click();
        await expect(page).toHaveURL(/\/resources\/datasets$/);
        return;
    }
    const drawer = page.getByRole("dialog").filter({ has: page.getByRole("article") });
    if ((await drawer.count()) === 0) return;
    await expect(drawer).toHaveCount(1);
    await drawer.getByRole("button", { name: "Close", exact: true }).click();
    await expect(drawer).toBeHidden();
}
/**
 * 在继续操作前核对应用实际显示的结果，确认后等待结果弹窗离开焦点圈，避免后面的动作误作用于遮罩层。
 */
export async function acknowledgeOperation(page: Page, message: string | RegExp, outcome = "succeeded") {
    const result = page.getByRole("dialog", { name: `Operation ${outcome}`, exact: true });
    await expect(result).toContainText(message);
    await result.getByRole("button", { name: "OK", exact: true }).click();
    await expect(result).toBeHidden();
}
export async function saveDraft(page: Page): Promise<S["DraftDTO"]> {
    await expect(page.locator('ul[role="alert"]')).toHaveCount(0);
    const response = page.waitForResponse((r) => r.url().endsWith("/draft") && r.request().method() === "PUT");
    await page.getByRole("button", { name: "Save draft" }).click();
    const saved = await response;
    expect(saved.status(), await saved.text()).toBe(200);
    await acknowledgeOperation(page, "Saved");
    return (await saved.json()).data;
}
export async function replaceEditorJson(page: Page, text: string) {
    const editor = page
        .getByRole("article")
        .locator(".vq-monaco")
        .filter({
            has: page.getByRole("textbox", { name: "JSON source", exact: true }),
        });
    await editor.locator(".view-lines").click();
    await page.keyboard.press("ControlOrMeta+A");
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
    const editorOrigin = new URL(page.url()).origin;
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: editorOrigin });
    await page.evaluate((value) => navigator.clipboard.writeText(value), text);
    await page.keyboard.press("ControlOrMeta+V");
}
export async function applyDocument(page: Page, content: ResourceDocumentV1) {
    const dataset = content.kind === "DATASET";
    const mode = dataset ? "tab" : "button";
    await page.getByRole(mode, { name: dataset ? "Data (JSON)" : "JSON source", exact: true }).click();
    await replaceEditorJson(page, JSON.stringify(content, null, 2));
    await page.getByRole("button", { name: "Apply JSON" }).click();
    if (dataset) await acknowledgeOperation(page, "JSON applied to the draft editor");
    await expect(page.getByText("Unapplied JSON changes")).toHaveCount(0);
    await page.getByRole(mode, { name: dataset ? "Data (Form)" : "Visual form", exact: true }).click();
    await expect(page.locator('ul[role="alert"]')).toHaveCount(0);
}
export async function queueValidation(page: Page): Promise<S["JobDTO"]> {
    const response = page.waitForResponse((r) => r.url().endsWith("/validate") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Compile and validate" }).click();
    const queued = await response;
    expect(queued.status(), await queued.text()).toBe(202);
    return (await queued.json()).data;
}
/**
 * 验证夹具使用同一受保护测试库和批准发行，独立进程完成编译，所有临时文件在夹具关闭时统一清理。
 */
export async function managedCompiler(page: Page, scope: Pick<EditorScope, "workspaceId">, evidenceTask = "t11") {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const inventory = resolve(
        root,
        process.env.VERIQ_TEST_ENGINE_INVENTORY ?? ".superpowers/cache/t11/release/inventory.json",
    );
    const database = JSON.parse(await readFile(join(root, ".superpowers/sdd/veriq-1/test-env.json"), "utf8"))
        .mysql_dsn as string;
    if (typeof database !== "string" || new URL(database).pathname !== "/veriq_test")
        throw new Error("Compiler fixture requires the isolated veriq_test database");
    const npm = await realpath(join(dirname(process.execPath), "npm"));
    const tsx = await realpath(fileURLToPath(import.meta.resolve("tsx")));
    const profile = await mkdtemp(`/tmp/vq-${evidenceTask}-compiler-`);
    const config = join(profile, "worker.json");
    try {
        await writeFile(
            config,
            JSON.stringify({
                database_url: database,
                public_url: origin,
                master_key: "a".repeat(64),
                signing_key: "b".repeat(64),
                environment: "development",
                approved_engine_inventory_path: inventory,
                server_compiler_release_dir: dirname(inventory),
                server_compiler_node_path: process.execPath,
                server_compiler_npm_cli_path: npm,
                server_compiler_tsx_path: tsx,
            }),
            { mode: 0o600 },
        );
    } catch (error) {
        await rm(profile, { recursive: true, force: true });
        throw error;
    }
    const base = `/api/v1/workspaces/${scope.workspaceId}`;
    const compile = async (expectedCode = 0) => {
        // 仅使用刚写入的私有配置连接测试库，避免外部 VERIQ 环境变量覆盖其数据库地址或编译发行身份。
        const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("VERIQ_")));
        const code = await new Promise<number | null>((resolve, reject) => {
            const child = spawn(
                "uv",
                [
                    "run",
                    "--project",
                    "apps/srv",
                    "--frozen",
                    "--no-sync",
                    "veriq_server",
                    "--config",
                    config,
                    "compile-worker",
                    "--once",
                ],
                { cwd: root, env, stdio: "ignore" },
            );
            child.on("error", reject);
            child.on("close", resolve);
        });
        expect(code, "Independent compiler worker exit status").toBe(expectedCode);
    };
    const publish = async (): Promise<S["ResourceVersionDTO"]> => {
        const datasetTab = page.getByRole("tab", { name: "Data (JSON)", exact: true });
        const isDatasetDetail = (await datasetTab.count()) === 1;
        const isDatasetJson = isDatasetDetail && (await datasetTab.getAttribute("aria-selected")) === "true";
        const job = await queueValidation(page);
        if (!isDatasetJson)
            await expect(page.getByRole("button", { name: "Publish version", includeHidden: true })).toBeDisabled();
        await compile();
        const status = (await (await page.request.get(base + `/jobs/${job.id}`)).json()).data;
        expect(status.outcome).toBe("PASSED");
        const proof = await page.request.get(base + `/jobs/${job.id}/validation-receipt`);
        expect(proof.status(), await proof.text()).toBe(200);
        const receipt: S["ValidationReceiptDTO"] = (await proof.json()).data;
        expect(receipt.serverCompilationId).toEqual(expect.any(String));
        expect(receipt.runtimeId).toBeUndefined();
        expect(receipt.attemptId).toBeUndefined();
        const success = page.getByRole("dialog", { name: "Operation succeeded", exact: true });
        const validationMessage = isDatasetJson ? "Compilation finished · Passed" : "Compilation validated";
        if (isDatasetJson) {
            await expect(success.getByRole("status")).toHaveText(validationMessage);
            await expect(success.getByText("Compilation validated", { exact: true })).toHaveCount(0);
            await expect(success).not.toContainText(receipt.id);
        } else if (isDatasetDetail) await expect(success).toContainText(receipt.id);
        await acknowledgeOperation(page, validationMessage);
        if (!isDatasetDetail) await expect(page.getByText(new RegExp(`^${receipt.id} · `))).toBeVisible();
        const response = page.waitForResponse((r) => r.url().endsWith("/publish") && r.request().method() === "POST");
        await page.getByRole("button", { name: "Publish version" }).click();
        const published = await response;
        expect(published.status(), await published.text()).toBe(201);
        const version: S["ResourceVersionDTO"] = (await published.json()).data;
        const details = `v${version.versionNo} · ${version.id} · ${version.sha256}`;
        if (isDatasetJson) {
            await expect(success).toContainText("Version published");
            await expect(success).not.toContainText(version.id);
        }
        await acknowledgeOperation(page, "Version published");
        if (!isDatasetJson) await expect(page.getByText(details, { exact: true })).toBeVisible();
        return version;
    };
    const close = () => rm(profile, { recursive: true, force: true });
    return { compile, publish, close };
}
