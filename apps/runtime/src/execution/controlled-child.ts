import { ChildProcess } from "node:child_process";
import { readSync } from "node:fs";
import { inspectJournalFd, validateBinding, validateJournal, type ObservedObject, type ObserverBinding } from "./controlled-child-protocol.mjs";

/** VeriQ 的父侧接口只承认本次实际 ChildProcess 的退出观察，借入 FD 不转移所有权；超时、error 和迟到注册都保持失败，调用者仍必须清理并等待真实退出后关闭描述符。 */
export interface ObservedCliOptions {
    journalFd: number;
    expectedBinding: ObserverBinding;
    authorizedCancellation?: ObserverBinding;
    timeoutMs?: number;
}

/** 退出事实与观察失败显式区分，超时不会被伪造成退出也不会暗中发信号；同一对象的真实 signal 可供诊断，但 CLI 自身信号终止永远不能生成完整链的成功结果。 */
export type CliExitObservation =
    | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null }
    | { kind: "failure"; reason: "CLI_ERROR" | "CLI_TIMEOUT" | "CLI_ALREADY_EXITED" };

/** 成功仅表示受信 CLI 正常退出和其直接异步子对象日志闭合，业务失败码一仍保留；本类型不覆盖 spawnSync、任意后代或恶意同进程脚本，也不生成停止回执或释放容量。 */
export type ControlledChildResult =
    | { ok: true; exitCode: 0 | 1 | 130; objects: ObservedObject[]; coverage: "DIRECT_ASYNC_CHILDREN" }
    | { ok: false; reason: string };

/** 必须在 spawn 返回后立刻同步注册真实对象的 exit 与 error，再进入任何异步读取；FD 全程借入且定位读取，不移动共享偏移，已经错过退出事件的对象不能靠现存数字补回观察事实。 */
export function trackObservedCli(child: ChildProcess, options: ObservedCliOptions): {
    exited: Promise<CliExitObservation>;
    verifyFinal(): Promise<ControlledChildResult>;
} {
    if (!(child instanceof ChildProcess)) throw new TypeError("CONTROLLED_CHILD_HANDLE_REQUIRED");
    let error = false;
    let settle!: (value: CliExitObservation) => void;
    let timer: NodeJS.Timeout | undefined;
    const exited = new Promise<CliExitObservation>((resolve) => { settle = resolve; });
    const finish = (value: CliExitObservation): void => {
        clearTimeout(timer);
        settle(value);
    };
    child.on("error", () => {
        error = true;
        finish({ kind: "failure", reason: "CLI_ERROR" });
    });
    child.once("exit", (code, signal) => finish({ kind: "exit", code, signal }));
    if (child.exitCode !== null || child.signalCode !== null) finish({ kind: "failure", reason: "CLI_ALREADY_EXITED" });
    const binding = validateBinding(options.expectedBinding);
    const fd = options.journalFd;
    const authorized = options.authorizedCancellation === undefined ? false
        : JSON.stringify(validateBinding(options.authorizedCancellation)) === JSON.stringify(binding);
    if (options.timeoutMs !== undefined) {
        if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new TypeError("CONTROLLED_CHILD_TIMEOUT_INVALID");
        if (child.exitCode === null && child.signalCode === null) {
            timer = setTimeout(() => finish({ kind: "failure", reason: "CLI_TIMEOUT" }), options.timeoutMs);
        }
    }
    let result: Promise<ControlledChildResult> | undefined;
    return {
        exited,
        verifyFinal() {
            result ??= (async (): Promise<ControlledChildResult> => {
                const observation = await exited;
                if (error) return { ok: false, reason: "CLI_ERROR" };
                if (observation.kind === "failure") return { ok: false, reason: observation.reason };
                if (observation.signal !== null || ![0, 1, 130].includes(observation.code ?? -1)
                    || (observation.code === 130 && !authorized)) return { ok: false, reason: "CLI_EXIT_REJECTED" };
                try {
                    const before = inspectJournalFd(fd);
                    const bytes = Buffer.alloc(Number(before.size));
                    let offset = 0;
                    while (offset < bytes.length) {
                        const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
                        if (count <= 0) throw new Error("CONTROLLED_CHILD_SNAPSHOT_TRUNCATED");
                        offset += count;
                    }
                    const after = inspectJournalFd(fd);
                    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
                        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
                        || readSync(fd, Buffer.alloc(1), 0, 1, bytes.length) !== 0) {
                        return { ok: false, reason: "JOURNAL_CHANGED" };
                    }
                    const { objects } = validateJournal(bytes, binding);
                    return { ok: true, exitCode: observation.code as 0 | 1 | 130, objects, coverage: "DIRECT_ASYNC_CHILDREN" };
                } catch {
                    return { ok: false, reason: "JOURNAL_INVALID" };
                }
            })();
            return result;
        },
    };
}
