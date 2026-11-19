/**
 * VeriQ 的作用域测试直接挂载产品 Provider 与真实 QueryClient，并以已提交信号、订阅关闭及查询取消为观察依据；页面测试仅
 * 延迟真实服务器响应，不构造资源或替换权限数据。
 */
import { signOut, workspacePicker } from "./support/console-controls";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test, expect, request, type Request } from "@playwright/test";
import { withCleanup } from "./support/case-profile-cleanup";

/**
 * 请求观测仅保留本例列表请求的标识、阶段和时间，栈也必须截断并删除查询参数；字段不包含用户、凭据、请求头或响应正文，
 * 供后续真实浏览器证据区分旧入口和当前入口的请求所有权。
 */
type WorkspaceOwnershipEvent = {
    kind: string;
    at: number;
    epoch: number;
    phase: string;
    fetchId?: string;
    requestId?: number;
    requestEpoch?: number;
    cursor?: boolean;
    pathname?: string;
    ownerPhase?: string;
    stack?: string[];
    signal?: string;
    outcome?: string;
};

declare global {
    /**
     * 此全局只存在于本用例的新页面中，保存被动观测的有限记录和当前操作阶段；不向产品组件传入数据，也不改变查询控制器或
     * 将任何敏感传输字段复制到最终测试附件。
     */
    interface Window {
        workspaceRequestOwnership?: {
            events: WorkspaceOwnershipEvent[];
            overflow: number;
            phase: string;
        };
    }
}

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
 * 三个入口先完成导航与真实列表查询，再用合成可见性事件触发现有焦点刷新；持有当前入口的新响应后切换空间并保留草稿，
 * 此处不把入口交接时淘汰的请求误认为稳定页面的刷新，也不声明操作系统焦点验收。
 */
test("three GUI routes retain manual selection across real directory refetch", async ({ page }, testInfo) => {
    const protocolEvents: WorkspaceOwnershipEvent[] = [];
    const requestIds = new WeakMap<Request, number>();
    const pendingLists = new Set<Request>();
    let requestSequence = 0;
    let protocolOverflow = 0;
    let phase = "setup";
    const observeRequest = (kind: string, original: Request) => {
        const url = new URL(original.url());
        if (
            original.method() !== "GET" ||
            url.origin !== "http://127.0.0.1:5173" ||
            url.pathname !== "/api/v1/workspaces"
        )
            return;
        if (kind === "request") pendingLists.add(original);
        if (kind === "requestfinished" || kind === "requestfailed") pendingLists.delete(original);
        if (!requestIds.has(original)) requestIds.set(original, ++requestSequence);
        if (protocolEvents.length >= 40) {
            protocolOverflow++;
            return;
        }
        protocolEvents.push({
            kind,
            phase,
            at: performance.now(),
            epoch: Date.now(),
            requestId: requestIds.get(original),
            requestEpoch: original.timing().startTime,
            pathname: url.pathname,
            cursor: url.searchParams.has("cursor"),
            outcome:
                kind === "requestfailed"
                    ? original.failure()?.errorText === "net::ERR_ABORTED"
                        ? "net::ERR_ABORTED"
                        : "other request failure"
                    : undefined,
        });
    };
    const requestStarted = (original: Request) => observeRequest("request", original);
    const requestFinished = (original: Request) => observeRequest("requestfinished", original);
    const requestFailed = (original: Request) => observeRequest("requestfailed", original);
    const markPhase = async (next: string) => {
        phase = next;
        await page.evaluate((value) => {
            if (window.workspaceRequestOwnership) window.workspaceRequestOwnership.phase = value;
        }, next);
    };
    await withCleanup(
        async () => {
            /**
             * 仅检查列表调用使用的字符串地址及普通属性，不读取 signal 访问器；转发原始参数与 this 并原样返回原 fetch
             * Promise，监听器只观察终止和结算，不接管取消、重试或网络响应。
             */
            await page.addInitScript(() => {
                const probe = { events: [] as WorkspaceOwnershipEvent[], overflow: 0, phase: "initial document" };
                window.workspaceRequestOwnership = probe;
                const nativeFetch = window.fetch;
                const stack = () =>
                    (new Error().stack ?? "")
                        .split("\n")
                        .slice(1, 13)
                        .map((frame) => frame.replace(/[?#][^)\s]*/g, "[query removed]").slice(0, 240));
                const record = (event: Omit<WorkspaceOwnershipEvent, "at" | "epoch" | "phase">) => {
                    if (probe.events.length >= 60) {
                        probe.overflow++;
                        return;
                    }
                    const at = performance.now();
                    probe.events.push({ ...event, at, epoch: performance.timeOrigin + at, phase: probe.phase });
                };
                window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>): ReturnType<typeof fetch> {
                    const [input, init] = args;
                    if (typeof input !== "string") return Reflect.apply(nativeFetch, this, args);
                    let url: URL;
                    try {
                        url = new URL(input, location.href);
                    } catch {
                        return Reflect.apply(nativeFetch, this, args);
                    }
                    if (url.origin !== location.origin || url.pathname !== "/api/v1/workspaces")
                        return Reflect.apply(nativeFetch, this, args);
                    const method = init && Object.getOwnPropertyDescriptor(init, "method");
                    if (!method || !("value" in method) || method.value !== "GET")
                        return Reflect.apply(nativeFetch, this, args);
                    const descriptor = init && Object.getOwnPropertyDescriptor(init, "signal");
                    const signal: AbortSignal | undefined =
                        descriptor && "value" in descriptor && descriptor.value instanceof AbortSignal
                            ? descriptor.value
                            : undefined;
                    const fetchId = crypto.randomUUID();
                    const ownerPhase = probe.phase;
                    const identity = {
                        fetchId,
                        ownerPhase,
                        pathname: url.pathname,
                        cursor: url.searchParams.has("cursor"),
                    };
                    record({
                        ...identity,
                        kind: "fetch start",
                        stack: stack(),
                        signal: signal
                            ? signal.aborted
                                ? "already aborted"
                                : "own data signal"
                            : descriptor && !("value" in descriptor)
                              ? "accessor not inspected"
                              : "no AbortSignal data",
                    });
                    const aborted = () => record({ ...identity, kind: "signal abort", stack: stack() });
                    signal?.addEventListener("abort", aborted, { once: true });
                    let original: Promise<Response>;
                    try {
                        original = Reflect.apply(nativeFetch, this, args);
                    } catch (error) {
                        signal?.removeEventListener("abort", aborted);
                        record({ ...identity, kind: "fetch synchronous throw" });
                        throw error;
                    }
                    const settled = (outcome: string) => {
                        signal?.removeEventListener("abort", aborted);
                        record({ ...identity, kind: "fetch settled", outcome });
                    };
                    original.then(
                        () => settled("fulfilled"),
                        () => settled("rejected"),
                    );
                    return original;
                };
            });
            page.on("request", requestStarted);
            page.on("requestfinished", requestFinished);
            page.on("requestfailed", requestFailed);
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
             * 站点已初始化不能证明本例操作者存在；独立管理员会话创建活跃系统管理员，页面仍须正常登录，并由该身份
             * 在界面创建自己的两个空间，避免共享管理员列表污染三个入口。
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
            await markPhase("actor login");
            await page.getByRole("textbox", { name: "Email" }).fill(actorEmail);
            await page.getByLabel("Password").fill("Workspace password 123!");
            await page.getByRole("button", { name: "Sign in" }).click();
            await expect(page.locator("dl")).toBeVisible();
            await page.getByRole("link", { name: "Workspaces", exact: true }).click();
            await expect(page.getByText("No Workspaces yet.", { exact: true })).toBeVisible();
            const ids: string[] = [];
            for (const name of ["Alpha", "Beta"]) {
                await page.getByRole("button", { name: "Add workspace", exact: true }).click();
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
                ids.push(await workspacePicker(page).inputValue());
            }
            const membership = (await (await page.request.get("/api/v1/workspaces")).json()).data;
            expect(membership.items.map((workspace: { id: string }) => workspace.id).sort()).toEqual([...ids].sort());
            expect(membership.items.map((workspace: { role: string }) => workspace.role)).toEqual(["OWNER", "OWNER"]);
            expect(membership.nextCursor).toBeNull();
            const [alpha, beta] = ids;
            for (const entry of [
                {
                    link: "Workspaces",
                    pathname: "/workspaces",
                    heading: "Workspaces",
                    input: page
                        .locator("form")
                        .filter({
                            has: page.getByRole("button", { name: "Rename Workspace", exact: true }),
                        })
                        .getByLabel("Name", { exact: true }),
                },
                {
                    link: "Runtimes",
                    pathname: "/runtimes",
                    heading: "Runtimes",
                    input: page.getByLabel("Approval code"),
                },
                {
                    link: "Plans",
                    pathname: "/execution-plans",
                    heading: "Execution plans",
                    input: page.getByLabel("Plan name"),
                },
            ]) {
                const path = "http://127.0.0.1:5173/api/v1/workspaces";
                await expect.poll(() => pendingLists.size).toBe(0);
                const navigationList =
                    new URL(page.url()).pathname !== entry.pathname
                        ? page.waitForResponse(
                              (response) => response.request().method() === "GET" && response.url() === path,
                          )
                        : undefined;
                await markPhase(`${entry.link}:navigate before barrier`);
                await page.getByRole("link", { name: entry.link, exact: true }).click();
                const heading = page.getByRole("heading", { level: 1, name: entry.heading, exact: true });
                await expect(heading).toBeVisible();
                if (navigationList) expect(await (await navigationList).finished()).toBeNull();
                const panel = page.locator("section.panel").filter({ has: heading });
                const selector = workspacePicker(page);
                const input = entry.input.and(panel.locator("input, select"));
                await expect(selector.locator(`option[value="${alpha}"]`)).toHaveText("W2B Alpha");
                await expect(selector.locator(`option[value="${beta}"]`)).toHaveText("W2B Beta");
                await markPhase(`${entry.link}:prepare Alpha`);
                await selector.selectOption(alpha);
                await expect(selector).toHaveValue(alpha);
                await expect(input).toBeVisible();
                await expect.poll(() => pendingLists.size).toBe(0);
                /**
                 * 保存当前入口的选择器节点，持有响应期间只能操作这个仍连接的节点，不能让定位器在卸载后暗中重试新页；
                 * 输入框允许随合法空间子视图重建，选择器和标题归属则必须保持。
                 */
                const ownedPicker = await selector.elementHandle();
                if (!ownedPicker) throw new Error("Stable entry Workspace picker is missing");
                const pickerIsCurrent = () =>
                    ownedPicker.evaluate(
                        (element, title) =>
                            element.isConnected &&
                            !!element.closest("header") &&
                            document.querySelector("main h1")?.textContent?.trim() === title,
                        entry.heading,
                    );
                expect(await pickerIsCurrent()).toBe(true);
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
                let heldRequest: Request | undefined;
                const aborted: string[] = [];
                const failed = (request: import("@playwright/test").Request) => {
                    if (request.method() === "GET" && request.url() === path)
                        aborted.push(request.failure()?.errorText ?? "Unknown request failure");
                };
                const barrier = async (route: import("@playwright/test").Route) => {
                    if (held || route.request().method() !== "GET" || route.request().url() !== path)
                        return route.continue();
                    held = true;
                    heldRequest = route.request();
                    observeRequest("held original request", route.request());
                    let response: import("@playwright/test").APIResponse | undefined;
                    try {
                        response = await route.fetch();
                        expect(response.status()).toBe(200);
                        observeRequest("held upstream 200", route.request());
                        captured();
                        await released;
                        observeRequest("held released", route.request());
                        if (!route.request().failure()) await route.fulfill({ response });
                    } finally {
                        try {
                            await response?.dispose();
                        } finally {
                            completed();
                        }
                    }
                };
                await withCleanup(
                    async () => {
                        page.on("requestfailed", failed);
                        await page.route(path, barrier);
                        await markPhase(`${entry.link}:synthetic visible refetch`);
                        await page.evaluate(() => {
                            if (document.visibilityState !== "visible")
                                throw new Error("Visibility refetch requires a visible document");
                            const probe = window.workspaceRequestOwnership;
                            if (probe) {
                                if (probe.events.length < 60) {
                                    const at = performance.now();
                                    probe.events.push({
                                        kind: "synthetic visibilitychange",
                                        at,
                                        epoch: performance.timeOrigin + at,
                                        phase: probe.phase,
                                    });
                                } else probe.overflow++;
                            }
                            window.dispatchEvent(new Event("visibilitychange"));
                        });
                        await expect
                            .poll(() => held, {
                                message: "Current entry visibility event must start a new Workspace list GET",
                            })
                            .toBe(true);
                        await backendCompleted;
                        expect(heldRequest && pendingLists.has(heldRequest)).toBe(true);
                        expect(await pickerIsCurrent()).toBe(true);
                        await markPhase(`${entry.link}:select Beta`);
                        await ownedPicker.selectOption(beta);
                        expect(await pickerIsCurrent()).toBe(true);
                        await markPhase(`${entry.link}:write unsaved value`);
                        const unsaved = entry.link === "Runtimes" ? "ABCDEFGH2345" : "Beta unsaved " + entry.link;
                        await input.fill(unsaved);
                        await markPhase(`${entry.link}:release held list`);
                        release();
                        await finished;
                        await expect
                            .poll(() => heldRequest && !pendingLists.has(heldRequest), {
                                message: "The original held list request must finish or fail in the page",
                            })
                            .toBe(true);
                        expect(heldRequest?.failure()).toBeNull();
                        expect(aborted).toEqual([]);
                        expect(await pickerIsCurrent()).toBe(true);
                        await expect(selector).toHaveValue(beta);
                        await expect(input).toHaveValue(unsaved);
                        if (entry.link === "Workspaces")
                            await expect(page.getByRole("article")).toContainText("W2B Beta");
                        await markPhase(`${entry.link}:select Alpha`);
                        await ownedPicker.selectOption(alpha);
                        if (entry.link === "Runtimes" || entry.link === "Plans") await expect(input).toHaveValue("");
                    },
                    async () => {
                        await withCleanup(
                            async () => {
                                release();
                                if (held) await finished;
                                await page.unroute(path, barrier);
                            },
                            async () => {
                                page.off("requestfailed", failed);
                                await ownedPicker.dispose();
                            },
                        );
                    },
                );
            }
            await markPhase("Plans:session reset");
            await workspacePicker(page).selectOption(beta);
            await page.getByLabel("Plan name").fill("Beta unsaved Plan");
            await signOut(page);
            await page.getByRole("textbox", { name: "Email" }).fill(actorEmail);
            await page.getByLabel("Password").fill("Workspace password 123!");
            await page.getByRole("button", { name: "Sign in" }).click();
            await expect(page.locator("dl")).toBeVisible();
            await page.getByRole("link", { name: "Plans", exact: true }).click();
            await expect(workspacePicker(page)).toHaveValue(alpha);
            await expect(page.getByLabel("Plan name")).toHaveValue("");
        },
        async () => {
            let browser: { events: WorkspaceOwnershipEvent[]; overflow: number; phase: string } | null = null;
            await withCleanup(
                async () => {
                    browser = await page.evaluate(() => window.workspaceRequestOwnership ?? null);
                },
                async () => {
                    page.off("request", requestStarted);
                    page.off("requestfinished", requestFinished);
                    page.off("requestfailed", requestFailed);
                    /**
                     * 先写入结果目录再按路径附加有界观测，使通过场景也能保留同一份文件；写入失败仍传播原始错误。
                     */
                    const evidencePath = testInfo.outputPath("workspace-request-ownership.json");
                    const payload = Buffer.from(
                        JSON.stringify(
                            {
                                schema: "workspace-request-ownership-v1",
                                eventLimit: 100,
                                browserLimit: 60,
                                protocolLimit: 40,
                                browser,
                                protocolEvents,
                                protocolOverflow,
                                correlation:
                                    "requestId is exact protocol identity; fetchId joins require timing review.",
                            },
                            null,
                            2,
                        ),
                    );
                    await writeFile(evidencePath, payload);
                    await testInfo.attach("workspace-request-ownership.json", {
                        contentType: "application/json",
                        path: evidencePath,
                    });
                },
            );
        },
    );
});
