import type { ChildProcess } from "node:child_process";
import type { ObservedObject, ObserverBinding } from "./controlled-child-protocol.mjs";

/** VeriQ 的父侧接口只承认本次实际 ChildProcess 的退出观察，借入 FD 不转移所有权；超时、error 和迟到注册都保持失败，
 * 调用者仍必须清理并等待真实退出后关闭描述符。
 */
export interface ObservedCliOptions {
    /**
     * 日志描述符由父所有者安全预开并借入观察器，最终定位读取必须仍指向同一私有普通文件；观察超时或核验失败不会关闭它，
     * 调用方须等实际写者退出再清理。日志只允许所属 CLI 写入，父侧不与它并发追加内容。本接口不重新按路径打开文件，
     * 也不接管父目录的持久发布。
     */
    journalFd: number;
    /**
     * 期望身份在同步注册时经协议验证器复制成快照，后续所有取消匹配与日志解析都使用该快照；输入对象被调用方改写不能移动
     * 本次观察的 Attempt 或代际边界。绑定包含命令 slot 和 nonce，不使用可复用的裸 PID
     * 表示身份。无效结构在注册时抛出协议错误，不开始一次无身份核验。
     */
    expectedBinding: ObserverBinding;
    /**
     * 兼容字段在注册时立即复制并与期望快照比较，只在完全相等时允许正常取消码进入最终核验；过时代际不能靠后续改写该对象
     * 或 options 使权限从无变有。调用方可继续使用此字段表达启动时已有的取消授权。
     * 启动后才发生的取消应使用返回接口的 authorizeCancellation。
     */
    authorizedCancellation?: ObserverBinding;
    /**
     * 可选观察截止时间只接受正安全整数，超时返回 CLI_TIMEOUT 并永久关闭新授权窗口；实际子进程可能仍然存活，
     * 调用方必须自行持有对象并等待真实退出事实。不指定时，观察等待真实 exit 或 error，不额外安排期限。
     * 此选项不发终止信号，不承诺整棵后代树已排空。
     */
    timeoutMs?: number;
}

/**
 * 退出事实与观察失败显式区分，超时不会被伪造成退出也不会暗中发信号；同一对象的真实 signal 可供诊断，但 CLI
 * 自身信号终止永远不能生成完整链的成功结果。exit 分支来自被注册对象的实际事件，包含正常码或 signal。
 * failure 分支是观察不能完成，不能解释为 CLI 已经结束。CLI_ALREADY_EXITED 表示注册已经错过事实，
 * 现存退出字段不能补登记。
 */
export type CliExitObservation =
    | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null }
    | { kind: "failure"; reason: "CLI_ERROR" | "CLI_TIMEOUT" | "CLI_ALREADY_EXITED" };

/**
 * 成功仅表示受信 CLI 正常退出和其直接异步子对象日志闭合，业务失败码一仍保留；本类型不覆盖 spawnSync、
 * 任意后代或恶意同进程脚本，也不生成停止回执或释放容量。一百三十表示正常取消退出且已经授权，仍须完成同一套日志核验。
 * objects 只列出严格封存协议中已经结清的直接异步子对象。coverage 固定表达本接口范围，不替代后续受控 Worker 和 Chrome
 * 证明。
 */
export type ControlledChildResult =
    | { ok: true; exitCode: 0 | 1 | 130; objects: ObservedObject[]; coverage: "DIRECT_ASYNC_CHILDREN" }
    | { ok: false; reason: string };

/**
 * 必须在 spawn 返回后立刻同步注册真实对象的 exit 与 error，再进入任何异步读取；FD 全程借入且定位读取，
 * 退出事实与授权窗口由同一个原始对象共同约束。运行实现位于同目录 MJS，使普通 Node 和
 * TypeScript 消费者共享同一观察状态机。返回的 exited 可能是观察失败，调用方仍必须等待原始 ChildProcess 的实际退出。
 * verifyFinal 只结清 CLI 的直接异步子对象，不发布持久停止证明。
 * authorizeCancellation 只在本次观察尚未终结且对象仍存活时接受相同绑定。无效结构、代际不符或关闭窗口均抛出
 * CONTROLLED_CHILD_CANCELLATION_REJECTED。
 */
export function trackObservedCli(child: ChildProcess, options: ObservedCliOptions): {
    /** 退出观察区分真实 exit 与超时或 error 等失败，借入描述符仍由调用方在实际退出后关闭；消费者不得把 promise
     * 已完成直接解释为可释放进程容量的证明。
     */
    exited: Promise<CliExitObservation>;
    /** 最终核验等待本次观察结果后定位读取同一普通文件并检查完整封存，缓存的结果不会因重复调用或输入对象后续改变而重新赋
     * 予取消权限或改写绑定身份。
     */
    verifyFinal(): Promise<ControlledChildResult>;
    /** 启动后的取消授权只接受当前快照身份并在真实 exit 监听中同步关闭，尚存活时相同有效绑定可幂等调用；
     * 失败调用不增加权限，也不发送终止信号或关闭借入描述符。
     */
    authorizeCancellation(binding: ObserverBinding): void;
};
