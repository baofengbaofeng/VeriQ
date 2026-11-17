/**
 * VeriQ 的作用域测试直接挂载产品 Provider 与真实 QueryClient，并以已提交信号、订阅关闭及查询取消为观察依据；页面测试仅
 * 延迟真实服务器响应，不构造资源或替换权限数据。
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test, expect, request } from "@playwright/test";

test("actual Provider preserves scopes and releases the latest committed scope", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("header")).toBeVisible();
    await page.goto("/@fs" + fileURLToPath(new URL("../package.json", import.meta.url)));
    const result = await page.evaluate(async () => {
        const refreshPath = "/@react-refresh";
        const refresh = await import(/* @vite-ignore */ refreshPath);
        refresh.default.injectIntoGlobalHook(window);
        Object.assign(window, {
            $RefreshReg$: () => {},
            $RefreshSig$: () => (type: unknown) => type,
            __vite_plugin_react_preamble_installed__: true,
        });
        // 私有 Vite 缓存中的依赖带各自的浏览器版本参数，这里只读取实际模块地址以共享产品使用的 React 与查询上下文；断言
        // 始终观察真实组件行为而不检查源码字符串。
        const source = await (await fetch("/src/features/workspaces/WorkspaceContext.tsx")).text();
        const reactPath = source.match(/from "([^"\n]+\/react\.js[^"\n]*)"/)?.[1];
        if (!reactPath) throw new Error("Missing browser React module");
        const load = (path: string) => import(/* @vite-ignore */ path);
        const { WorkspaceProvider, useWorkspace } = await load("/src/features/workspaces/WorkspaceContext.tsx");
        const React = (await load(reactPath)).default;
        const { createRoot } = (await load(reactPath.replace("/react.js", "/react-dom_client.js"))).default;
        const { flushSync } = (await load(reactPath.replace("/react.js", "/react-dom.js"))).default;
        const queryPath = source.match(/from "([^"\n]+\/@tanstack_react-query\.js[^"\n]*)"/)?.[1];
        if (!queryPath) throw new Error("Missing browser Query module");
        const { useQueryClient } = await load(queryPath);
        let scope: ReturnType<typeof useWorkspace>;
        let client: ReturnType<typeof useQueryClient>;
        const events: string[] = [];
        // 组件须在浏览器序列化回调内定义，每项测试只执行一次并复用同一函数身份，不能捕获 Node 测试进程的模块或状态。
        // biome-ignore lint/correctness/noComponentHookFactories: 测试回调组件须在隔离回调内定义
        function Probe() {
            scope = useWorkspace();
            client = useQueryClient();
            return React.createElement("output", null, scope.selected);
        }
        const host = document.createElement("div");
        document.body.append(host);
        const root = createRoot(host);
        const render = () =>
            flushSync(() => root.render(React.createElement(WorkspaceProvider, null, React.createElement(Probe))));
        render();
        flushSync(() => scope.select("Alpha"));
        const alpha = scope.signal;
        const retained = scope.select;
        scope.subscribe(() => events.push("Alpha close"));
        alpha.addEventListener("abort", () => events.push("Alpha abort"));
        let querySignal: AbortSignal | undefined;
        const query = client
            .fetchQuery({
                queryKey: ["workspace", "Alpha", "active"],
                queryFn: ({ signal }: { signal: AbortSignal }) => {
                    querySignal = signal;
                    return new Promise((_resolve, reject) =>
                        signal.addEventListener(
                            "abort",
                            () => {
                                events.push("query abort");
                                reject(signal.reason);
                            },
                            { once: true },
                        ),
                    );
                },
            })
            .catch(() => undefined);
        client.setQueryData(["workspace", "Alpha", "cached"], "Alpha data");
        client.setQueryData(["outside"], "preserved");
        render();
        const unrelated = {
            sameSignal: scope.signal === alpha,
            alive: !alpha.aborted,
            queryAlive: querySignal !== undefined && !querySignal.aborted,
            closes: events.length,
        };
        flushSync(() => scope.select("Alpha"));
        const same = {
            signal: scope.signal === alpha,
            queryAlive: querySignal !== undefined && !querySignal.aborted,
            cached: client.getQueryData(["workspace", "Alpha", "cached"]),
            closes: events.length,
        };
        flushSync(() => scope.select("Beta"));
        await query;
        const beta = scope.signal;
        const switched = {
            selected: scope.selected,
            oldAborted: alpha.aborted,
            fresh: beta !== alpha && !beta.aborted,
            queryAborted: querySignal?.aborted,
            removed: client.getQueryCache().findAll({ queryKey: ["workspace"] }).length,
            outside: client.getQueryData(["outside"]),
            order: [...events],
        };
        flushSync(() => retained("Alpha"));
        const retainedCurrent = scope.selected;
        flushSync(() => scope.select("Gamma"));
        const latest = scope.signal;
        let finalCloses = 0;
        const close = scope.subscribe(() => {
            finalCloses++;
        });
        render();
        const latestAliveBeforeUnmount = !latest.aborted;
        flushSync(() => root.unmount());
        close();
        return {
            unrelated,
            same,
            switched,
            retainedCurrent,
            latestAliveBeforeUnmount,
            final: {
                aborted: latest.aborted,
                closes: finalCloses,
                cache: client.getQueryCache().getAll().length,
            },
        };
    });
    expect(result.unrelated).toEqual({
        sameSignal: true,
        alive: true,
        queryAlive: true,
        closes: 0,
    });
    expect(result.same).toEqual({
        signal: true,
        queryAlive: true,
        cached: "Alpha data",
        closes: 0,
    });
    expect(result.switched).toEqual({
        selected: "Beta",
        oldAborted: true,
        fresh: true,
        queryAborted: true,
        removed: 0,
        outside: "preserved",
        order: ["Alpha close", "Alpha abort", "query abort"],
    });
    expect(result.latestAliveBeforeUnmount).toBe(true);
    expect(result.final).toEqual({ aborted: true, closes: 1, cache: 0 });
    expect(result.retainedCurrent).toBe("Alpha");
});

/**
 * 页面入口均使用真实登录、空间创建和服务查询，先收到后端完成的旧列表再通过可见选择器切换，最后释放原响应并验证当前空间
 * 的表单没有被默认首项或引用变化重置。
 */
test("four GUI entry selectors retain manual selection across real list refetch", async ({ page }) => {
    const setup = (await (await page.request.get("/api/v1/setup")).json()).data;
    if (!setup.initialized) {
        expect(
            (
                await page.request.post("/api/v1/setup", {
                    headers: { Origin: "http://127.0.0.1:5173", "X-CSRF-Token": setup.csrfToken },
                    data: {
                        installationSecret: "browser-operator-secret",
                        email: "browser-admin@example.com",
                        displayName: "Browser Administrator",
                        password: "Browser password 123!",
                    },
                })
            ).status(),
        ).toBe(201);
    }
    /**
     * 站点已初始化不能证明本例操作者存在；独立管理员会话通过管理接口创建活跃系统管理员，页面仍须正常登录，并由该身份
     * 在界面创建自己的两个空间，避免共享管理员列表污染四个入口。
     */
    const actorEmail = `w2b-${randomUUID()}@example.com`;
    const administrator = await request.newContext({ baseURL: "http://127.0.0.1:5173" });
    try {
        const anonymous = (await (await administrator.get("/api/v1/setup")).json()).data;
        const login = await administrator.post("/api/v1/auth/login", {
            headers: { Origin: "http://127.0.0.1:5173", "X-CSRF-Token": anonymous.csrfToken },
            data: { email: "browser-admin@example.com", password: "Browser password 123!" },
        });
        expect(login.status()).toBe(200);
        const session = (await login.json()).data;
        const created = await administrator.post("/api/v1/admin/users", {
            headers: { Origin: "http://127.0.0.1:5173", "X-CSRF-Token": session.csrfToken },
            data: {
                email: actorEmail,
                displayName: "Workspace operator",
                password: "Workspace password 123!",
                systemAdmin: true,
            },
        });
        expect(created.status()).toBe(201);
        const actor = (await created.json()).data;
        expect(actor).toMatchObject({ email: actorEmail, disabled: false, systemAdmin: true });
    } finally {
        await administrator.dispose();
    }
    await page.goto("/login");
    await page.getByRole("textbox", { name: "Email" }).fill(actorEmail);
    await page.getByLabel("Password").fill("Workspace password 123!");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("dl")).toBeVisible();
    await page.getByRole("link", { name: "Workspaces", exact: true }).click();
    await expect(page.getByText("No Workspaces yet.", { exact: true })).toBeVisible();
    const ids: string[] = [];
    for (const name of ["Alpha", "Beta"]) {
        await page.getByLabel("Key").fill("w2b-" + name.toLowerCase());
        await page
            .locator("form")
            .filter({
                has: page.getByRole("button", { name: "Create Workspace", exact: true }),
            })
            .getByLabel("Name", { exact: true })
            .fill("W2B " + name);
        await page.getByRole("button", { name: "Create Workspace" }).click();
        await expect(page.getByRole("article")).toContainText("W2B " + name);
        ids.push(await page.getByLabel("Current Workspace").inputValue());
    }
    const membership = (await (await page.request.get("/api/v1/workspaces")).json()).data;
    expect(membership.items.map((workspace: { id: string }) => workspace.id).sort()).toEqual([...ids].sort());
    expect(membership.items.map((workspace: { role: string }) => workspace.role)).toEqual(["OWNER", "OWNER"]);
    expect(membership.nextCursor).toBeNull();
    const [alpha, beta] = ids;
    for (const entry of [
        {
            link: "Workspaces",
            selector: page.getByLabel("Current Workspace"),
            input: page
                .locator("form")
                .filter({
                    has: page.getByRole("button", { name: "Create Workspace", exact: true }),
                })
                .getByLabel("Name", { exact: true }),
        },
        {
            link: "Runtimes",
            selector: page.getByLabel("Workspace"),
            input: page.getByLabel("Approval code"),
        },
        {
            link: "Plans",
            selector: page.getByLabel("Plan Workspace"),
            input: page.getByLabel("Plan name"),
        },
        {
            link: "Bundles",
            selector: page.getByLabel("Bundle Workspace"),
            input: page.getByLabel("Selection"),
        },
    ]) {
        await page.getByRole("link", { name: entry.link, exact: true }).click();
        const selector = entry.selector;
        await expect(selector.locator(`option[value="${alpha}"]`)).toHaveText("W2B Alpha");
        await selector.selectOption(alpha);
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
        const path = "http://127.0.0.1:5173/api/v1/workspaces";
        const aborted: string[] = [];
        const failed = (request: import("@playwright/test").Request) => {
            if (request.method() === "GET" && request.url() === path)
                aborted.push(request.failure()?.errorText ?? "Unknown request failure");
        };
        const barrier = async (route: import("@playwright/test").Route) => {
            if (held || route.request().method() !== "GET" || route.request().url() !== path) return route.continue();
            held = true;
            let response: import("@playwright/test").APIResponse | undefined;
            try {
                response = await route.fetch();
                expect(response.status()).toBe(200);
                captured();
                await released;
                if (!route.request().failure()) await route.fulfill({ response });
            } finally {
                await response?.dispose();
                completed();
            }
        };
        const away = entry.link === "Workspaces" ? "Runtimes" : "Workspaces";
        const staged = page.waitForResponse(
            (response) => response.request().method() === "GET" && response.url() === path,
        );
        await page.getByRole("link", { name: away, exact: true }).click();
        await (await staged).finished();
        page.on("requestfailed", failed);
        await page.route(path, barrier);
        try {
            await page.getByRole("link", { name: entry.link, exact: true }).click();
            await backendCompleted;
            await selector.selectOption(beta);
            const input = entry.input;
            if (entry.link === "Bundles") await input.selectOption("SUITE");
            else await input.fill(entry.link === "Runtimes" ? "ABCDEFGH2345" : "Beta unsaved " + entry.link);
            release();
            await finished;
            expect(aborted).toEqual([]);
            await expect(selector).toHaveValue(beta);
            await expect(input).toHaveValue(
                entry.link === "Bundles"
                    ? "SUITE"
                    : entry.link === "Runtimes"
                      ? "ABCDEFGH2345"
                      : "Beta unsaved " + entry.link,
            );
            if (entry.link === "Workspaces") await expect(page.getByRole("article")).toContainText("W2B Beta");
            await selector.selectOption(alpha);
            if (entry.link === "Runtimes" || entry.link === "Plans") await expect(input).toHaveValue("");
            if (entry.link === "Bundles") await expect(input).toHaveValue("CASE");
        } finally {
            release();
            if (held) await finished;
            await page.unroute(path, barrier);
            page.off("requestfailed", failed);
        }
    }
    await page.getByRole("combobox", { name: "Bundle Workspace" }).selectOption(beta);
    await page.getByLabel("Selection").selectOption("SUITE");
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByRole("textbox", { name: "Email" }).fill(actorEmail);
    await page.getByLabel("Password").fill("Workspace password 123!");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("dl")).toBeVisible();
    await page.getByRole("link", { name: "Bundles", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Bundle Workspace" })).toHaveValue(alpha);
    await expect(page.getByLabel("Selection")).toHaveValue("CASE");
});
