import type { Session } from "electron";
import { createHash } from "node:crypto";
import type { PlatformComponents } from "@veriq/contracts";
import type { CloudOperation } from "../shared/operations.generated";
import { object, parseSchema, resolveOperation, type ResolvedOperation } from "./policy";

type S = PlatformComponents["schemas"];
/** 公开登录状态只包含当前用户资料与到期时间，masked CSRF 以及浏览器 Cookie 都留在宿主 Session 中；这个投影独立于服务端完整 DTO，避免类型谎报已删去的凭证字段。 */
export type PublicSession = Pick<S["SessionDTO"], "user" | "expiresAt">;

/** 控制地址配置仅接受完整 HTTPS Origin 或本机开发 HTTP Origin，拒绝路径、用户信息和查询字符串；包中的签发者标签不能替代这个明确配置的认证目的地。 */
export function controlOrigin(value: string): string {
    const url = new URL(value);
    if (
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash ||
        !(
            url.protocol === "https:" ||
            (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
        )
    )
        throw new Error("CONTROL_ORIGIN_INVALID");
    return url.origin;
}

/** 云端宿主会话使用 Electron 成熟 Cookie 存储与网络实现，渲染分区不能访问它；每次工作区切换都会中止旧请求和订阅，所有重定向统一失败以阻止凭证被转发。 */
export class HostSession {
    private csrf = "";
    private lifetime = new AbortController();
    private streams = new Map<string, ReadableStreamDefaultReader<Uint8Array>>();
    private pendingStreams = new Set<string>();
    workspace: S["WorkspaceDTO"] | undefined;
    user: PublicSession | undefined;
    readonly origin: string;

    /** 宿主网络适配器只需要 Electron Session 的请求与 Cookie 清理两个能力，构造时立即验证认证目的地；单元测试可提供真实 Response 流边界，但产品必须传入独立的持久分区。
     * 来源验证在首次请求之前完成。
     * 调用者不能为每次操作重新选择来源。
     * 分区的 Cookie 不会复制到主窗口分区。
     * workspace 保存已完成成员检查的工作区 DTO。
     * user 保存无 CSRF 字段的公开会话。
     * 设备注册和执行令牌属于另一条后台通路。
     */
    constructor(
        private readonly session: Pick<Session, "fetch" | "clearStorageData">,
        origin: string,
    ) {
        this.origin = controlOrigin(origin);
    }

    /** 请求发送把已解析的固定路由与唯一控制 Origin 拼接，认证信息由宿主 Session 自动管理；所有正文操作都附加匹配来源和 CSRF，服务端仍执行实际角色检查而不是相信本机缓存。
     * credentials include 使用该分区自己的 Cookie。
     * redirect error 使跨来源和同来源跳转都显式失败。
     * 生命周期信号负责切换工作区或登出时撤销旧请求。
     * 六十秒预算只限制一次宿主网络调用。
     * 这个预算不修改后台测试用例的执行时限。
     * GET 不发送 CSRF 字段，也不携带伪造 Origin。
     * 写请求的 Origin 等于经过校验的控制地址。
     * 调用方没有传入 Headers 对象的接口。
     * 幂等键只来自操作策略认可的专用字段。
     * 正文在策略校验后才序列化。
     * 没有正文时不生成 JSON undefined 数据。
     * Cookie 和响应 CSRF 均不加入 renderer 返回值。
     */
    private async response(operation: ResolvedOperation): Promise<Response> {
        return this.session.fetch(this.origin + operation.path, {
            method: operation.method,
            credentials: "include",
            redirect: "error",
            signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(60000)]),
            headers: {
                "Content-Type": "application/json",
                ...(operation.method === "GET"
                    ? {}
                    : { Origin: this.origin, "X-CSRF-Token": this.csrf }),
                ...(operation.idempotencyKey
                    ? { "Idempotency-Key": operation.idempotencyKey }
                    : {}),
            },
            ...(operation.data === undefined ? {} : { body: JSON.stringify(operation.data) }),
        });
    }

    /** 普通 JSON 响应通过流式读取实施三十二 MiB 上限，错误响应也不能绕过该限制；仅标准大写错误码可透传到界面，服务端返回的 HTML、任意异常文字或缺失数据封套都不会成为可信 DTO。
     * 每次读取先累计实际字节，再保存本块。
     * 超过上限立即进入 finally 取消 reader。
     * 成功读取同样释放流，不让旧响应占据连接。
     * Buffer 合并发生在上限检查之后。
     * JSON.parse 失败直接拒绝，不返回空成功对象。
     * object 拒绝数组或非对象封套。
     * 非成功状态在读取错误码后才区分认证问题。
     * ENROLLMENT_INVALID 属于设备流程错误。
     * 它不能撤销仍然有效的普通员工登录。
     * 其它 401 撤销用户摘要、工作区和旧订阅。
     * HTTP 成功但没有 data 字段也视为协议错误。
     * 有 csrfToken 时只更新宿主私有字段。
     * 公开登录方法会另行构造无凭证的返回对象。
     */
    private async json(operation: ResolvedOperation): Promise<unknown> {
        const response = await this.response(operation);
        const reader = response.body?.getReader();
        const parts: Uint8Array[] = [];
        let length = 0;
        if (reader)
            try {
                while (true) {
                    const part = await reader.read();
                    if (part.done) break;
                    length += part.value.length;
                    if (length > 32 * 1024 * 1024) throw new Error("HOST_RESPONSE_LIMIT");
                    parts.push(part.value);
                }
            } finally {
                await reader.cancel();
            }
        const envelope = object(JSON.parse(Buffer.concat(parts).toString("utf8")));
        if (!response.ok) {
            if (response.status === 401 && envelope.code !== "ENROLLMENT_INVALID")
                this.invalidate();
            throw new Error(
                typeof envelope.code === "string" && /^[A-Z_]{1,80}$/.test(envelope.code)
                    ? envelope.code
                    : "CLOUD_REQUEST_FAILED",
            );
        }
        if (!Object.hasOwn(envelope, "data")) throw new Error("INVALID_HOST_RESPONSE");
        const data = envelope.data;
        if (
            data &&
            typeof data === "object" &&
            "csrfToken" in data &&
            typeof data.csrfToken === "string"
        )
            this.csrf = data.csrfToken;
        return data;
    }

    /** 登录先获取服务端当前 CSRF 再提交用户输入，密码只在本次请求中使用而不持久化；成功后按实际模式校验资料，再明确构造不包含 CSRF 的公开会话。
     * 先请求 getSetup，以取得当前匿名会话的 CSRF。
     * 登录请求复用同一 Cookie 分区。
     * 密码只作为本次请求正文传递。
     * SessionDTO 经过共享模式验证。
     * 显式复制 user 与 expiresAt，避免以类型断言掩盖字段删除。 */
    async login(data: S["LoginRequest"]): Promise<PublicSession> {
        await this.json(resolveOperation({ operation: "getSetup" }, undefined));
        const value = parseSchema(
            "SessionDTO",
            await this.json(resolveOperation({ operation: "login", data }, undefined)),
        );
        this.user = { user: value.user, expiresAt: value.expiresAt };
        return this.user;
    }

    /** 恢复登录状态仍经过当前服务端会话校验，缓存 Cookie 不能自行证明身份有效；公开调用方得到的始终是独立安全投影，而不是含 masked CSRF 的原始响应。
     * 恢复不会仅因磁盘上仍有 Cookie 就宣称在线。
     * 服务端 session 端点决定该会话是否仍有效。
     * 返回形状与交互登录保持一致。 */
    async restore(): Promise<PublicSession> {
        const value = parseSchema(
            "SessionDTO",
            await this.json(resolveOperation({ operation: "session" }, undefined)),
        );
        this.user = { user: value.user, expiresAt: value.expiresAt };
        return this.user;
    }

    /** 普通业务访问排除认证和设备凭证操作，路由与正文仍由固定白名单重新验证；返回数据只来自对应服务端权限边界，不能把设备 token 当成员会话替代品。
     * 通用云端入口拒绝四个会改变认证状态的操作。
     * 登录和登出只能走各自显式生命周期方法。
     * 策略解析绑定当前宿主工作区。
     * 二进制报告证据不能借此入口返回 renderer。
     * 源码模式只在声明了具体 path 查询时返回字节。
     * 普通列表与业务响应仍按标准 JSON 封套读取。 */
    async cloud(operation: CloudOperation): Promise<unknown> {
        if (["login", "session", "logout", "getSetup"].includes(operation.operation))
            throw new Error("IPC_OPERATION_DENIED");
        const resolved = resolveOperation(operation, this.workspace?.id);
        if (resolved.kind !== "json" && resolved.kind !== "source")
            throw new Error("IPC_OPERATION_DENIED");
        if (resolved.kind === "source" && "query" in operation && operation.query?.path) {
            const response = await this.response(resolved);
            if (!response.ok) throw new Error("SOURCE_DOWNLOAD_FAILED");
            return this.bytes(response, 1024 * 1024);
        }
        return this.json(resolved);
    }

    /** 工作区选择通过服务端当前成员检查后才替换窗口作用域，旧订阅会在切换瞬间关闭；即使存在先前列表缓存，也不允许直接拿缓存角色建立新的宿主授权。
     * 先访问目标工作区端点，复用服务器成员检查。
     * 检查失败时不会把目标 UUID 保存成已授权状态。
     * 成功后中止原工作区的请求与流。
     * 普通用户摘要和 CSRF 可以保留。
     * 新的工作区 DTO 在撤销旧作用域之后赋值。 */
    async select(workspaceId: string): Promise<S["WorkspaceDTO"]> {
        const value = parseSchema(
            "WorkspaceDTO",
            await this.json(
                resolveOperation(
                    { operation: "getWorkspace", params: { workspaceId } },
                    workspaceId,
                ),
            ),
        );
        this.invalidate(false);
        this.workspace = value;
        return value;
    }

    /** 登出首先撤销服务器普通会话，再清除本机 Cookie 和所有窗口订阅；设备信任根及设备令牌由另一条显式解绑流程负责，不能因员工登出被隐式混同或替换。
     * 服务端注销失败也必须清理本机 Cookie。
     * finally 保证旧流和 UI 摘要先失效。
     * Cookie 清理仅作用于独立普通登录分区。
     * 设备执行身份不会在这里被误删。 */
    async logout(): Promise<void> {
        try {
            await this.json(
                resolveOperation({ operation: "logout", data: {} }, this.workspace?.id),
            );
        } finally {
            this.invalidate();
            await this.session.clearStorageData({ storages: ["cookies"] });
        }
    }

    /** 二进制读取必须同时拥有响应流和调用方明确的字节预算，按实际收到的块计数后才合并；缺少响应体不是空文件成功，取消 reader 既覆盖上限异常也覆盖正常结束。
     * 源码读取使用一 MiB 上限。
     * 原始报告证据使用三十二 MiB 上限。
     * 不采用不可信 Content-Length 作为实际长度。
     * 空但存在的流可返回零字节，由具体消费者继续判断格式。
     * 合并后显式构造 Uint8Array，避免把宿主 Buffer 能力暴露出去。
     * 网络中断会沿 await read 的原始失败路径退出。
     * finally 取消属于本请求的 reader。
     * 调用方仍须检查 HTTP 状态和业务元数据。
     */
    private async bytes(response: Response, maximum: number): Promise<Uint8Array> {
        const reader = response.body?.getReader(),
            parts: Uint8Array[] = [];
        let size = 0;
        if (!reader) throw new Error("DOWNLOAD_BODY_MISSING");
        try {
            while (true) {
                const part = await reader.read();
                if (part.done) break;
                size += part.value.length;
                if (size > maximum) throw new Error("DOWNLOAD_SIZE_LIMIT");
                parts.push(part.value);
            }
        } finally {
            await reader.cancel();
        }
        return new Uint8Array(Buffer.concat(parts));
    }

    /** 原始云端证据先读取当前权限下的制品描述，再通过同一会话下载并检查大小和 SHA256；调用方只能得到宿主内字节，renderer 仍必须经过 native 保存或查看流程。
     * 先按 Attempt 获取当前可见的制品列表。
     * 只选择 ID 相同且状态 AVAILABLE 的条目。
     * 记录存在但尚未可用时禁止下载。
     * 实际下载路由仍绑定当前工作区。
     * 返回长度必须等于描述中的 sizeBytes。
     * 实际 SHA256 必须等于描述中的摘要。
     * 任何变化均拒绝进入原生查看或保存流程。
     * 字节与描述一起返回给 main，不经过 renderer。 */
    async artifact(
        workspaceId: string,
        attemptId: string,
        artifactId: string,
    ): Promise<{ bytes: Uint8Array; artifact: S["ReportArtifactDTO"] }> {
        const metadata = parseSchema(
            "ReportArtifactsDTO",
            await this.cloud({
                operation: "getAttemptArtifacts",
                params: { workspaceId, attemptId },
            }),
        );
        const artifact = metadata.items.find(
            (item) => item.id === artifactId && item.state === "AVAILABLE",
        );
        if (!artifact) throw new Error("ARTIFACT_UNAVAILABLE");
        const response = await this.response(
            resolveOperation(
                {
                    operation: "downloadAttemptArtifact",
                    params: { workspaceId, attemptId, artifactId },
                },
                this.workspace?.id,
            ),
        );
        if (!response.ok) throw new Error("ARTIFACT_DOWNLOAD_DENIED");
        const bytes = await this.bytes(response, 32 * 1024 * 1024);
        if (
            bytes.length !== artifact.sizeBytes ||
            createHash("sha256").update(bytes).digest("hex") !== artifact.sha256
        )
            throw new Error("ARTIFACT_CHANGED");
        return { bytes, artifact };
    }

    /** 报告流必须来自明确的报告操作并绑定当前窗口工作区，宿主只保存流句柄；渲染端通过逐块拉取施加背压，无法提供另一个网络地址或自选认证请求头。
     * 名额计算包含已打开 reader 和尚在等待 HTTP 的请求。
     * 随机句柄在首次 await 之前登记为 pending。
     * 因此四个慢连接也会占满四个有限槽位。
     * 保存本次生命周期 signal，不能在响应返回时改读新 epoch。
     * 会话已切换时先取消迟到响应体，再返回明确失败。
     * 空响应或错误 HTTP 状态也取消已有响应体。
     * 只有有效流才转移到活动 reader 表。
     * finally 无论成功失败都释放 pending 槽位。 */
    async openStream(operation: CloudOperation): Promise<string> {
        const resolved = resolveOperation(operation, this.workspace?.id);
        if (resolved.kind !== "stream" || this.streams.size + this.pendingStreams.size >= 4)
            throw new Error("STREAM_OPERATION_DENIED");
        const id = crypto.randomUUID();
        const lifetime = this.lifetime.signal;
        this.pendingStreams.add(id);
        try {
            const response = await this.response(resolved);
            if (lifetime.aborted) {
                await response.body?.cancel();
                throw new Error("STREAM_SESSION_CHANGED");
            }
            if (!response.ok || !response.body) {
                await response.body?.cancel();
                throw new Error("STREAM_OPEN_FAILED");
            }
            this.streams.set(id, response.body.getReader());
            return id;
        } finally {
            this.pendingStreams.delete(id);
        }
    }

    /** 拉取只接受本会话创建的活动流标识，每个传输块都有明确上限；流结束后立即删除能力，注销或切换产生的旧标识不允许重新使用以继续读取旧空间报告。
     * 不存在的句柄不能触发新的网络请求。
     * 每次 IPC 拉取对应底层一次 read。
     * 完成后删除句柄，重复读取得到不存在错误。
     * 单块超过一 MiB 时关闭整条流。
     * 返回的是序列化字节块，不是可操作的网络对象。 */
    async pullStream(id: string): Promise<{ done: boolean; bytes?: Uint8Array }> {
        const reader = this.streams.get(id);
        if (!reader) throw new Error("STREAM_NOT_FOUND");
        const next = await reader.read();
        if (next.done) {
            this.streams.delete(id);
            return { done: true };
        }
        if (next.value.length > 1024 * 1024) {
            await this.closeStream(id);
            throw new Error("STREAM_CHUNK_LIMIT");
        }
        return { done: false, bytes: next.value };
    }

    /** 显式取消报告订阅只作用于该会话拥有的句柄，重复关闭已结束的流保持幂等；底层 reader 被取消后，服务端连接与宿主内存都不再由失效窗口继续占用。
     * 先删除映射，再取消底层 reader。
     * 关闭过程中重复调用不会找到第二个句柄。
     * 已经完成或已取消的句柄可以幂等关闭。 */
    async closeStream(id: string): Promise<void> {
        const reader = this.streams.get(id);
        this.streams.delete(id);
        await reader?.cancel();
    }

    /** 会话失效统一撤销请求和流能力，工作区切换可保留已认证用户摘要但必须丢弃旧工作区；新的 AbortController 只供后续请求使用，不会复活已经结束的订阅。
     * 旧信号先 abort，新请求才获得新的控制器。
     * pending 集合清空不意味着迟到响应可以被接受。
     * openStream 保存的旧 signal 会继续拒绝迟到响应。
     * 活动流逐个取消，单个取消失败不阻止其它句柄释放。
     * 工作区总被清空，避免延用过期授权。
     * clearUser false 只用于已验证的新工作区切换。
     * 正常登出和认证过期还会清空用户与 CSRF。 */
    invalidate(clearUser = true): void {
        this.lifetime.abort();
        this.lifetime = new AbortController();
        this.pendingStreams.clear();
        for (const id of this.streams.keys()) void this.closeStream(id).catch(() => {});
        this.workspace = undefined;
        if (clearUser) {
            this.user = undefined;
            this.csrf = "";
        }
    }
}
