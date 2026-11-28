/**
 * 浏览器在发出请求之前先检查目标与当前登录阶段，重定向子请求单独鉴权，禁止把密码表单重放到业务站。
 * Playwright Context 路由补齐单页面 DevTools 会话不覆盖的子框架、弹窗和 WebSocket。
 */
import { createHmac, randomBytes } from "node:crypto";
import type { Page } from "@playwright/test";
import { SsoLineage, type Admission, type Owner } from "./sso-lineage.js";
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
    networkId?: string;
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
    let loginParent: string | undefined;
    let submitting = false;
    let callback = false;
    let business = false;
    let failed = false;
    let denying = false;
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

    if (!mainFrameId || mainFrameId.length > 256) throw new Error("SSO_SCOPE_UNAVAILABLE");
    const lineage = new SsoLineage(decide, markViolation);
    const responseKey = randomBytes(32);
    const awaitingResponse = new Map<string, { tag: string; businessNetwork?: string }>();
    const pendingRejections = new Set<string>();
    const activeResponses = new Map<string, { rejected: boolean }>();

    function responseTag(event: PausedRequest): string | undefined {
        if (!event.networkId || event.networkId.length > 256) return;
        return createHmac("sha256", responseKey)
            .update(JSON.stringify([event.networkId, event.request.method, event.request.url]))
            .digest("hex");
    }

    function onTerminal({ requestId, timestamp }: { requestId: string; timestamp?: number }) {
        lineage.terminal(requestId, timestamp);
    }

    function onLoadingFailed(event: {
        requestId: string;
        timestamp: number;
        type: string;
        canceled?: boolean;
        errorText: string;
    }) {
        onTerminal(event);
        if (failed || denying || !event.canceled || event.type !== "Document" || event.errorText !== "net::ERR_ABORTED")
            return;
        if (business) {
            const matches = [...awaitingResponse].filter(([, ticket]) => ticket.businessNetwork === event.requestId);
            if (matches.length > 1) return markViolation();
            const match = matches[0];
            if (match && awaitingResponse.get(match[0]) === match[1]) awaitingResponse.delete(match[0]);
            return;
        }
        if (!identityTarget) return;
        const id = lineage.canceledHandoff(event.requestId, event.timestamp);
        if (id && awaitingResponse.delete(id)) lineage.response(id, false);
    }

    function releaseLineage(preserveInFlight = false) {
        session.off("Network.requestWillBeSent", onNetwork);
        session.off("Page.frameNavigated", onFrame);
        session.off("Network.loadingFinished", onTerminal);
        if (!preserveInFlight) session.off("Network.loadingFailed", onLoadingFailed);
        loginParent = undefined;
        return lineage.close(preserveInFlight);
    }

    function markViolation() {
        if (failed) return;
        failed = true;
        awaitingResponse.clear();
        releaseLineage();
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
    function authorized(event: PausedRequest): Admission | boolean {
        const url = new URL(event.request.url);
        if (failed || denying || !["http:", "https:"].includes(url.protocol) || url.username || url.password)
            return false;
        if (carriesLoginMaterial(url)) return false;
        if (event.resourceType === "Document" && event.frameId !== mainFrameId) return false;
        if (business) return appOrigins.has(url.origin);
        if (!authOrigins.has(url.origin)) return false;
        const document = event.resourceType === "Document";
        if (document && event.redirectedRequestId && ++documentRedirects > 16) return false;
        const method = event.request.method;
        if (identityTarget) {
            if (!appOrigins.has(url.origin) || (method !== "GET" && method !== "HEAD")) return false;
            if (!document) return "resource";
            if (identitySent || event.redirectedRequestId || method !== "GET" || url.href !== identityTarget)
                return false;
            identitySent = true;
            return "identity";
        }
        const redirectedLogin = event.redirectedRequestId && event.redirectedRequestId === loginParent;
        if (method === "POST") {
            if (
                !submitting ||
                !loginValues.size ||
                !document ||
                url.origin !== scope.idp ||
                url.pathname !== scope.submitPath ||
                url.search ||
                event.redirectedRequestId ||
                loginParent
            )
                return false;
            loginParent = event.requestId;
            return "chain";
        }
        if (method !== "GET" && method !== "HEAD") return false;
        if (document && url.origin === scope.idp) url.searchParams.forEach(protect);
        if (!submitting) return "initial";
        if (lineage.confirmed("landing") && document) return appOrigins.has(url.origin) && "handoff";
        if (!document && appOrigins.has(url.origin)) return "resource";
        if (url.origin === scope.idp && !callback) {
            // 填写阶段的身份站读请求必须是已批准提交的主文档跳转，脚本发起的并发请求没有这条链。
            if (!document || !redirectedLogin) return false;
            loginParent = event.requestId;
            return "chain";
        }
        // 回调放行并不代表旧登录页已卸载；只放行该表单的导航链，其他业务请求等到主文档实际换成业务站页面。
        if (!document || !redirectedLogin || url.origin !== scope.app || method !== "GET") return false;
        if (!callback && url.pathname !== scope.callbackPath) return false;
        callback = true;
        loginParent = event.requestId;
        url.searchParams.forEach(protect);
        return "landing";
    }

    function owner(origin: string): Owner {
        if (origin === scope.app) return "APP";
        if (origin === scope.api) return "API";
        if (origin === scope.idp) return "IDP";
        return "OTHER";
    }

    function decide(
        id: string,
        allowed: boolean,
        document: boolean,
        admission?: Admission,
        tag?: string,
        acknowledged?: () => void,
        businessNetwork?: string,
    ) {
        if (allowed && document) {
            const count = awaitingResponse.size + activeResponses.size;
            if (!tag || count >= 8 || awaitingResponse.has(id) || activeResponses.has(id)) allowed = false;
            else awaitingResponse.set(id, { tag, ...(businessNetwork ? { businessNetwork } : {}) });
        }
        if (allowed && !failed && !denying && !(submitting && admission === "initial")) {
            void session
                .send("Fetch.continueRequest", { requestId: id, interceptResponse: document })
                .then(acknowledged, () => {
                    acknowledged?.();
                    markViolation();
                });
        } else {
            if (pendingRejections.has(id)) return;
            const first = !denying;
            denying = true;
            const active = activeResponses.get(id);
            if (active?.rejected) return;
            if (active) active.rejected = true;
            if (!id || id.length > 256 || pendingRejections.size >= 118) return markViolation();
            pendingRejections.add(id);
            if (first) {
                awaitingResponse.clear();
                releaseLineage();
            }
            const settled = () => {
                pendingRejections.delete(id);
                markViolation();
            };
            void session
                .send("Fetch.failRequest", { requestId: id, errorReason: "BlockedByClient" })
                .then(settled, settled);
        }
    }

    function onNetwork(event: {
        requestId: string;
        loaderId: string;
        timestamp?: number;
        frameId?: string;
        type?: string;
        documentURL: string;
        request: { url: string; method: string };
        redirectResponse?: unknown;
    }) {
        if (business || failed || denying) return;
        try {
            const url = new URL(event.request.url);
            if (!["http:", "https:"].includes(url.protocol)) return;
            if (event.frameId !== mainFrameId || !event.type || !["GET", "HEAD", "POST"].includes(event.request.method))
                return markViolation();
            lineage.network(event.requestId, {
                loader: event.loaderId,
                ...(event.timestamp === undefined ? {} : { time: event.timestamp }),
                type: event.type,
                method: event.request.method,
                target: owner(url.origin),
                owner: owner(new URL(event.documentURL).origin),
                redirected: event.redirectResponse !== undefined,
            });
        } catch {
            markViolation();
        }
    }

    function onFrame({ frame }: { frame: { id: string; url: string; loaderId: string } }) {
        if (frame.id === mainFrameId && URL.canParse(frame.url))
            lineage.frame(frame.loaderId, owner(new URL(frame.url).origin));
    }

    /**
     * 在当前暂停事件返回前完成敏感地址检查。稍后配对或等待文档履约时只持有协议标识和分类，响应正文始终由原有策略处理。
     */
    session.on("Fetch.requestPaused", (event: PausedRequest) => {
        const id = event.requestId;
        try {
            const document = event.resourceType === "Document";
            const target = new URL(event.request.url);
            if (event.responseStatusCode !== undefined || event.responseErrorReason !== undefined) {
                const expected = awaitingResponse.get(id);
                awaitingResponse.delete(id);
                if (
                    failed ||
                    denying ||
                    !document ||
                    event.frameId !== mainFrameId ||
                    !expected ||
                    expected.tag !== responseTag(event)
                )
                    return decide(id, false, document);
                const ticket = { rejected: false };
                activeResponses.set(id, ticket);
                const status = event.responseStatusCode ?? 0;
                const successfulDocument =
                    !event.responseErrorReason && status >= 200 && status < 300 && status !== 204 && status !== 205;
                if (!successfulDocument) lineage.response(id, false);
                void applySsoDocumentPolicy(
                    session,
                    event,
                    appOrigins,
                    target.origin === scope.idp,
                    () => failed || denying,
                )
                    .then(() => {
                        if (activeResponses.get(id) !== ticket) return;
                        activeResponses.delete(id);
                        if (successfulDocument && !failed && !denying) lineage.response(id, true);
                    })
                    .catch(() => {
                        markViolation();
                        decide(id, false, document);
                    })
                    .finally(() => {
                        if (activeResponses.get(id) === ticket) activeResponses.delete(id);
                    });
                return;
            }
            if (lineage.isContinuing(id)) return markViolation();
            if (!id || id.length > 256) return decide(id, false, document);
            const admission = authorized(event);
            const tag = document ? responseTag(event) : undefined;
            if (typeof admission === "boolean")
                return decide(
                    id,
                    admission,
                    document,
                    undefined,
                    tag,
                    undefined,
                    business ? event.networkId : undefined,
                );
            if (event.frameId !== mainFrameId || !event.networkId) return decide(id, false, document);
            lineage.paused(event.networkId, {
                id,
                admission,
                ...(tag ? { responseTag: tag } : {}),
                ...(event.redirectedRequestId === undefined ? {} : { parent: event.redirectedRequestId }),
                type: event.resourceType,
                method: event.request.method,
                target: owner(target.origin),
                redirected: event.redirectedRequestId !== undefined,
            });
        } catch {
            decide(id, false, event.resourceType === "Document");
        }
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
    session.on("Page.frameNavigated", onFrame);
    session.on("Network.requestWillBeSent", onNetwork);
    session.on("Network.loadingFinished", onTerminal);
    session.on("Network.loadingFailed", onLoadingFailed);
    await session.send("Network.enable");
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
        observedDocument(kind: "landing" | "identity") {
            return lineage.committed(kind);
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
            if (
                failed ||
                denying ||
                awaitingResponse.size ||
                activeResponses.size ||
                !lineage.confirmed("identity") ||
                !releaseLineage(true)
            ) {
                markViolation();
                throw new Error("SSO_ORIGIN_NOT_ALLOWED");
            }
            business = true;
            loginValues.clear();
            embeddedLoginValues.clear();
        },
        /**
         * 认证失败或取消后立即关闭网络授权，直至调用方依现有租约与 Context 收尾流程关停浏览器。
         */
        stop() {
            failed = true;
            awaitingResponse.clear();
            releaseLineage();
            loginValues.clear();
            embeddedLoginValues.clear();
        },
    };
}
