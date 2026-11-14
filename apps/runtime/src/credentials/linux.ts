/** Linux 保险库后端只执行完整发行库存授予的固定辅助程序，用单次有界私有输入输出隔离可能无限等待的系统库；取消必须等到自有进程实际退出，未知修改结果不冒充回滚或自动选择明文回退。 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { verifiedVaultHelper, type RuntimeDistribution } from "../distribution.ts";
import type {
    VaultKeyBackend,
    VaultKeyScope,
    VaultMutationResult,
    VaultBackendFailure,
} from "./backend.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ownedHelpers = new Map<string, { child?: ReturnType<typeof spawn> }>();
type Operation = "probe" | "get" | "set" | "delete";
type ReadResult = { status: "ok"; key: Buffer } | VaultBackendFailure;
type ProbeResult = { status: "ready" } | VaultBackendFailure;
type Result = ReadResult | ProbeResult | VaultMutationResult;

/** 自有辅助进程观察只记录实际 PID、退出码、信号和停止原因，不包含协议载荷或原始标准错误；退出未被确认时必须保留该事实，不能把已请求终止当成资源释放或业务工作进程的停止证明。 */
export type VaultHelperObservation = {
    pid: number | undefined;
    code: number | null;
    signal: NodeJS.Signals | null;
    exitConfirmed: boolean;
    reason: "complete" | "spawn" | "protocol" | "timeout" | "cancelled" | "exit";
};

/** 辅助程序仅继承真实用户会话所需环境，所有动态加载、Node 注入及任意模块搜索配置均不透传；系统命令搜索路径固定且程序通过绝对库存路径启动，因此档案与业务环境不能替换执行器或依赖库。 */
function environment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", GIO_USE_VFS: "local" };
    for (const name of [
        "HOME",
        "USER",
        "LOGNAME",
        "LANG",
        "LC_ALL",
        "DBUS_SESSION_BUS_ADDRESS",
        "XDG_RUNTIME_DIR",
        "XDG_DATA_HOME",
        "XDG_CONFIG_HOME",
    ]) {
        const value = process.env[name];
        if (value !== undefined && value.length <= 4096 && !value.includes("\0")) env[name] = value;
    }
    return env;
}

function validScope(scope: VaultKeyScope) {
    return (
        scope &&
        typeof scope === "object" &&
        Object.keys(scope).length === 2 &&
        Object.hasOwn(scope, "profileId") &&
        Object.hasOwn(scope, "keyVersion") &&
        typeof scope.profileId === "string" &&
        UUID.test(scope.profileId) &&
        typeof scope.keyVersion === "string" &&
        UUID.test(scope.keyVersion)
    );
}

function response(bytes: Buffer, operation: Operation): Result | undefined {
    const text = bytes.toString("ascii");
    if (!bytes.equals(Buffer.from(text, "ascii"))) return;
    if (/^V1 (missing|locked|unavailable|failed)\n$/.test(text))
        return { status: text.slice(3, -1) as VaultBackendFailure["status"] };
    if (operation === "probe" && text === "V1 ready\n") return { status: "ready" };
    if ((operation === "set" || operation === "delete") && text === "V1 ok\n")
        return { status: "ok" };
    if ((operation === "set" || operation === "delete") && text === "V1 mutation-unconfirmed\n")
        return { status: "mutation-unconfirmed" };
    if (operation === "get" && /^V1 ok [A-Za-z0-9_-]{43}\n$/.test(text)) {
        const encoded = text.slice(6, -1),
            key = Buffer.from(encoded, "base64url");
        if (key.length === 32 && key.toString("base64url") === encoded)
            return { status: "ok", key };
    }
}

/** 有限后端把每个操作交给一个独立拥有的辅助进程，默认五秒且内部测试期限只能为五十至五千毫秒；观察回调只接收非秘密生命周期事实，不提供任意程序路径、系统属性或通用命令的授权入口。 */
export class LinuxVaultBackend implements VaultKeyBackend {
    private readonly executable: string;
    private readonly timeoutMs: number;
    constructor(
        private readonly distribution: RuntimeDistribution,
        private readonly options: {
            timeoutMs?: number;
            observe?: (value: VaultHelperObservation) => void;
        } = {},
    ) {
        if (process.platform !== "linux") throw new Error("VAULT_PLATFORM_UNSUPPORTED");
        this.executable = verifiedVaultHelper(distribution);
        this.timeoutMs = options.timeoutMs ?? 5000;
        if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 50 || this.timeoutMs > 5000)
            throw new Error("VAULT_DEADLINE_INVALID");
    }

    /** 读取只接受精确档案与密钥版本并返回独立字节缓冲区，缺失、锁定和服务失败保持后端原始分类；取消或无效输入不会创建新密钥，所有操作均不从档案配置获取可执行程序路径或秘密命令参数。 */
    async get(scope: VaultKeyScope, signal: AbortSignal): Promise<ReadResult> {
        if (!validScope(scope)) return { status: "failed" };
        return (await this.run(
            "get",
            `V1 get ${scope.profileId} ${scope.keyVersion}\n`,
            signal,
        )) as ReadResult;
    }

    /** 写入只传递三十二字节随机材料且不修改调用方缓冲区，已使用版本的冲突由辅助程序明确拒绝；请求发出后的异常退出或取消必须保留提交不确定状态，而非自动重试或假定旧值已经恢复。 */
    async set(
        scope: VaultKeyScope,
        key: Buffer,
        signal: AbortSignal,
    ): Promise<VaultMutationResult> {
        if (!validScope(scope) || !Buffer.isBuffer(key) || key.length !== 32)
            return { status: "failed" };
        return (await this.run(
            "set",
            `V1 set ${scope.profileId} ${scope.keyVersion} ${key.toString("base64url")}\n`,
            signal,
        )) as VaultMutationResult;
    }

    /** 删除仅针对同一产品命名空间下指定档案和密钥版本，不提供清空集合或按属性泛查的接口；调用者仍须持有档案所有权并维护恢复日志，才能确定删除不会破坏其他仍引用此版本的密文。 */
    async delete(scope: VaultKeyScope, signal: AbortSignal): Promise<VaultMutationResult> {
        if (!validScope(scope)) return { status: "failed" };
        return (await this.run(
            "delete",
            `V1 delete ${scope.profileId} ${scope.keyVersion}\n`,
            signal,
        )) as VaultMutationResult;
    }

    /** 可用性探测由真实服务与默认集合状态决定而不读取任何业务凭据，返回准备就绪不等同于跨重启持久化验收；锁定与无服务均明确返回，不打开提示、不自动解锁，也不改变桌面默认后端。 */
    async probe(signal: AbortSignal): Promise<ProbeResult> {
        return (await this.run("probe", "V1 probe\n", signal)) as ProbeResult;
    }

    /** 控制输入写完单帧后保持打开直到实际退出，避免 EOF 死亡监视误杀正常请求；期限、取消或输出越界只终止本次真实 child 并额外等待至多一秒，未确认退出的观察会保留而不虚报清理成功。 */
    private async run(operation: Operation, frame: string, signal: AbortSignal): Promise<Result> {
        if (!(signal instanceof AbortSignal) || signal.aborted || ownedHelpers.has(this.executable))
            return { status: "failed" };
        const ownership: { child?: ReturnType<typeof spawn> } = {};
        ownedHelpers.set(this.executable, ownership);
        return new Promise<Result>((resolve) => {
            let child: ChildProcessWithoutNullStreams;
            try {
                child = spawn(this.executable, [], {
                    cwd: this.distribution.root,
                    env: environment(),
                    stdio: ["pipe", "pipe", "pipe"],
                });
                ownership.child = child;
            } catch {
                ownedHelpers.delete(this.executable);
                resolve({ status: "failed" });
                return;
            }
            const input = child.stdin,
                stdout = child.stdout,
                stderr = child.stderr;
            let sent = false,
                finished = false,
                exitConfirmed = false;
            let reason: VaultHelperObservation["reason"] = "complete";
            let code: number | null = null,
                exitSignal: NodeJS.Signals | null = null;
            let output = Buffer.alloc(0),
                stderrBytes = 0;
            let stopTimer: NodeJS.Timeout | undefined;
            const uncertain = (): Result => ({
                status:
                    sent && (operation === "set" || operation === "delete")
                        ? "mutation-unconfirmed"
                        : "failed",
            });
            const done = (result: Result) => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                clearTimeout(stopTimer);
                signal.removeEventListener("abort", abort);
                input.destroy();
                stdout.destroy();
                stderr.destroy();
                if (!exitConfirmed) child.unref();
                try {
                    this.options.observe?.({
                        pid: child.pid,
                        code,
                        signal: exitSignal,
                        exitConfirmed,
                        reason,
                    });
                } catch {
                    /* 生命周期观察者只接收非秘密的进程事实，其自身异常不能转发为系统库错误或改变已经确认的退出状态，也不能把已提交或不确定的写入伪装为回滚，因此这里保留原操作结果而不重放请求。 */
                }
                resolve(result);
            };
            const stop = (why: VaultHelperObservation["reason"]) => {
                if (finished || stopTimer) return;
                reason = why;
                input.destroy();
                child.kill("SIGKILL");
                stopTimer = setTimeout(() => done(uncertain()), 1000);
            };
            const abort = () => stop("cancelled");
            const timer = setTimeout(() => stop("timeout"), this.timeoutMs);
            signal.addEventListener("abort", abort, { once: true });
            child.once("spawn", () => {
                if (signal.aborted || reason !== "complete") {
                    stop("cancelled");
                    return;
                }
                sent = true;
                input.write(frame, (error) => {
                    if (error) stop("protocol");
                });
            });
            input.on("error", () => stop("protocol"));
            child.once("error", () => {
                reason = "spawn";
            });
            stdout.on("data", (bytes: Buffer) => {
                if (output.length + bytes.length > 512) stop("protocol");
                else output = Buffer.concat([output, bytes]);
            });
            stderr.on("data", (bytes: Buffer) => {
                stderrBytes += bytes.length;
                if (stderrBytes > 4096) stop("protocol");
            });
            child.once("exit", (value, valueSignal) => {
                exitConfirmed = true;
                code = value;
                exitSignal = valueSignal;
            });
            child.once("close", () => {
                /** 只有实际退出或明确未创建进程才释放共享所有权，超时返回仍保留句柄与阻断状态；迟到的退出事实可以解除阻断，但不会重跑已返回不确定结果的修改操作或触发替代子进程。 */
                if (
                    (exitConfirmed || child.pid === undefined) &&
                    ownedHelpers.get(this.executable) === ownership
                )
                    ownedHelpers.delete(this.executable);
                if (finished) {
                    try {
                        this.options.observe?.({
                            pid: child.pid,
                            code,
                            signal: exitSignal,
                            exitConfirmed,
                            reason,
                        });
                    } catch {
                        /* 迟到的真实退出已按身份解除共享阻断，观察回调异常不能恢复一个已退出进程的所有权或改写先前返回的不确定结果；后续调用仍由当前阻断状态决定，绝不在观察路径中自动启动替代程序。 */
                    }
                    return;
                }
                if (reason !== "complete" || code !== 0 || exitSignal !== null || !exitConfirmed) {
                    if (reason === "complete") reason = "exit";
                    done(uncertain());
                    return;
                }
                const value = stderrBytes === 0 ? response(output, operation) : undefined;
                if (!value) reason = "protocol";
                done(value ?? uncertain());
            });
            if (signal.aborted) abort();
        });
    }
}
