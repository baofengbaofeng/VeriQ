/**
 * 业务站发起固定浏览器 SSO 入口，原生表单完成登录后在同一 Context 中读取已固定的身份接口。
 * 认证证据仅记录阶段、结果和时间，浏览器异常及登录材料不跨越此模块的公共接口。
 */
import type { ElementHandle, Page } from "@playwright/test";
import { resolvePointer, type BrowserSsoAuthConfigV1, type FixtureIdentityV1, type JsonValue } from "@veriq/contracts";
import { authorizedURL } from "../http.js";
import type { LifecycleContext } from "../register-case.js";
import { guardSsoPage } from "./sso-boundary.js";

const authErrors = new Set([
    "CANCELLED",
    "CREDENTIAL_PROVIDER_REQUIRED",
    "CREDENTIAL_SHAPE_INVALID",
    "IDENTITY_NOT_ALLOWED",
    "SSO_AUTHENTICATION_FAILED",
    "SSO_CHALLENGE_REQUIRED",
    "SSO_FLOW_INVALID",
    "SSO_ORIGIN_NOT_ALLOWED",
    "SSO_SCOPE_UNAVAILABLE",
]);

/**
 * 保存已校验的元素句柄而不重定位，防止在页面换址后的另一个同名登录表单中填写测试凭据。
 */
async function loginControls(page: Page, config: BrowserSsoAuthConfigV1, target: string) {
    const locators = [
        page.getByLabel(config.usernameLabel, { exact: true }),
        page.getByLabel(config.passwordLabel, { exact: true }),
        page.getByRole("button", { name: config.submitName, exact: true }),
    ] as const;
    const handles: ElementHandle<HTMLElement | SVGElement>[] = [];
    try {
        for (const locator of locators) handles.push(await locator.elementHandle({ timeout: 10000 }));
        const [username, password, submit] = handles;
        if (!username || !password || !submit) throw new Error("SSO_CHALLENGE_REQUIRED");
        const matches = await submit.evaluate(
            (node, fields) => {
                if (!(node instanceof HTMLButtonElement || node instanceof HTMLInputElement)) return false;
                const form = node.form;
                if (!form || node.type !== "submit") return false;
                if (!(fields.username instanceof HTMLInputElement && fields.password instanceof HTMLInputElement))
                    return false;
                const override = (name: string, fallback: string) => node.getAttribute(name) ?? fallback;
                return (
                    fields.username !== fields.password &&
                    fields.username.form === form &&
                    fields.password.form === form &&
                    ["text", "email", "tel"].includes(fields.username.type) &&
                    fields.password.type === "password" &&
                    ["", "_self"].includes(override("formtarget", form.target)) &&
                    override("formmethod", form.method).toLowerCase() === "post" &&
                    new URL(override("formaction", form.action), document.baseURI).href === fields.target
                );
            },
            { username, password, target },
        );
        if (!matches) throw new Error("SSO_FLOW_INVALID");
        return { username, password, submit, handles };
    } catch (error) {
        await Promise.allSettled(handles.map((handle) => handle.dispose()));
        if (error instanceof Error && authErrors.has(error.message)) throw error;
        throw new Error("SSO_CHALLENGE_REQUIRED");
    }
}

/**
 * 登录凭据只在确认当前身份提供商和原生表单后读取，未核验的跳转或回调不允许进入业务测试。
 */
export async function authenticateBrowserSso(
    context: LifecycleContext,
    identity: FixtureIdentityV1,
    config: BrowserSsoAuthConfigV1,
): Promise<{ identityId: string; dispose: () => Promise<void> }> {
    const { execution, page, signal } = context;
    const environment = execution.environment;
    const browser = page.context();
    const allowed = environment.allowedOrigins;
    const idp = new URL(config.idpOrigin);
    const app = new URL(environment.baseURL).origin;
    const api = new URL(environment.apiBaseURL).origin;
    if (
        idp.protocol !== "https:" ||
        config.idpOrigin !== idp.origin ||
        idp.origin === app ||
        idp.origin === api ||
        ![idp.origin, app, api].every((origin) => allowed.includes(origin)) ||
        !identity.allowedIdentityIds?.length
    )
        throw new Error("SSO_ORIGIN_NOT_ALLOWED");
    const entry = authorizedURL(config.entryPath, app, allowed);
    const target = authorizedURL(config.idpSubmitPath, idp.origin, allowed);
    const identityUrl = authorizedURL(config.identityPath, api, allowed);
    if (identityUrl.hash) throw new Error("SSO_FLOW_INVALID");
    const initialState = await browser.storageState();
    if (
        page.url() !== "about:blank" ||
        browser.pages().length !== 1 ||
        initialState.cookies.length ||
        initialState.origins.length
    )
        throw new Error("SSO_SCOPE_UNAVAILABLE");

    let boundary: Awaited<ReturnType<typeof guardSsoPage>>;
    try {
        boundary = await guardSsoPage(
            page,
            { app, api, idp: idp.origin, submitPath: target.pathname, callbackPath: config.callbackPath },
            context.onSsoOriginDenied ?? (() => {}),
            (value) => context.protect?.(value),
        );
    } catch {
        throw new Error("SSO_SCOPE_UNAVAILABLE");
    }

    let rejectAbort: (error: Error) => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
        rejectAbort = reject;
    });
    const stop = () => {
        boundary.stop();
        rejectAbort(new Error("CANCELLED"));
    };
    // Playwright 导航不能接收认证信号，信号触发时先撤掉网络权限，再由已有生命周期关闭整个上下文。
    signal.addEventListener("abort", stop, { once: true });
    async function login() {
        if (signal.aborted) throw new Error("CANCELLED");
        await page.goto(entry.href, { waitUntil: "domcontentloaded", timeout: 15000 });
        await page.waitForURL((url) => url.origin === idp.origin && url.pathname === config.idpLoginPath, {
            waitUntil: "domcontentloaded",
            timeout: 12000,
        });
        context.onSsoStage?.("IDP");
        const controls = await loginControls(page, config, target.href);
        try {
            const current = new URL(page.url());
            if (current.origin !== idp.origin || current.pathname !== config.idpLoginPath)
                throw new Error("SSO_FLOW_INVALID");
            if (!context.credentials) throw new Error("CREDENTIAL_PROVIDER_REQUIRED");
            boundary.prepareSubmission();
            const secret = await context.credentials.resolve(
                {
                    workspaceId: execution.workspaceId,
                    secretRef: identity.secretRef,
                    versionId: identity.secretVersionId,
                },
                signal,
            );
            context.protect?.(secret);
            if (signal.aborted) throw new Error("CANCELLED");
            if (
                !secret ||
                typeof secret !== "object" ||
                Array.isArray(secret) ||
                typeof secret.username !== "string" ||
                !secret.username ||
                typeof secret.password !== "string" ||
                !secret.password
            )
                throw new Error("CREDENTIAL_SHAPE_INVALID");
            boundary.protectLoginMaterial(secret.username, secret.password);
            await controls.username.fill(secret.username, { timeout: 8000 });
            await controls.password.fill(secret.password, { timeout: 8000 });
            const [submitted] = await Promise.all([
                page.waitForResponse(
                    (response) => response.url() === target.href && response.request().method() === "POST",
                    { timeout: 12000 },
                ),
                controls.submit.click({ timeout: 8000, noWaitAfter: true }),
            ]);
            if (submitted.status() >= 400) throw new Error("SSO_AUTHENTICATION_FAILED");
            if (submitted.status() < 300) throw new Error("SSO_CHALLENGE_REQUIRED");
            context.onSsoStage?.("CALLBACK");
            await page.waitForURL((url) => url.origin === app, { waitUntil: "domcontentloaded", timeout: 15000 });
        } finally {
            await Promise.allSettled(controls.handles.map((handle) => handle.dispose()));
        }
        if (!boundary.observedCallback()) throw new Error("SSO_FLOW_INVALID");
        const handoff = new URL(page.url());
        if (handoff.origin !== app) throw new Error("SSO_FLOW_INVALID");
        context.onSsoStage?.("IDENTITY");
        // 由浏览器导航发送 Cookie 并保持统一证书信任，直接读取已收到的响应正文，避免在受测页面中执行身份读取脚本。
        boundary.prepareIdentity(identityUrl.href);
        const response = await page.goto(identityUrl.href, { waitUntil: "domcontentloaded", timeout: 10000 });
        if (!response?.ok()) throw new Error("SSO_AUTHENTICATION_FAILED");
        const actual = resolvePointer((await response.json()) as JsonValue, config.identityPointer);
        if (!actual.present || typeof actual.value !== "string" || !identity.allowedIdentityIds?.includes(actual.value))
            throw new Error("IDENTITY_NOT_ALLOWED");
        // 回调携带的一次性参数不可重放；若回调本身就是页面，恢复到无需重传该参数的已授权业务入口。
        boundary.authorizeBusiness();
        const restore = handoff.pathname === config.callbackPath ? entry.href : handoff.href;
        const landing = await page.goto(restore, { waitUntil: "domcontentloaded", timeout: 10000 });
        if (!landing?.ok() || new URL(page.url()).origin !== app) throw new Error("SSO_AUTHENTICATION_FAILED");
        context.protect?.((await browser.cookies()).map((cookie) => cookie.value));
        return actual.value;
    }

    try {
        const identityId = await Promise.race([login(), boundary.violation, cancelled]);
        return { identityId, dispose: async () => {} };
    } catch (error) {
        boundary.stop();
        if (signal.aborted) throw new Error("CANCELLED");
        const code =
            error instanceof Error && authErrors.has(error.message) ? error.message : "SSO_AUTHENTICATION_FAILED";
        throw new Error(code);
    } finally {
        signal.removeEventListener("abort", stop);
    }
}
