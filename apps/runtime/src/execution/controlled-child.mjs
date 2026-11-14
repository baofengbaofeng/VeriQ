import { ChildProcess } from "node:child_process";
import { readSync } from "node:fs";
import { inspectJournalFd, validateBinding, validateJournal } from "./controlled-child-protocol.mjs";

/** VeriQ 的父侧观察器统一服务普通 Node 与 TypeScript 消费者，保留原始 ChildProcess 的 exit 和 error 事实；它借入日志 FD 而不接管进程终止、描述符关闭或持久停止证明的所有权。
 * 调用方应在 spawn 返回后立即同步调用，任何异步等待都会造成错过 exit 的风险。
 * 仅有日志尾部 SEAL 或当前读取到 EOF 均不能结束本次观察。
 * 正常业务码零和一保留原规则，一百三十额外要求本次取消已获授权。
 * 观察超时仅终结观察，不暗中向 CLI 发信号，也不声称对象已经退出。
 * Worker 和 Chrome 的整体所有权接入留给后续切片，本模块只处理一个 CLI。
 * @param {import('node:child_process').ChildProcess} child
 * @param {import('./controlled-child.mjs').ObservedCliOptions} options
 * @returns {ReturnType<import('./controlled-child.mjs').trackObservedCli>}
 */
export function trackObservedCli(child, options) {
    if (!(child instanceof ChildProcess)) throw new TypeError("CONTROLLED_CHILD_HANDLE_REQUIRED");
    let error = false;
    let terminal = false;
    let settle;
    let timer;
    const exited = new Promise((resolve) => { settle = resolve; });

    /** 首次终结同步关闭取消窗口并固定退出观察，后续真实 exit 不能把先前超时或 error 改成成功；定时器只约束观察等待，清除定时器不代替任何实际子进程清理。
     * terminal 在 resolve 前置位，防止 promise 回调或其他 exit 监听补授权。
     * exit、error 和 timeout 共享同一闸门，失败状态不能因事件顺序被覆盖。
     * 真实 error 另有粘滞标志，最终核验仍优先拒绝它。
     * settle 只向调用者传递观察结果，不操作借入文件。
     * 正常退出与超时几乎同时发生时，以先到达的观察事件为终结点。
     * 后到 exit 仍会由对象本身保存，供持有者独立完成资源清理。
     */
    const finish = (value) => {
        if (terminal) return;
        terminal = true;
        clearTimeout(timer);
        settle(value);
    };
    child.on("error", () => {
        error = true;
        finish({ kind: "failure", reason: "CLI_ERROR" });
    });
    child.once("exit", (code, signal) => finish({ kind: "exit", code, signal }));
    if (child.exitCode !== null || child.signalCode !== null) finish({ kind: "failure", reason: "CLI_ALREADY_EXITED" });

    /** 期望身份与启动时兼容授权都立即经过原协议验证器复制，之后只保留快照或匹配布尔值；对复制结果再次核验可拒绝 getter 在校验与取值之间改变身份的恶意输入。
     * 不在这里复制协议字段列表、UUID 规则或 nonce 规则，避免产生第二套解析器。
     * 第一次验证读取调用者对象，第二次验证只读取普通快照数据。
     * 二次验证同时阻止 getter 返回错误类型却在首轮检查时暂时合法。
     * 后续修改 options、expectedBinding 或 authorizedCancellation 均不会改变权限。
     * 兼容字段保持原先的语义：结构有效但身份不匹配仅表示没有授权。
     * 相等比较依赖验证器返回的固定字段顺序，调用者键顺序不影响匹配。
     * 结构无效仍沿用注册阶段抛错，只有新增方法统一转换取消拒绝码。
     * 最终核验只接触 binding 快照，不能被调用者替换 options 属性影响。
     */
    const binding = validateBinding(validateBinding(options.expectedBinding));
    const fd = options.journalFd;
    let authorized = options.authorizedCancellation === undefined ? false
        : JSON.stringify(validateBinding(validateBinding(options.authorizedCancellation))) === JSON.stringify(binding);

    /** 超时仅在注册未发现终结状态时安排，已经错过退出的对象不能再挂起一个无意义定时器；期限回调走与真实事件相同的同步闸门，不能使后续授权复活该观察。
     * 正安全整数沿用原公开选项合同，不引入额外等待策略。
     * 定时器不调用 kill，调用者仍负责决定如何结束自己的子对象。
     * 未指定期限时不添加默认值，保持既有无限等待真实事件的语义。
     * terminal 保证期限已触发后，真实退出也不能把已固定的 failure 换成 exit。
     */
    if (options.timeoutMs !== undefined) {
        if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new TypeError("CONTROLLED_CHILD_TIMEOUT_INVALID");
        if (!terminal) timer = setTimeout(() => finish({ kind: "failure", reason: "CLI_TIMEOUT" }), options.timeoutMs);
    }
    let result;
    return {
        exited,

        /** 动态授权只接受仍存活且观察未终结的当前身份，检查真实对象的退出字段以覆盖 exit 分发前后的窗口；所有无效输入都转换成固定英文拒绝，不泄漏 getter 原始异常。
         * validateBinding 负责严格结构与快照复制，本接口不接受部分绑定或字段合并。
         * 比较全部身份字段后才写 authorized，任何失败分支都没有权限副作用。
         * 再次核验普通快照，避免访问器在协议校验后返回不同代际或无效结构。
         * 校验后重新检查窗口，拒绝调用者 getter 重入导致的观察终结。
         * child.exitCode 和 signalCode 在更早的 exit 回调中已可见，不能仅依赖 terminal。
         * 相同有效授权可在窗口内重复成功，退出后即便先前授权过也必须拒绝。
         * 一百三十仍须通过最终封存日志验证，本方法不会提前返回任何停止正结论。
         * 一次错误调用不会清除早先有效授权，但也不会产生新的权限来源。
         * 错误消息不包含 attemptId、nonce、字段内容或调用者异常信息。
         */
        authorizeCancellation(value) {
            try {
                if (terminal || error || child.exitCode !== null || child.signalCode !== null) throw new Error();
                const snapshot = validateBinding(validateBinding(value));
                if (JSON.stringify(snapshot) !== JSON.stringify(binding)
                    || terminal || error || child.exitCode !== null || child.signalCode !== null) throw new Error();
                authorized = true;
            } catch {
                throw new Error("CONTROLLED_CHILD_CANCELLATION_REJECTED");
            }
        },

        /** 最终核验缓存同一个 promise 并先等待观察终结，保留原有业务退出和严格日志规则；授权只能在真实退出前发生，verifyFinal 的调用时机不会重新打开授权窗口。
         * 观察失败直接返回原英文原因，不把 timeout 映射为正常退出。
         * signal、未知代码、专用故障码与未授权一百三十都拒绝进入正结果。
         * 合法退出码只是日志核验的前提，不能单独证明对象 roster 闭合。
         * 借入 FD 始终用于定位读取，共享文件偏移不会改变最终快照。
         * 成功范围只覆盖直接异步子对象，不涵盖任意游离后代。
         * verifyFinal 可先于取消调用开始等待，授权事实只在退出后消费。
         * 缓存 promise 让并行核验调用共享读取结果，不重复构造状态机。
         */
        verifyFinal() {
            result ??= (async () => {
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

                    /** 同一 FD 的设备、inode、长度与纳秒时间戳必须在定位读取前后保持一致，额外读取还须确认尾部没有增长；截断、重写或变化都不交给解析器猜测已封存。
                     * inspectJournalFd 同时核实普通文件、所有者、精确权限和大小上限。
                     * 本检查不按字符串路径重新打开文件，避免被替换路径引入不同对象。
                     * 完整读取后依旧检查额外字节，暂时 EOF 不能越过真实退出前提。
                     * 解析器继续要求唯一末尾 SEAL、连续 seq 及每个意图的实际退出。
                     * 任一文件或协议异常都返回 JOURNAL_INVALID，不伪造部分对象成功。
                     */
                    const after = inspectJournalFd(fd);
                    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
                        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
                        || readSync(fd, Buffer.alloc(1), 0, 1, bytes.length) !== 0) {
                        return { ok: false, reason: "JOURNAL_CHANGED" };
                    }
                    const { objects } = validateJournal(bytes, binding);
                    return { ok: true, exitCode: observation.code, objects, coverage: "DIRECT_ASYNC_CHILDREN" };
                } catch {
                    return { ok: false, reason: "JOURNAL_INVALID" };
                }
            })();
            return result;
        },
    };
}
