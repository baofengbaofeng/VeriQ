/**
 * 本模块提供 Cookie/CSRF 会话下的 /api/v1 传输层，供各功能适配器复用同一凭证边界。写入请求必须同源且不落盘密钥。
 * 401 时广播 veriq:session-expired；非 GET 写入自动附带 X-CSRF-Token。
 */

import type { PlatformComponents, PlatformPaths } from "@veriq/contracts";
type Schemas = PlatformComponents["schemas"];
/**
 * 账户与导航使用的 AdminUserDTO 投影，含 systemAdmin 以决定管理入口是否可见。密码哈希永不出现在此类型。
 * 来自 /account 或管理端用户列表，不包含会话令牌或密码哈希。
 */
export type User = Schemas["AdminUserDTO"];
/**
 * 登录成功后返回的 SessionDTO，仅表示服务端已建立 Cookie 会话，不含 Workspace 列表。与 account() 结果分离。
 * 前端用 session() 探活；真正资料展示依赖 account() 拉取的 User。
 */
export type Session = Schemas["SessionDTO"];
/**
 * 当前账户活跃会话分页信封，供账户页列出并批量吊销本机以外的会话。nextCursor 为空即无更多页；nextCursor 为空时账户页停止继续追加会话行。
 * 查询参数遵循 SessionListQuery；吊销调用 revokeOwn 而非逐条删除。
 */
export type AccountSessions = Schemas["AccountSessionsDTO"];
/**
 * 管理员签发的一次性重置链接 DTO，短时有效且仅在 AdminUsers 页展示给操作者。复制后即视为已暴露给管理员；链接只短暂展示且禁止写入 localStorage。
 * 前端不得把链接写入日志或持久化到 localStorage。
 */
export type ResetLink = Schemas["ResetLinkDTO"];
/**
 * 系统管理员用户列表的游标与过滤查询形状，绑定 GET /admin/users 的 OpenAPI 参数。email 过滤为前缀匹配语义。
 * limit/cursor 变更会触发 AdminUsers 重新拉取，避免跨页状态串扰。
 */
export type UserListQuery = NonNullable<
    PlatformPaths["/api/v1/admin/users"]["get"]["parameters"]["query"]
>;
/**
 * 账户会话列表查询形状，绑定 GET /account/sessions，支持 limit 与 cursor 分页。与管理端用户会话列表形状不同。
 * Account 页用其控制每页条数并在 Load more 时追加 items。
 */
export type SessionListQuery = NonNullable<
    PlatformPaths["/api/v1/account/sessions"]["get"]["parameters"]["query"]
>;
function queryString(options: Record<string, string | number | boolean | undefined>): string {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options))
        if (value !== undefined) query.set(key, String(value));
    return query.size ? "?" + query.toString() : "";
}
let csrfToken = "";
/** 桌面宿主适配器只替换业务传输而不改变页面的数据契约，Web 默认继续使用同源 Cookie；注入者负责把路径转换为有限操作标识，真正权限仍由宿主独立验证。 */
export interface HostTransport {
    /** 共享页面把相对业务路径、方法和正文交给宿主兼容层映射，不能自行选择认证来源或浏览器 Cookie；信号用于丢弃已取消视图的结果，最终主机仍独立校验有限操作和工作区参数。 */
    json(
        path: string,
        method: string,
        data?: unknown,
        signal?: AbortSignal,
        headers?: Record<string, string>,
    ): Promise<unknown>;
    /** 报告流以标准 Response 供现有 SSE 解析器消费，但底层数据来自宿主逐块拉取的有限句柄；取消信号必须释放该句柄，不能把页面取消只实现为忽略后续事件。 */
    stream(path: string, data: unknown, signal: AbortSignal): Promise<Response>;
    /** 二进制兼容入口只用于宿主明确开放的生成源码，Response 不意味着页面获得通用下载权限；签名包安装和原始证据使用各自原生入口，不能通过此方法绕过授权确认。 */
    binary(path: string, signal?: AbortSignal): Promise<Response>;
}
let hostTransport: HostTransport | undefined;
/** 共享视图的宿主传输只允许初始化一次，桌面构建入口在挂载 React 之前安装适配器；普通 Web 入口不会调用此函数，因此现有同源会话和 CSRF 处理保持不变。 */
export function installHostTransport(transport: HostTransport): void {
    if (hostTransport) throw new Error("HOST_TRANSPORT_ALREADY_INSTALLED");
    hostTransport = transport;
}
/** 二进制读取沿用服务端当前权限检查和禁止重定向约束，桌面宿主可仅开放生成源码读取；原始证据和签名包的 native 保存入口可以保持字节不进入渲染进程。 */
export function binaryRequest(path: string, signal?: AbortSignal): Promise<Response> {
    return hostTransport
        ? hostTransport.binary(path, signal)
        : fetch("/api/v1" + path, { credentials: "same-origin", signal, redirect: "error" });
}

/**
 * 将非 2xx JSON 体映射为带 code/status/requestId 的错误，供 Notice 与适配器统一展示。
 * 401 已由 request 触发会话过期事件；调用方只消费可读 message。
 */
export class ApiError extends Error {
    constructor(
        public code: string,
        message: string,
        public status: number,
        public requestId: string,
    ) {
        super(message);
    }
}
/**
 * 通用 JSON 请求：same-origin Cookie、可选 AbortSignal，成功时刷新内存中的 csrfToken。
 * 路径相对 /api/v1；业务适配器应传入已含 workspaceId 的路径，勿在此层拼接作用域。
 */
export async function request<T>(
    path: string,
    method = "GET",
    data?: unknown,
    signal?: AbortSignal,
    headers?: Record<string, string>,
): Promise<T> {
    if (hostTransport) return (await hostTransport.json(path, method, data, signal, headers)) as T;
    const response = await fetch("/api/v1" + path, {
        method,
        credentials: "same-origin",
        signal,
        headers: {
            ...headers,
            "Content-Type": "application/json",
            ...(method !== "GET" ? { "X-CSRF-Token": csrfToken } : {}),
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const body = await response.json();
    if (response.status === 401) window.dispatchEvent(new Event("veriq:session-expired"));
    if (!response.ok) throw new ApiError(body.code, body.message, response.status, body.requestId);
    if (body.data?.csrfToken) csrfToken = body.data.csrfToken;
    return body.data as T;
}
/**
 * 认证、账户、Workspace 成员与邀请的门面对象，所有方法最终走 request 并保持 CSRF。邀请接受走 /auth 而非空间嵌套路径。
 * Workspace 相关写操作均要求显式 workspaceId，不依赖隐式全局选择。
 */
export const api = {
    setup: () => request<Schemas["SetupDTO"]>("/setup"),
    initialize: (data: Schemas["SetupRequest"]) =>
        request<Schemas["UserDTO"]>("/setup", "POST", data),
    login: (data: Schemas["LoginRequest"]) => request<Session>("/auth/login", "POST", data),
    session: () => request<Session>("/auth/session"),
    logout: () => request<Schemas["Empty"]>("/auth/logout", "POST", {}),
    account: () => request<User>("/account"),
    sessions: (options: SessionListQuery = {}) =>
        request<AccountSessions>("/account/sessions" + queryString({ ...options })),
    revokeOwn: () => request<Schemas["Empty"]>("/account/sessions/revoke", "POST", {}),
    password: (data: Schemas["ChangePasswordRequest"]) =>
        request<Schemas["Empty"]>("/account/password", "POST", data),
    resetRequest: (email: string) =>
        request<Schemas["Empty"]>("/auth/password-reset", "POST", { email }),
    resetConfirm: (data: Schemas["ResetPasswordRequest"]) =>
        request<Schemas["Empty"]>("/auth/password-reset/confirm", "POST", data),
    users: (options: UserListQuery = {}) =>
        request<Schemas["AdminUsersDTO"]>("/admin/users" + queryString({ ...options })),
    createUser: (data: Schemas["CreateUserRequest"]) => request<User>("/admin/users", "POST", data),
    updateUser: (id: string, data: Schemas["UpdateUserRequest"]) =>
        request<User>(`/admin/users/${id}`, "PATCH", data),
    resetLink: (id: string) => request<ResetLink>(`/admin/users/${id}/reset-link`, "POST", {}),
    revokeUser: (id: string) =>
        request<Schemas["Empty"]>(`/admin/users/${id}/sessions/revoke`, "POST", {}),
    workspaces: (cursor?: string, signal?: AbortSignal) =>
        request<Schemas["WorkspaceDTOPageEnvelope"]["data"]>(
            "/workspaces" + queryString({ cursor }),
            "GET",
            undefined,
            signal,
        ),
    workspace: (id: string, signal?: AbortSignal) =>
        request<Schemas["WorkspaceDTO"]>(`/workspaces/${id}`, "GET", undefined, signal),
    createWorkspace: (data: Schemas["WorkspaceWrite"], signal?: AbortSignal) =>
        request<Schemas["WorkspaceDTO"]>("/workspaces", "POST", data, signal),
    renameWorkspace: (id: string, name: string, signal?: AbortSignal) =>
        request<Schemas["WorkspaceDTO"]>(`/workspaces/${id}`, "PATCH", { name }, signal),
    archiveWorkspace: (id: string, signal?: AbortSignal) =>
        request<Schemas["Empty"]>(`/workspaces/${id}`, "DELETE", undefined, signal),
    members: (id: string, cursor?: string, signal?: AbortSignal) =>
        request<Schemas["MemberDTOPageEnvelope"]["data"]>(
            `/workspaces/${id}/members` + queryString({ cursor }),
            "GET",
            undefined,
            signal,
        ),
    updateMember: (ws: string, id: string, data: Schemas["MemberWrite"], signal?: AbortSignal) =>
        request<Schemas["MemberDTO"]>(`/workspaces/${ws}/members/${id}`, "PUT", data, signal),
    removeMember: (ws: string, id: string, signal?: AbortSignal) =>
        request<Schemas["Empty"]>(`/workspaces/${ws}/members/${id}`, "DELETE", undefined, signal),
    invitations: (id: string, cursor?: string, signal?: AbortSignal) =>
        request<Schemas["InvitationSummaryDTOPageEnvelope"]["data"]>(
            `/workspaces/${id}/invitations` + queryString({ cursor }),
            "GET",
            undefined,
            signal,
        ),
    invite: (id: string, data: Schemas["InviteRequest"], signal?: AbortSignal) =>
        request<Schemas["InviteDTO"]>(`/workspaces/${id}/invitations`, "POST", data, signal),
    revokeInvitation: (ws: string, id: string, signal?: AbortSignal) =>
        request<Schemas["Empty"]>(
            `/workspaces/${ws}/invitations/${id}`,
            "DELETE",
            undefined,
            signal,
        ),
    acceptInvitation: (data: Schemas["InvitationAcceptRequest"]) =>
        request<Schemas["UserDTO"]>("/auth/invitations/accept", "POST", data),
};
/**
 * WorkspaceDTO 别名，描述空间元数据与当前用户在该空间的角色摘要。归档空间仍可只读查询历史；归档之后仍允许只读查询该空间历史记录。
 * 选择状态由 WorkspaceProvider 持有，本类型本身不含 AbortSignal。
 */
export type Workspace = Schemas["WorkspaceDTO"];
/**
 * MemberDTO 别名，表示某 Workspace 内成员角色；更新走 PUT /workspaces/{ws}/members/{id}。
 * 移除成员不会级联删除资源，仅切断该用户对该空间的访问。
 */
export type Member = Schemas["MemberDTO"];

/**
 * RuntimeDTO 别名，登记设备、信任状态、授权矩阵与凭证投递开关。心跳与租约语义由服务端解释；心跳与租约是否过期一律交由服务端判定。
 * 所有变更必须带 workspaceId；吊销后不可再领取作业。
 */
export type Runtime = Schemas["RuntimeDTO"];
/**
 * Workspace 作用域内 Runtime 登记、授权、信任与服务账号令牌发放的专用 API 集合。服务账号令牌仅用于登记，不替代用户会话。
 * enrollment inspect/approve 跨空间，但 grant/trust/revoke 始终绑定 workspace 路径。
 */
export const runtimeApi = {
    delivery: (ws: string, id: string, allowCredentialDelivery: boolean, signal?: AbortSignal) =>
        request<Runtime>(
            `/workspaces/${ws}/runtimes/${id}/credential-delivery`,
            "PUT",
            { allowCredentialDelivery },
            signal,
        ),
    list: (ws: string, cursor?: string, signal?: AbortSignal) =>
        request<Schemas["RuntimeDTOPageEnvelope"]["data"]>(
            `/workspaces/${ws}/runtimes` + queryString({ cursor }),
            "GET",
            undefined,
            signal,
        ),
    inspect: (userCode: string, signal?: AbortSignal) =>
        request<Schemas["EnrollmentPreview"]>(
            "/runtime-enrollments/inspect",
            "POST",
            { userCode },
            signal,
        ),
    approve: (id: string, data: Schemas["EnrollmentApprove"], signal?: AbortSignal) =>
        request<Runtime>(`/runtime-enrollments/${id}/approve`, "POST", data, signal),
    grants: (ws: string, id: string, data: Schemas["RuntimeGrantWrite"], signal?: AbortSignal) =>
        request<Runtime>(`/workspaces/${ws}/runtimes/${id}/grants`, "PUT", data, signal),
    trust: (ws: string, id: string, data: Schemas["RuntimeTrustWrite"], signal?: AbortSignal) =>
        request<Runtime>(`/workspaces/${ws}/runtimes/${id}/trust`, "PUT", data, signal),
    revoke: (ws: string, id: string, signal?: AbortSignal) =>
        request<Runtime>(`/workspaces/${ws}/runtimes/${id}/revoke`, "POST", {}, signal),
    accounts: (ws: string, cursor?: string, signal?: AbortSignal) =>
        request<Schemas["ServiceAccountDTOPageEnvelope"]["data"]>(
            `/workspaces/${ws}/service-accounts` + queryString({ cursor }),
            "GET",
            undefined,
            signal,
        ),
    createAccount: (ws: string, name: string, signal?: AbortSignal) =>
        request<Schemas["ServiceAccountDTO"]>(
            `/workspaces/${ws}/service-accounts`,
            "POST",
            { name },
            signal,
        ),
    issueToken: (ws: string, id: string, signal?: AbortSignal) =>
        request<Schemas["ServiceTokenDTO"]>(
            `/workspaces/${ws}/service-accounts/${id}/tokens`,
            "POST",
            { purpose: "RUNTIME_ENROLLMENT" },
            signal,
        ),
    disableAccount: (ws: string, id: string, signal?: AbortSignal) =>
        request<Schemas["ServiceAccountDTO"]>(
            `/workspaces/${ws}/service-accounts/${id}/disable`,
            "POST",
            {},
            signal,
        ),
};

/**
 * POST 流式传输：附带 CSRF，返回原始 Response 供 SSE 解析，失败时同样抛出 ApiError。调用方负责取消 reader 与释放锁。
 * CloudReportAdapter.subscribe 用其拉取 runs/.../events/stream，禁止缓冲整包到内存。
 */
export async function streamRequest(path: string, data: unknown, signal: AbortSignal) {
    if (hostTransport) return hostTransport.stream(path, data, signal);
    const response = await fetch("/api/v1" + path, {
        method: "POST",
        credentials: "same-origin",
        signal,
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify(data),
    });
    if (!response.ok) {
        const body = await response.json();
        if (response.status === 401) window.dispatchEvent(new Event("veriq:session-expired"));
        throw new ApiError(body.code, body.message, response.status, body.requestId);
    }
    return response;
}
