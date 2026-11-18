/**
 * 此辅助函数只恢复认证回归自己创建的原管理员，调用方必须先结束所拥有的屏障；正常 GUI 流程不通过此入口操作账户。
 * 恢复借用测试已创建的备用管理员和独立 Cookie 容器，不创建特权主体，不共享或覆盖被测页面的当前登录会话。
 */
import { Client, type Dispatcher } from "undici";
import { CookieJar } from "tough-cookie";
import { withCleanup } from "./case-profile-cleanup";

/**
 * 恢复参数来自固定测试前置条件和本测试创建账号的标识，目标初始权限已知为 true，不接受现场读取的角色作为预期真值。
 * 密码仅在独立登录请求正文中使用，不写入诊断；origin 与身份均由拥有该测试的调用方显式提供。
 */
export interface TestAdminRecovery {
    origin: string;
    targetId: string;
    targetEmail: string;
    backupEmail: string;
    backupPassword: string;
}

/**
 * 每次请求只由绑定单一源的客户端发送固定路径，不安装跳转或重试拦截器；总超时覆盖响应正文而非仅等待响应头。
 * Cookie 交给成熟内存容器处理，HTTP 状态先于正文核验，底层解析与网络错误不会带着认证内容进入报告。
 */
async function responseData(
    client: Client,
    jar: CookieJar,
    origin: string,
    path: string,
    method: "GET" | "POST" | "PATCH",
    phase: string,
    csrf?: string,
    data?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
    let response: Dispatcher.ResponseData;
    try {
        response = await client.request({
            path,
            method,
            idempotent: false,
            headers: {
                Cookie: jar.getCookieStringSync(origin + path),
                ...(csrf ? { Origin: origin, "X-CSRF-Token": csrf } : {}),
                ...(data ? { "Content-Type": "application/json" } : {}),
            },
            body: data ? JSON.stringify(data) : undefined,
            signal: AbortSignal.timeout(5_000),
            headersTimeout: 5_000,
            bodyTimeout: 5_000,
        });
    } catch {
        throw new Error(`Test admin recovery ${phase}: request failed`);
    }
    let value: unknown;
    await withCleanup(
        async () => {
            if (response.statusCode !== 200)
                throw new Error(`Test admin recovery ${phase}: HTTP ${response.statusCode}`);
            try {
                value = await response.body.json();
            } catch {
                throw new Error(`Test admin recovery ${phase}: invalid JSON`);
            }
            try {
                const cookies = response.headers["set-cookie"] ?? [];
                for (const cookie of Array.isArray(cookies) ? cookies : [cookies])
                    jar.setCookieSync(cookie, origin + path);
            } catch {
                throw new Error(`Test admin recovery ${phase}: invalid cookie`);
            }
        },
        async () => {
            // 非成功状态也必须关闭未读取的响应流，等待关闭事件后才结算客户端，防止重定向正文或中断连接残留。
            try {
                await response.body.dump({ limit: 64 * 1024 });
            } catch {
                throw new Error(`Test admin recovery ${phase}: response cleanup failed`);
            }
        },
    );
    if (value === null || typeof value !== "object" || !("data" in value))
        throw new Error(`Test admin recovery ${phase}: missing data`);
    const result = value.data;
    if (result === null || typeof result !== "object" || Array.isArray(result))
        throw new Error(`Test admin recovery ${phase}: invalid data`);
    return result as Record<string, unknown>;
}

/**
 * 独立会话先握手并使用匿名 CSRF 登录既有备用管理员，再向固定目标恢复已知初始角色；任何阶段异常都失败关闭。
 * 公开 Node 客户端不会创建 Playwright 请求上下文，因此原生运行器不采集恢复凭据；正常 GUI 追踪不受影响。
 * 工厂仅供回归观察真实客户端与内存容器的释放，所有底层清理诊断在进入既有错误结算器前统一脱敏。
 */
export async function restoreTestAdmin(
    options: TestAdminRecovery,
    createResources: (origin: string) => { client: Client; jar: CookieJar } = (origin) => ({
        client: new Client(origin, { maxResponseSize: 64 * 1024 }),
        jar: new CookieJar(),
    }),
): Promise<void> {
    try {
        const parsed = new URL(options.origin);
        if (
            parsed.origin !== options.origin ||
            !["http:", "https:"].includes(parsed.protocol) ||
            (parsed.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.targetId)
        )
            throw new Error("Invalid recovery endpoint");
    } catch {
        throw new Error("Test admin recovery: invalid endpoint");
    }
    let resources: ReturnType<typeof createResources>;
    try {
        resources = createResources(options.origin);
    } catch {
        throw new Error("Test admin recovery: client creation failed");
    }
    const { client, jar } = resources;
    await withCleanup(
        async () => {
            const setup = await responseData(client, jar, options.origin, "/api/v1/setup", "GET", "setup");
            const setupCsrf = setup.csrfToken;
            if (typeof setupCsrf !== "string" || !setupCsrf) throw new Error("Test admin recovery setup: missing CSRF");
            // 匿名握手的令牌只用于登录，认证后使用响应中的新令牌；两次请求的 Cookie 均由这个独立上下文实际维护。
            const login = await responseData(
                client,
                jar,
                options.origin,
                "/api/v1/auth/login",
                "POST",
                "login",
                setupCsrf,
                { email: options.backupEmail, password: options.backupPassword },
            );
            const user = login.user;
            if (
                user === null ||
                typeof user !== "object" ||
                Array.isArray(user) ||
                !("id" in user) ||
                typeof user.id !== "string" ||
                !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user.id) ||
                !("email" in user) ||
                user.email !== options.backupEmail ||
                !("displayName" in user) ||
                typeof user.displayName !== "string" ||
                !user.displayName ||
                !("disabled" in user) ||
                user.disabled !== false
            )
                throw new Error("Test admin recovery login: unexpected principal");
            const loginCsrf = login.csrfToken;
            if (typeof loginCsrf !== "string" || !loginCsrf) throw new Error("Test admin recovery login: missing CSRF");
            // 登录只返回普通用户字段，必须在同一独立会话读取账户权限，并与已知备用邮箱及刚登录的主体标识严格绑定。
            const account = await responseData(
                client,
                jar,
                options.origin,
                "/api/v1/account",
                "GET",
                "account",
                loginCsrf,
            );
            if (
                account.id !== user.id ||
                account.email !== options.backupEmail ||
                typeof account.displayName !== "string" ||
                !account.displayName ||
                account.disabled !== false ||
                account.systemAdmin !== true
            )
                throw new Error("Test admin recovery account: unexpected principal");
            // 只恢复本测试已知账号初始角色，补丁响应也须确认相同标识和邮箱，不能误把其它用户的成功正文当作恢复完成。
            const restored = await responseData(
                client,
                jar,
                options.origin,
                `/api/v1/admin/users/${options.targetId}`,
                "PATCH",
                "role restore",
                loginCsrf,
                { systemAdmin: true },
            );
            if (
                restored.id !== options.targetId ||
                restored.email !== options.targetEmail ||
                restored.systemAdmin !== true
            )
                throw new Error("Test admin recovery role restore: unexpected target");
        },
        () =>
            withCleanup(
                async () => {
                    try {
                        await client.destroy();
                    } catch {
                        throw new Error("Test admin recovery: client cleanup failed");
                    }
                },
                async () => {
                    try {
                        jar.removeAllCookiesSync();
                    } catch {
                        throw new Error("Test admin recovery: cookie cleanup failed");
                    }
                },
            ),
    );
}
