import {
    installHostTransport,
    CloudResourceAdapter,
    LocalResourceAdapter,
    CloudReportAdapter,
    LocalReportAdapter,
    CloudAiAdapter,
    CloudBundleAdapter,
    type LocalResourceSnapshot,
    type LocalReportSnapshot,
    type ReportAdapter,
} from "@veriq/web/desktop";
import type { PlatformComponents } from "@veriq/contracts";
import type { CloudOperation } from "../shared/operations.generated";
import type { AgentState } from "../shared/bridge";
import catalog from "../shared/operations.generated.json";

type S = PlatformComponents["schemas"];
const bridge = window.veriq;

/** 共享 Cloud 适配器的相对路径只在 renderer 内转换成既定操作名称和结构参数，IPC 消息不携带路径或请求头；此匹配只负责兼容旧视图，宿主会重新独立检查全部授权与输入。 */
function operation(
    path: string,
    method: string,
    data?: unknown,
    headers?: Record<string, string>,
): CloudOperation {
    const url = new URL("/api/v1" + path, "https://veriq.invalid");
    for (const [name, rule] of Object.entries(catalog)) {
        if (rule.method !== method) continue;
        const names: string[] = [];
        const pattern = rule.path.replace(/\{([^}]+)\}/g, (_all, name: string) => {
            names.push(name);
            return "([^/]+)";
        });
        const match = new RegExp("^" + pattern + "$").exec(url.pathname);
        if (!match) continue;
        const params = Object.fromEntries(
            names.map((name, index) => [name, decodeURIComponent(match[index + 1]!)]),
        );
        const query = Object.fromEntries(
            [...url.searchParams].map(([key, value]) => {
                const schema = (rule.queries as Record<string, { type?: string }>)[key];
                return [
                    key,
                    schema?.type === "integer"
                        ? Number(value)
                        : schema?.type === "boolean"
                          ? value === "true"
                          : value,
                ];
            }),
        );
        if (headers && Object.keys(headers).some((key) => key !== "Idempotency-Key"))
            throw new Error("HOST_HEADER_DENIED");
        return {
            operation: name,
            ...(names.length ? { params } : {}),
            ...(url.search ? { query } : {}),
            ...(data === undefined ? {} : { data }),
            ...(headers?.["Idempotency-Key"] ? { idempotencyKey: headers["Idempotency-Key"] } : {}),
        } as CloudOperation;
    }
    throw new Error("HOST_OPERATION_UNAVAILABLE");
}

/** 桌面只在挂载共享页面前安装一次传输，报告流按 renderer 消费速度逐块拉取并在组件取消时关闭；生成源码可以读取，原始证据与包下载使用另设的 native 方法保持宿主边界。 */
export function installDesktopTransport(): void {
    installHostTransport({
        json: async (path, method, data, signal, headers) => {
            signal?.throwIfAborted();
            const value = await bridge.cloud(operation(path, method, data, headers));
            signal?.throwIfAborted();
            return value;
        },
        binary: async (path, signal) => {
            signal?.throwIfAborted();
            const value = await bridge.cloud(operation(path, "GET"));
            signal?.throwIfAborted();
            if (!(value instanceof Uint8Array)) throw new Error("INVALID_SOURCE_BYTES");
            return new Response(new Uint8Array(value));
        },
        stream: async (path, data, signal) => {
            signal.throwIfAborted();
            const id = await bridge.streamOpen(operation(path, "POST", data));
            const close = () => {
                void bridge.streamClose(id).catch(() => {});
            };
            signal.addEventListener("abort", close, { once: true });
            const body = new ReadableStream<Uint8Array>({
                async pull(controller) {
                    try {
                        signal.throwIfAborted();
                        const part = await bridge.streamPull(id);
                        if (part.done) {
                            signal.removeEventListener("abort", close);
                            controller.close();
                        } else if (part.bytes) controller.enqueue(part.bytes);
                    } catch (error) {
                        close();
                        controller.error(error);
                    }
                },
                cancel() {
                    signal.removeEventListener("abort", close);
                    close();
                },
            });
            return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
        },
    });
}

/** 云端页面复用已有业务适配器，证据按钮转为宿主确认后的 native 操作，签名包按钮直接下载并验签；业务资源的编辑与 AI 调用仍然经过当前成员的普通会话授权。 */
export function cloudAdapters(workspaceId: string, debug: boolean) {
    const resources = new CloudResourceAdapter(workspaceId);
    const reports = new CloudReportAdapter(workspaceId);
    const runs = new Map<string, string>();
    const remember = (report: S["RunReportDTO"]) => {
        for (const item of report.cases)
            for (const attempt of item.attempts) runs.set(attempt.id, report.run.id);
        return report;
    };
    const original = reports.report;
    reports.report = async (...args) => remember(await original(...args));
    const reportAdapter: ReportAdapter = Object.assign(reports, {
        nativeArtifact: async (
            attemptId: string,
            artifactId: string,
            action: "save" | "trace" | "preview",
        ) => {
            const runId = runs.get(attemptId);
            if (!runId) throw new Error("REPORT_CONTEXT_MISSING");
            await bridge.artifact({ local: false, runId, attemptId, artifactId, action });
        },
    });
    const bundles = Object.assign(new CloudBundleAdapter(workspaceId), {
        install: async (bundleId: string) => {
            await bridge.local({ operation: "download", bundleId, debug });
        },
    });
    return { resources, reports: reportAdapter, bundles, ai: new CloudAiAdapter(workspaceId) };
}

/** 本地资源的 DTO 来自 Agent 重新验签的包投影，源码读取只按已登记版本和文件描述调用宿主；renderer 构造的适配器不是信任根，任何伪造标识仍会在后台再次失败关闭。 */
export async function localResources(bundleId: string): Promise<LocalResourceAdapter> {
    const snapshot = (await bridge.local({ operation: "snapshot", bundleId })) as Omit<
        LocalResourceSnapshot,
        "readSource"
    >;
    return new LocalResourceAdapter({
        ...snapshot,
        readSource: async (versionId, file, signal) => {
            signal?.throwIfAborted();
            const value = await bridge.local({ operation: "source", bundleId, versionId, file });
            signal?.throwIfAborted();
            if (typeof value !== "string") throw new Error("INVALID_LOCAL_SOURCE");
            return value;
        },
    });
}

/** 本地报告读取真实 SQLite 快照并映射到共享报告组件，轮询只用于读取已持久化进度而不生成事件；原始证据由 native 授权路径处理，离线报告不会冒充在线正式门禁通过。 */
export class DesktopLocalReports implements ReportAdapter {
    readonly readOnly = true;
    private attempts = new Map<string, string>();
    /** 本地报告适配器固定绑定一个已经选定的工作区，后续每次读取仍比较后台快照中的实际工作区；公开只读属性只控制共享视图的交互能力，不能代替 Node 对原始证据的授权。 */
    constructor(readonly workspaceId: string) {}
    /** 报告快照来自本机 SQLite 的真实持久化记录，加载时校验工作区并登记 Attempt 到 Run 的归属映射；后续制品和历史查询只能通过这些已观察到的关联定位，不能猜测任意 Run。 */
    private async snapshot(runId: string) {
        const value = (await bridge.local({ operation: "report", runId })) as LocalReportSnapshot;
        if (value.workspaceId !== this.workspaceId) throw new Error("WORKSPACE_SCOPE_MISMATCH");
        for (const report of value.reports)
            for (const item of report.cases)
                for (const attempt of item.attempts) this.attempts.set(attempt.id, runId);
        return new LocalReportAdapter(value);
    }
    private run(attemptId: string) {
        const run = this.attempts.get(attemptId);
        if (!run) throw new Error("ATTEMPT_NOT_FOUND");
        return run;
    }
    /** 本地报告列表从 Agent 当前历史逐条读取持久化 Run 投影，列表没有伪造在线分页游标；底层读取失败会保留错误状态而不是默默跳过某条历史，让用户误以为全部证据已完整。 */
    list = async () => {
        const state = (await bridge.local({ operation: "status" })) as AgentState;
        const items: S["RunDTO"][] = [];
        for (const history of state.history)
            items.push((await (await this.snapshot(history.id)).report(history.id)).run);
        return { items, nextCursor: null };
    };
    /** 获取指定 Run 的最新完整本机快照并交给共享只读报告适配器投影，状态来自已经持久化的执行记录；没有通过轮询次数、窗口是否存活或进程 PID 推断用例成功。 */
    report = async (runId: string) => (await this.snapshot(runId)).report(runId);
    /** 为共享报告视图提供指定 Run 与 Attempt 的已持久化显示数据，先重新加载所属快照再使用既有适配器检查关联；页面不能通过单独的 Attempt 标识绕开父级 Run 的上下文。 */
    display = async (runId: string, attemptId: string) =>
        (await this.snapshot(runId)).display(runId, attemptId);
    /** 增量历史读取只接受此前已在报告中登记的 Attempt，并把 after 序号交给共享适配器处理；未知 Attempt 直接失败，不通过全盘搜索其它工作区来猜测其所属执行记录。 */
    history = async (attemptId: string, after: number) =>
        (await this.snapshot(this.run(attemptId))).history(attemptId, after);
    /** 制品描述先通过已加载报告中的 Attempt 归属寻找 Run，再从新快照取得相应列表；描述用于页面展示和选择，不能被 renderer 当作本机文件路径或可直接下载的原始字节。 */
    artifacts = async (attemptId: string) =>
        (await this.snapshot(this.run(attemptId))).artifacts(attemptId);
    /** 共享 Web 的 Blob 下载接口在本地适配器中明确拒绝，原始证据必须经过 main 的确认和原生查看保存流程；调用方不能因为报告描述可见就绕过主机授权获取文件内容。 */
    download = async (): Promise<Blob> => {
        throw new Error("NATIVE_ARTIFACT_REQUIRED");
    };
    /** 离线报告没有平台服务端的访问审计流，因此此适配器明确提供空列表与终止游标供共享视图显示；这不表示服务器审计已经查询成功，也不改变本机执行事件和报告历史。 */
    audit = async () => ({ items: [], nextCursor: null });
    /** 原生证据动作携带固定的 local 标记及已登记的 Run 关联交给宿主，保存、Trace 和截图是有限动作集合；调用方不能加入路径或自定义程序，也不能改变已有 Attempt 的归属。 */
    nativeArtifact = async (
        attemptId: string,
        artifactId: string,
        action: "save" | "trace" | "preview",
    ) =>
        bridge.artifact({ local: true, runId: this.run(attemptId), attemptId, artifactId, action });
    /** 离线订阅按一秒间隔重新读取真实报告并在终结或取消时停止，定时器只是读取节奏而非业务完成信号；AbortSignal 在等待和读取之后都检查，切换视图不会继续投递旧报告。 */
    subscribe = async (
        runId: string,
        receive: (report: S["RunReportDTO"]) => void,
        signal: AbortSignal,
    ) => {
        while (!signal.aborted) {
            const report = await this.report(runId);
            signal.throwIfAborted();
            receive(report);
            if (report.run.state === "FINISHED") return;
            await new Promise<void>((resolve) => {
                const timer = setTimeout(() => {
                    signal.removeEventListener("abort", abort);
                    resolve();
                }, 1000);
                const abort = () => {
                    clearTimeout(timer);
                    resolve();
                };
                signal.addEventListener("abort", abort, { once: true });
            });
        }
    };
}
