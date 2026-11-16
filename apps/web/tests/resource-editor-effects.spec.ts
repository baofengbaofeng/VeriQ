/**
 * VeriQ 资源回归只经真实安装、登录与空间接口建立测试前置条件；编辑器回归单独挂载实际导出的 Monaco，并通过浏览器输入和
 * 公共生命周期状态观察受控更新。
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import type { editor } from "monaco-editor/editor";

/**
 * 浏览器内探针仅保存测试自己拥有的真实编辑器、模型与根节点，并暴露父级重渲染和卸载动作；不替换产品组件、不修改模型内容
 * ，也不进入业务页面的运行路径。
 */
interface EditorProbe {
    editor: editor.ICodeEditor;
    model: editor.ITextModel;
    events: { generation: number; value: string }[];
    baselineModels: number;
    models: () => number;
    rerender: () => void;
    replace: () => void;
    unmount: () => void;
    remount: () => void;
}

declare global {
    /**
     * 测试页面在独立文档中保存自有探针以便浏览器自动化读取真实模型和订阅状态；类型声明不生成产品入口，也不向正式资源页
     * 面增加任何调试能力或状态持久化承诺。
     */
    interface Window {
        resourceEditor: EditorProbe;
    }
}

test("resources retain manual workspace and unsaved values across list refresh", async ({
    page,
}) => {
    const origin = "http://127.0.0.1:5173";
    const setup = (await (await page.request.get("/api/v1/setup")).json()).data;
    if (!setup.initialized)
        expect(
            (
                await page.request.post("/api/v1/setup", {
                    headers: { Origin: origin, "X-CSRF-Token": setup.csrfToken },
                    data: {
                        installationSecret: "browser-operator-secret",
                        email: "browser-admin@example.com",
                        displayName: "Browser Administrator",
                        password: "Browser password 123!",
                    },
                })
            ).status(),
        ).toBe(201);
    await page.goto("/login");
    await page.getByTestId("email").fill("browser-admin@example.com");
    await page.getByTestId("password").fill("Browser password 123!");
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("account-info")).toBeVisible();
    const session = (await (await page.request.get("/api/v1/auth/session")).json()).data;
    const ids: string[] = [];
    for (const name of ["Alpha", "Beta"]) {
        const response = await page.request.post("/api/v1/workspaces", {
            headers: { Origin: origin, "X-CSRF-Token": session.csrfToken },
            data: { key: `resource-${randomUUID()}`, name: `Resource ${name}` },
        });
        expect(response.status()).toBe(201);
        ids.push((await response.json()).data.id);
    }
    const [alpha, beta] = ids as [string, string];
    const path = `${origin}/api/v1/workspaces`;
    const listing = page.waitForResponse(
        (response) => response.request().method() === "GET" && response.url() === path,
    );
    const queried: string[] = [];
    page.on("request", (request) => {
        if (
            request.method() === "GET" &&
            /\/workspaces\/[^/]+\/resources$/.test(new URL(request.url()).pathname)
        )
            queried.push(request.url());
    });
    await page.goto("/resources");
    const first = (await (await listing).json()).data.items[0].id as string;
    const selector = page.getByTestId("resource-workspace");
    await expect(selector).toHaveValue(first);
    await expect(page.getByTestId("resource-empty")).toBeVisible();
    expect(
        queried.some((url) => new URL(url).pathname === `/api/v1/workspaces/${first}/resources`),
    ).toBe(true);

    /**
     * 先离开资源入口取得已完成的真实列表，再在回到入口时暂缓交付下一次服务器响应；用户在响应抵达之前选择 Beta，释放后
     * 验证表单与选中空间都未被默认值重置。
     */
    const staged = page.waitForResponse(
        (response) => response.request().method() === "GET" && response.url() === path,
    );
    await page.getByRole("link", { name: "Workspaces", exact: true }).click();
    await (await staged).finished();
    const renamed = await page.request.patch(`/api/v1/workspaces/${beta}`, {
        headers: { Origin: origin, "X-CSRF-Token": session.csrfToken },
        data: { name: "Resource Beta refreshed" },
    });
    expect(renamed.status()).toBe(200);
    let captured!: () => void;
    let release!: () => void;
    let completed!: () => void;
    const backendCompleted = new Promise<void>((resolve) => {
        captured = resolve;
    });
    const released = new Promise<void>((resolve) => {
        release = resolve;
    });
    const finished = new Promise<void>((resolve) => {
        completed = resolve;
    });
    let held = false;
    const barrier = async (route: import("@playwright/test").Route) => {
        if (held || route.request().method() !== "GET" || route.request().url() !== path)
            return route.continue();
        held = true;
        let response: import("@playwright/test").APIResponse | undefined;
        try {
            response = await route.fetch();
            expect(response.status()).toBe(200);
            captured();
            await released;
            await route.fulfill({ response });
        } finally {
            await response?.dispose();
            completed();
        }
    };
    await page.route(path, barrier);
    try {
        await page.getByRole("link", { name: "Resources", exact: true }).click();
        await backendCompleted;
        await selector.selectOption(beta);
        await expect(page.getByTestId("resource-empty")).toBeVisible();
        await page.getByTestId("resource-kind").selectOption("DATASET");
        await page.getByTestId("resource-key").fill("unsaved_beta");
        await page.getByTestId("resource-name").fill("Unsaved Beta resource");
        const refreshed = page.waitForResponse(
            (response) => response.request().method() === "GET" && response.url() === path,
        );
        release();
        await finished;
        await (await refreshed).finished();
        await expect(selector.locator(`option[value="${beta}"]`)).toHaveText(
            "Resource Beta refreshed",
        );
        await expect(selector).toHaveValue(beta);
        await expect(page.getByTestId("resource-kind")).toHaveValue("DATASET");
        await expect(page.getByTestId("resource-key")).toHaveValue("unsaved_beta");
        await expect(page.getByTestId("resource-name")).toHaveValue("Unsaved Beta resource");
        expect(
            queried.some((url) => new URL(url).pathname === `/api/v1/workspaces/${beta}/resources`),
        ).toBe(true);
        await selector.selectOption(alpha);
        await expect(page.getByTestId("resource-key")).toHaveValue("");
        await expect(page.getByTestId("resource-name")).toHaveValue("");
        await expect(page.getByTestId("resource-kind")).toHaveValue("CASE");
        await expect(page.getByTestId("resource-empty")).toBeVisible();
    } finally {
        release();
        if (held) await finished;
        await page.unroute(path, barrier);
    }
});

test("actual Monaco preserves controlled edits and model lifetime", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("header")).toBeVisible();
    await page.goto(`/@fs${fileURLToPath(new URL("../package.json", import.meta.url))}`);
    await page.evaluate(async () => {
        const refreshPath = "/@react-refresh";
        const refresh = await import(/* @vite-ignore */ refreshPath);
        refresh.default.injectIntoGlobalHook(window);
        Object.assign(window, {
            $RefreshReg$: () => {},
            $RefreshSig$: () => (type: unknown) => type,
            __vite_plugin_react_preamble_installed__: true,
        });
        /**
         * 从 Vite 实际转换结果取得浏览器模块地址，确保测试根节点与产品组件共用同一 React 和 Monaco 实例；这里只解析依
         * 赖地址，不把源码字符串当成产品行为通过的依据。
         */
        const source = await (await fetch("/src/features/resources/Monaco.tsx")).text();
        const reactPath = source.match(/from "([^"\n]+\/react\.js[^"\n]*)"/)?.[1];
        const monacoPath = source.match(/import \* as monaco from "([^"\n]+)"/)?.[1];
        if (!reactPath || !monacoPath) throw new Error("Missing browser editor modules");
        const load = (path: string) => import(/* @vite-ignore */ path);
        const React = (await load(reactPath)).default;
        const { createRoot } = (await load(reactPath.replace("/react.js", "/react-dom_client.js")))
            .default;
        const { flushSync } = (await load(reactPath.replace("/react.js", "/react-dom.js"))).default;
        const { Monaco } = await load("/src/features/resources/Monaco.tsx");
        const monaco = (await load(monacoPath)) as typeof import("monaco-editor/editor");
        await load("/src/features/resources/resources.css");
        const baselineModels = monaco.editor.getModels().length;
        const events: EditorProbe["events"] = [];
        let value = "alpha";
        let generation = 1;
        let label = "Lifecycle source";
        let language = "plaintext";
        let readOnly = false;
        let turn = 0;
        let host: HTMLDivElement;
        let root: ReturnType<typeof createRoot>;
        const render = () => {
            const callbackGeneration = generation;
            flushSync(() =>
                root.render(
                    React.createElement(
                        "section",
                        { "data-turn": turn },
                        React.createElement(Monaco, {
                            value,
                            language,
                            readOnly,
                            label,
                            onChange: (next: string) => {
                                events.push({ generation: callbackGeneration, value: next });
                                value = next;
                                render();
                            },
                        }),
                    ),
                ),
            );
        };
        const mount = () => {
            host = document.createElement("div");
            host.dataset.testid = "component-editor-host";
            document.body.append(host);
            root = createRoot(host);
            render();
        };
        mount();
        const current = () => {
            const actual = monaco.editor
                .getEditors()
                .find((item) => host.contains(item.getDomNode()));
            const model = actual?.getModel();
            if (!actual || !model) throw new Error("Missing actual owned Monaco editor");
            return { editor: actual, model };
        };
        window.resourceEditor = {
            ...current(),
            events,
            baselineModels,
            models: () => monaco.editor.getModels().length,
            rerender: () => {
                generation = 2;
                turn++;
                render();
            },
            replace: () => {
                value = "latest controlled replacement";
                label = "Recreated source";
                language = "json";
                readOnly = true;
                render();
            },
            unmount: () => {
                const owned = current();
                flushSync(() => root.unmount());
                host.remove();
                if (!owned.model.isDisposed() || owned.editor.getModel() !== null)
                    throw new Error("Owned editor survived unmount");
            },
            remount: () => {
                generation = 3;
                value = "remounted";
                label = "Remounted source";
                language = "plaintext";
                readOnly = false;
                mount();
                Object.assign(window.resourceEditor, current());
            },
        };
    });
    const input = page.getByRole("textbox", { name: "Lifecycle source", exact: true });
    await page
        .getByTestId("monaco")
        .locator(".view-lines")
        .click({ position: { x: 30, y: 10 } });
    await input.press("Control+End");
    await input.pressSequentially(" beta");
    await expect
        .poll(() => page.evaluate(() => window.resourceEditor.model.getValue()))
        .toBe("alpha beta");
    /**
     * 使用编辑器公开的撤销边界固定已经通过真实键盘输入形成的早期状态，避免假设浏览器逐键事件如何合并；后续撤销必须返回
     * 这个已观察到的内容，而不能手动设置模型来制造成功。
     */
    const selection = await page.evaluate(() => {
        const probe = window.resourceEditor;
        probe.editor.pushUndoStop();
        return probe.editor.getSelection()?.toString();
    });
    await page.evaluate(() => window.resourceEditor.rerender());
    expect(
        await page.evaluate(() => {
            const probe = window.resourceEditor;
            return {
                sameModel: probe.editor.getModel() === probe.model,
                selection: probe.editor.getSelection()?.toString(),
                canUndo: probe.model.canUndo(),
                models: probe.models() - probe.baselineModels,
            };
        }),
    ).toEqual({ sameModel: true, selection, canUndo: true, models: 1 });
    await input.pressSequentially(" gamma");
    await expect
        .poll(() => page.evaluate(() => window.resourceEditor.events.at(-1)))
        .toEqual({
            generation: 2,
            value: "alpha beta gamma",
        });
    await input.press("Control+z");
    await expect
        .poll(() => page.evaluate(() => window.resourceEditor.model.getValue()))
        .toBe("alpha beta");
    expect(
        await page.evaluate(() => {
            const probe = window.resourceEditor;
            probe.replace();
            return {
                oldDisposed: probe.model.isDisposed(),
                models: probe.models() - probe.baselineModels,
            };
        }),
    ).toEqual({ oldDisposed: true, models: 1 });
    await expect(
        page.getByRole("textbox", { name: "Recreated source", exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("monaco")).toContainText("latest controlled replacement");
    const previousEvents = await page.evaluate(() => {
        const probe = window.resourceEditor;
        probe.unmount();
        if (probe.models() !== probe.baselineModels)
            throw new Error("Owned model survived unmount");
        return probe.events.filter((event) => event.generation !== 3).length;
    });
    await expect(page.getByTestId("component-editor-host")).toHaveCount(0);
    await page.evaluate(() => window.resourceEditor.remount());
    const remounted = page.getByRole("textbox", { name: "Remounted source", exact: true });
    await page
        .getByTestId("monaco")
        .locator(".view-lines")
        .click({ position: { x: 30, y: 10 } });
    await remounted.press("Control+End");
    await remounted.pressSequentially(" fresh");
    await expect
        .poll(() => page.evaluate(() => window.resourceEditor.events.at(-1)))
        .toEqual({
            generation: 3,
            value: "remounted fresh",
        });
    expect(
        await page.evaluate(
            () => window.resourceEditor.events.filter((event) => event.generation !== 3).length,
        ),
    ).toBe(previousEvents);
    await page.evaluate(() => {
        const probe = window.resourceEditor;
        probe.unmount();
        if (
            !probe.model.isDisposed() ||
            probe.editor.getModel() !== null ||
            probe.models() !== probe.baselineModels
        )
            throw new Error("Remounted editor survived unmount");
    });
    await expect(page.getByTestId("component-editor-host")).toHaveCount(0);
});
