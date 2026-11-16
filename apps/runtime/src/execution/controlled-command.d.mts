import type { ChildProcess } from "node:child_process";
import type { ObserverBinding, ObservedObject } from "./controlled-child-protocol.mjs";

/**
 * VeriQ 的命令所有者只接受受信调用方提供的本代双绑定与预开私有普通文件，两个 FD 均借入且必须对应不同文件；Worker
 * 不从业务 DSL 或环境变量恢复这份控制能力。
 */
export interface ControlledCommandOptions {
    kind: "TEST" | "VALIDATE" | "CLEANUP";
    commandBinding: ObserverBinding;
    cliBinding: ObserverBinding;
    commandJournalFd: number;
    cliJournalFd: number;
}

/**
 * 每次派生只执行当前受信角色 Node 与既定参数，调用方负责参数来源与工作目录的信任边界；CLI preload 相对本模块固定解析，
 * 业务输入不能选择观察器文件或额外日志映射。
 */
export interface ControlledCommandInput {
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
}

/**
 * 真实退出与管理观察严格分离，result 失败时 exited 可能永久挂起而原对象仍必须保留；调用方不得在超时或 error 后用
 * result 的完成代替同一 ChildProcess 的实际退出。
 */
export interface HeldCommand {
    child: ChildProcess;
    exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
    result: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
}

/**
 * 所有者固定 npm、编译器和可选 CLI 的前三个 slot，管理故障粘滞关闭准入并阻止封存；正常提前业务失败或授权取消可以封存已
 * 经完成的前缀而不捏造未派生命令。
 */
export interface ControlledCommandOwner {
    /**
     * 派生前同步刷新意图并立即观察返回的真实对象，CLI 管理成功还必须通过共享 C1 最终核验；调用者始终保留返回对象与独立
     * 实际退出等待器，用于管理超时或错误之后的资源清理。
     */
    start(role: "npm" | "compiler" | "cli", command: ControlledCommandInput): HeldCommand;
    /**
     * 取消绑定必须精确匹配当前命令所有者且重复同代调用幂等，仍存活的 CLI 先安装本代授权再收到 SIGINT；
     * 错误调用不关闭准入、不授权且不会发送任何信号。
     */
    requestStop(binding: ObserverBinding): void;
    /**
     * 外层 Worker 的 IPC 断连和未捕获故障转成固定管理失败并关闭命令准入，调用此方法不表示任何子对象已退出，
     * 也不会关闭由父层拥有的两个借入日志描述符。
     */
    fail(): void;
    /**
     * 封存只允许没有管理故障且所有命令实际退出并通过最终验证的前缀，返回对象继续使用唯一 C1 语法与验证器；
     * 此结果不证明外层 Worker 或 Chrome 已退出。
     */
    seal(): { objects: ObservedObject[] };
}

/**
 * 构造时复制核验双绑定与不同私有文件并同步刷新 READY，之后任何超时或管理故障都永久禁止封存；本接口不拥有 FD、不解释裸
 * PID，也不产生持久停止证明或容量释放。
 */
export function createControlledCommandOwner(options: ControlledCommandOptions): ControlledCommandOwner;
