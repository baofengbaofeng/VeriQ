/**
 * 浏览器在发出请求之前先检查目标与当前登录阶段，重定向子请求单独鉴权，禁止把密码表单重放到业务站。
 * Playwright Context 路由补齐单页面 DevTools 会话不覆盖的子框架、弹窗和 WebSocket。
 */
import type { Page } from "@playwright/test";
import { applySsoDocumentPolicy, hasExactPolicyOrigin, type SsoDocumentResponse } from "./sso-response-policy.js";

/**
 * 所有地址来自调用者已检查的冻结环境与认证配置，服务端可授权的站点不会因为请求中的重定向而新增。
 */
export interface SsoNetworkScope {
    app: string;
    api: string;
    idp: string;
    submitPath: string;
    callbackPath: string;
}

interface PausedRequest extends SsoDocumentResponse {
    request: { url: string; method: string };
    redirectedRequestId?: string;
    frameId: string;
    resourceType: string;
}

/**
 * 公开安装接口只允许所选页面的网络途径保持活动，处理器保留至 Context 关闭，调用者不能提前卸除保护。
 */
export async function guardSsoPage(
    page: Page,
    scope: SsoNetworkScope,
    onViolation: () => void,
    protect: (value: string) => void,
) {
    const context = page.context();
    // 该原生响应策略仅在锁定的 Chromium 158 系列验收，未被验证的版本不得静默继续执行。
    if (!/^158\.\d+\.\d+\.\d+$/u.test(context.browser()?.version() ?? "")) throw new Error("SSO_SCOPE_UNAVAILABLE");
    if (![scope.app, scope.api, scope.idp].every(hasExactPolicyOrigin)) throw new Error("SSO_SCOPE_UNAVAILABLE");
    const session = await context.newCDPSession(page);
    const tree = (await session.send("Page.getFrameTree")) as { frameTree: { frame: { id: string } } };
    const mainFrameId = tree.frameTree.frame.id;
    const appOrigins = new Set([scope.app, scope.api]);
    const authOrigins = new Set([scope.idp, ...appOrigins]);
    const loginChain = new Set<string>();
    let submitting = false;
    let callback = false;
    let returned = false;
    let business = false;
    let failed = false;
    let documentRedirects = 0;
    let identityTarget: string | undefined;
    let identitySent = false;
    const loginValues = new Set<string>();
    const embeddedLoginValues = new Set<string>();
    let rejectViolation: (error: Error) => void = () => {};
    const violation = new Promise<never>((_, reject) => {
        rejectViolation = reject;
    });
    // 登录完成后仍可收到违反范围的请求；整案通过 onViolation 观察，拒绝 Promise 不作为未处理异常传播。
    void violation.catch(() => {});

    function markViolation() {
        if (failed) return;
        failed = true;
        rejectViolation(new Error("SSO_ORIGIN_NOT_ALLOWED"));
        onViolation();
    }

    /**
     * URL 只检查明确保存的登录字段及常见编码；短值要求整段匹配，避免误拦正常回调参数中的偶然字符。
     */
    function carriesLoginMaterial(url: URL): boolean {
        if (!loginValues.size) return false;
        const components = url.pathname.split("/").map(decodeURIComponent);
        for (const [name, value] of url.searchParams) components.push(name, value);
        return components.some(
            (part) => loginValues.has(part) || [...embeddedLoginValues].some((value) => part.includes(value)),
        );
    }

    /**
     * 真正的密码提交只有一次机会进入导航链，网络暂停事件里的父请求标识用来区分回跳与站点另发的请求。
     */
    function authorized(event: PausedRequest): boolean {
        const url = new URL(event.request.url);
        if (failed || !["http:", "https:"].includes(url.protocol) || url.username || url.password) return false;
        if (carriesLoginMaterial(url)) return false;
        if (event.resourceType === "Document" && event.frameId !== mainFrameId) return false;
        if (business) return appOrigins.has(url.origin);
        if (!authOrigins.has(url.origin)) return false;
        const document = event.resourceType === "Document";
        if (document && event.redirectedRequestId && ++documentRedirects > 16) return false;
        const method = event.request.method;
        if (identityTarget) {
            if (!appOrigins.has(url.origin) || (method !== "GET" && method !== "HEAD")) return false;
            if (!document) return true;
            if (identitySent || event.redirectedRequestId || method !== "GET" || url.href !== identityTarget)
                return false;
            identitySent = true;
            return true;
        }
        const redirectedLogin = event.redirectedRequestId && loginChain.has(event.redirectedRequestId);
        if (method === "POST") {
            if (
                !submitting ||
                !loginValues.size ||
                !document ||
                url.origin !== scope.idp ||
                url.pathname !== scope.submitPath ||
                url.search ||
                event.redirectedRequestId ||
                loginChain.size
            )
                return false;
            loginChain.add(event.requestId);
            return true;
        }
        if (method !== "GET" && method !== "HEAD") return false;
        if (document && url.origin === scope.idp) url.searchParams.forEach(protect);
        if (!submitting) return true;
        if (returned) return appOrigins.has(url.origin);
        if (url.origin === scope.idp && !callback) {
            // 填写阶段的身份站读请求必须是已批准提交的主文档跳转，脚本发起的并发请求没有这条链。
            if (!document || !redirectedLogin) return false;
            loginChain.add(event.requestId);
            return true;
        }
        // 回调放行并不代表旧登录页已卸载；只放行该表单的导航链，其他业务请求等到主文档实际换成业务站页面。
        if (!document || !redirectedLogin || url.origin !== scope.app || method !== "GET") return false;
        if (!callback && url.pathname !== scope.callbackPath) return false;
        callback = true;
        loginChain.add(event.requestId);
        url.searchParams.forEach(protect);
        return true;
    }

    /**
     * 命令失败也要让认证停止；同步路径不保留网络事件中的网址、认证请求体或原始浏览器错误文本。
     */
    session.on("Fetch.requestPaused", (event: PausedRequest) => {
        void (async () => {
            if (event.responseStatusCode !== undefined || event.responseErrorReason !== undefined) {
                const target = new URL(event.request.url);
                if (failed || event.resourceType !== "Document" || event.frameId !== mainFrameId)
                    throw new Error("SSO_ORIGIN_NOT_ALLOWED");
                await applySsoDocumentPolicy(session, event, appOrigins, target.origin === scope.idp, () => failed);
                return;
            }
            // 只在确认目标和方法都属于当前阶段后放行请求，拒绝路径在 Chromium 的命令确认后推进失败信号。
            if (authorized(event)) {
                await session.send("Fetch.continueRequest", {
                    requestId: event.requestId,
                    interceptResponse: event.resourceType === "Document",
                });
                return;
            }
            await session.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" });
            markViolation();
        })().catch(async () => {
            markViolation();
            // 文档已经关闭或响应结束时取消命令可能失败，违例仍留在当前尝试并阻断其余请求。
            await session
                .send("Fetch.failRequest", {
                    requestId: event.requestId,
                    errorReason: "BlockedByClient",
                })
                .catch(() => {});
        });
    });

    // Context 路由用于排除其它页面或无法归属的 HTTP 请求；CDP 在主页面逐跳验证而不依赖首次路由回调。
    await context.route("**/*", async (route) => {
        let main = false;
        try {
            main = route.request().frame() === page.mainFrame();
        } catch {
            // 尚无页面归属的首次弹窗请求和无 frame 的请求必须拒绝，不能根据来源字符串推测同一上下文。
        }
        if (!failed && main) return route.continue();
        await route.abort("blockedbyclient");
        markViolation();
    });
    await context.routeWebSocket("**/*", async (route) => {
        // 禁止建立远端 WebSocket，只关闭页面一侧的连接，从而避免不经过普通 HTTP 路由的消息离开浏览器。
        await route.close({ code: 1008, reason: "Blocked by SSO network policy" });
        markViolation();
    });
    // 即使弹窗或内嵌框架还未发出 HTTP 请求，也在观察到新目标时停止该尝试并禁止继续出站。
    context.on("page", markViolation);
    page.on("frameattached", markViolation);
    session.on("Page.frameNavigated", ({ frame }: { frame: { id: string; url: string } }) => {
        if (callback && frame.id === mainFrameId && URL.canParse(frame.url) && new URL(frame.url).origin === scope.app)
            returned = true;
    });
    await session.send("Page.enable");
    await session.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
    return {
        violation,
        /**
         * 开始填写前收紧可访问目标，在真实回跳前暂停业务方向的请求，登录字段只出现在既定身份站点。
         */
        prepareSubmission() {
            submitting = true;
        },
        /**
         * 从给定字段派生有限的匹配集合，仅在认证阶段使用，任何原值或匹配结果都不进入报告或错误文本。
         */
        protectLoginMaterial(username: string, password: string) {
            for (const value of [username, password]) {
                const bytes = Buffer.from(value);
                for (const variant of [
                    value,
                    encodeURIComponent(value),
                    bytes.toString("base64"),
                    bytes.toString("base64url"),
                ]) {
                    loginValues.add(variant);
                    if (value.length >= 8) embeddedLoginValues.add(variant);
                }
            }
        },
        /**
         * 观察已提交的原生导航链进入配置里的业务回调，仅凭页面重载或匹配路由不能证明身份已建立。
         */
        observedCallback() {
            return returned;
        },
        /**
         * 同一浏览器的单次身份导航沿用 Chromium 的证书信任与 Cookie，固定地址的任何重定向均在发出前拒绝。
         */
        prepareIdentity(target: string) {
            identityTarget = target;
        },
        /**
         * 身份成功后停用身份站点的出站权限，业务请求继续由同一边界检查但不再受登录方法限制。
         */
        authorizeBusiness() {
            business = true;
            loginValues.clear();
            embeddedLoginValues.clear();
        },
        /**
         * 认证失败或取消后立即关闭网络授权，直至调用方依现有租约与 Context 收尾流程关停浏览器。
         */
        stop() {
            failed = true;
            loginValues.clear();
            embeddedLoginValues.clear();
        },
    };
}
