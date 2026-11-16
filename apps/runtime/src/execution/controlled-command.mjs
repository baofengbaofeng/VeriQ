import { spawn } from "node:child_process";
import { fsyncSync, readSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { trackObservedCli } from "./controlled-child.mjs";
import {
    inspectJournalFd,
    LIMITS,
    validateBinding,
    validateJournal,
} from "./controlled-child-protocol.mjs";

/** VeriQ 的 Worker 只持有固定顺序的三个直接命令，借入两份私有日志描述符且始终保留原始子对象；管理失败与实际退出独立，任何未知状态都不能靠迟到退出重新取得封存资格。 */
export function createControlledCommandOwner(options) {
    const commandBinding = validateBinding(validateBinding(options.commandBinding));
    const cliBinding = validateBinding(validateBinding(options.cliBinding));
    const kind = options.kind;
    const commandFd = options.commandJournalFd;
    const cliFd = options.cliJournalFd;
    if (
        !["TEST", "VALIDATE", "CLEANUP"].includes(kind) ||
        commandBinding.attemptId !== cliBinding.attemptId ||
        commandBinding.ownerGeneration !== cliBinding.ownerGeneration ||
        commandBinding.nonce !== cliBinding.nonce ||
        commandBinding.commandSlot === cliBinding.commandSlot
    ) {
        throw new Error("CONTROLLED_COMMAND_CONFIGURATION_INVALID");
    }
    const commandIdentity = inspectJournalFd(commandFd, true);
    const cliIdentity = inspectJournalFd(cliFd, true);
    if (
        commandFd === cliFd ||
        (commandIdentity.dev === cliIdentity.dev && commandIdentity.ino === cliIdentity.ino)
    ) {
        throw new Error("CONTROLLED_COMMAND_CONFIGURATION_INVALID");
    }
    let fault;
    let closed = false;
    let sealed = false;
    let cancelled = false;
    let sequence = 0;
    let position = 0;
    const members = [];
    const roles = ["npm", "compiler", "cli"];
    const preload = fileURLToPath(new URL("./controlled-child-preload.mjs", import.meta.url));

    /** 管理故障先同步关闭准入并固定首个英文原因，所有尚未结清的管理观察随即失败；独立实际退出等待器不在这里完成，描述符也不在任何故障路径被关闭。 */
    function fail(reason = "CONTROLLED_COMMAND_OWNER_FAILED") {
        fault ??= reason;
        closed = true;
        for (const member of members) {
            clearTimeout(member.timer);
            member.reject?.(new Error(fault));
        }
    }

    /** 每帧定位追加并同步刷新才允许下一步派生，短写必须取得正进展且遵守唯一 C1 上限；写入或刷新出错立即粘滞失败，不能留下半帧后继续写出看似正常的封存。 */
    function append(type, fields = {}) {
        if (fault || sealed) throw new Error(fault ?? "CONTROLLED_COMMAND_ADMISSION_CLOSED");
        const bytes = Buffer.from(
            `${JSON.stringify({ version: 1, seq: sequence, type, ...fields })}\n`,
        );
        try {
            if (
                sequence >= LIMITS.records ||
                bytes.length > LIMITS.frameBytes ||
                position + bytes.length > LIMITS.fileBytes
            )
                throw new Error();
            let written = 0;
            while (written < bytes.length) {
                const count = writeSync(
                    commandFd,
                    bytes,
                    written,
                    bytes.length - written,
                    position + written,
                );
                if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.length - written)
                    throw new Error();
                written += count;
            }
            fsyncSync(commandFd);
            position += bytes.length;
            sequence++;
        } catch {
            fail("CONTROLLED_COMMAND_JOURNAL_FAILED");
            throw new Error(fault);
        }
    }
    append("OBSERVER_READY", commandBinding);

    return {
        /** 固定角色使用当前受信 Node 执行，INTENT 刷新后立即注册同一对象的全部事件；CLI 独占目标 fd4 和可信 preload，另两个角色不继承观察标记或任何日志描述符。 */
        start(role, command) {
            if (closed || sealed || fault) throw new Error("CONTROLLED_COMMAND_ADMISSION_CLOSED");
            if (role !== roles[members.length] || (role === "cli" && kind !== "TEST"))
                throw new Error("CONTROLLED_COMMAND_ROLE_REJECTED");
            if (members.some((member) => !member.settled))
                throw new Error("CONTROLLED_COMMAND_UNSETTLED");
            if (
                !Number.isSafeInteger(command.timeoutMs) ||
                command.timeoutMs <= 0 ||
                !Array.isArray(command.args) ||
                command.args.some((arg) => typeof arg !== "string") ||
                typeof command.cwd !== "string"
            ) {
                throw new Error("CONTROLLED_COMMAND_CONFIGURATION_INVALID");
            }
            const slot = members.length + 1;
            append("INTENT", { slot });
            const member = {
                slot,
                state: "INTENT",
                settled: false,
                actualExit: false,
                stopped: false,
            };
            members.push(member);
            const env = { ...command.env };
            delete env.VERIQ_CHILD_OBSERVER;
            const cli = role === "cli";
            if (cli) env.VERIQ_CHILD_OBSERVER = JSON.stringify({ ...cliBinding, fd: 4 });
            let child;
            try {
                child = spawn(
                    process.execPath,
                    cli ? ["--import", preload, ...command.args] : command.args,
                    {
                        cwd: command.cwd,
                        env,
                        stdio: cli ? ["ignore", "ignore", "ignore", "ignore", cliFd] : "ignore",
                    },
                );
            } catch {
                fail("CONTROLLED_COMMAND_ERROR");
                throw new Error(fault);
            }
            member.child = child;
            // 只有 spawn 实际返回原始对象后才创建对外等待器，之前的同步异常直接抛稳定码且保留未结清意图，避免拒绝一个调用方永远拿不到的隐藏 promise 而触发未处理异常。
            let resolveExit;
            let resolveResult;
            const exited = new Promise((resolve) => {
                resolveExit = resolve;
            });
            const result = new Promise((resolve, reject) => {
                resolveResult = resolve;
                member.reject = reject;
            });
            child.once("spawn", () => {
                if (fault) return;
                try {
                    if (
                        member.state !== "INTENT" ||
                        !Number.isSafeInteger(child.pid) ||
                        child.pid <= 0
                    )
                        throw new Error();
                    append("SPAWNED", { slot, pid: child.pid });
                    member.state = "SPAWNED";
                } catch {
                    fail("CONTROLLED_COMMAND_JOURNAL_FAILED");
                }
            });
            child.on("error", () => fail("CONTROLLED_COMMAND_ERROR"));
            child.once("exit", (code, signal) => {
                member.actualExit = true;
                clearTimeout(member.timer);
                resolveExit({ code, signal });
                if (fault) return;
                try {
                    if (member.state !== "SPAWNED") throw new Error();
                    append("EXITED", { slot, exitCode: code, signal });
                    member.state = "EXITED";
                } catch {
                    fail("CONTROLLED_COMMAND_JOURNAL_FAILED");
                    return;
                }
                if (signal !== null && (cli || !member.stopped)) {
                    fail("CONTROLLED_COMMAND_EXIT_REJECTED");
                    return;
                }
                void (async () => {
                    if (cli) {
                        const final = await member.observer.verifyFinal();
                        if (!final.ok) {
                            fail("CONTROLLED_COMMAND_CLI_INVALID");
                            return;
                        }
                    }
                    if (fault) return;
                    member.settled = true;
                    resolveResult({ exitCode: code, signal });
                })();
            });
            if (cli) {
                try {
                    member.observer = trackObservedCli(child, {
                        journalFd: cliFd,
                        expectedBinding: cliBinding,
                    });
                } catch {
                    fail("CONTROLLED_COMMAND_CLI_INVALID");
                }
            }
            if (!fault)
                member.timer = setTimeout(() => {
                    fail("CONTROLLED_COMMAND_TIMEOUT");
                    child.kill("SIGKILL");
                }, command.timeoutMs);
            return { child, exited, result };
        },

        /** 同代取消先关闭准入且只对仍然存活的原始对象操作，CLI 必须先取得共享观察器授权才发 SIGINT；错误绑定不产生任何副作用，已经发生的退出也不能补授取消。 */
        requestStop(value) {
            let snapshot;
            try {
                snapshot = validateBinding(validateBinding(value));
            } catch {
                throw new Error("CONTROLLED_COMMAND_CANCELLATION_REJECTED");
            }
            if (JSON.stringify(snapshot) !== JSON.stringify(commandBinding))
                throw new Error("CONTROLLED_COMMAND_CANCELLATION_REJECTED");
            if (cancelled) return;
            closed = true;
            cancelled = true;
            const member = members.at(-1);
            if (
                !member ||
                !member.child ||
                member.actualExit ||
                member.child.exitCode !== null ||
                member.child.signalCode !== null
            )
                return;
            if (member.observer) {
                try {
                    member.observer.authorizeCancellation(cliBinding);
                } catch {
                    fail("CONTROLLED_COMMAND_CANCELLATION_REJECTED");
                    throw new Error("CONTROLLED_COMMAND_CANCELLATION_REJECTED");
                }
            }
            member.stopped = true;
            if (!member.child.kill("SIGINT")) fail("CONTROLLED_COMMAND_ERROR");
        },

        /** Worker 的断连或未捕获故障只能提交固定管理失败，不允许调用方拼接第三方输出或任意错误文本；此方法不伪造命令退出，也不接管借入文件的关闭责任。 */
        fail() {
            fail();
        },

        /** 所有实际命令及 CLI 最终日志均结清后才追加唯一封存，再从原 FD 定位读取交给唯一 C1 验证器；前缀可以为空但未结清意图、故障或封存后启动都不能获得成功。 */
        seal() {
            if (fault) throw new Error(fault);
            if (sealed) throw new Error("CONTROLLED_COMMAND_ADMISSION_CLOSED");
            if (members.some((member) => !member.actualExit || !member.settled))
                throw new Error("CONTROLLED_COMMAND_UNSETTLED");
            closed = true;
            append("SEAL");
            sealed = true;
            try {
                const before = inspectJournalFd(commandFd);
                if (
                    before.dev !== commandIdentity.dev ||
                    before.ino !== commandIdentity.ino ||
                    before.size !== BigInt(position)
                )
                    throw new Error();
                const bytes = Buffer.alloc(position);
                let read = 0;
                while (read < bytes.length) {
                    const count = readSync(commandFd, bytes, read, bytes.length - read, read);
                    if (count <= 0) throw new Error();
                    read += count;
                }
                const after = inspectJournalFd(commandFd);
                if (
                    before.size !== after.size ||
                    before.mtimeNs !== after.mtimeNs ||
                    before.ctimeNs !== after.ctimeNs ||
                    readSync(commandFd, Buffer.alloc(1), 0, 1, position) !== 0
                )
                    throw new Error();
                return validateJournal(bytes, commandBinding);
            } catch {
                fail("CONTROLLED_COMMAND_JOURNAL_FAILED");
                throw new Error(fault);
            }
        },
    };
}
