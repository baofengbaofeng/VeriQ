/** Darwin 后端只拥有本次真实创建的 BrowserServer 与 outer 原始 ChildProcess，所有停止结论都来自同对象 exit
 * 和完整私有封存日志；持久意图先于任何派生，错误粘滞保留隔离，恢复读取不重建
 * 活句柄、不扫描 PID，也不发布任意后代排空保证。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { chromium, type BrowserServer } from "playwright-core";
import type { DarwinPrivateDirectory, DarwinPrivateFile } from "../native/darwin.ts";
import type { Command, OwnedProcess, StopReceipt } from "./processes.ts";
import { ProcessRecords } from "./records.ts";
import {
    requireDarwinSource,
    type DarwinControlledLaunch,
    type DarwinLaunchContext,
    type DarwinSourceCapability,
    type DarwinSourceState,
} from "./darwin-source.ts";
import { validateBinding, LIMITS } from "./controlled-child-protocol.mjs";
import {
    isControlledProcessMember,
    validateControlledPair,
    verifyControlledJournals,
    type ControlledExitFact,
    type DarwinControlledProof,
    type DarwinProcessRecord,
} from "./darwin-proof.ts";

interface Observation {
    child: ChildProcess;
    exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
    fact?: ControlledExitFact;
}
interface Attempt {
    record: DarwinProcessRecord;
    starting: Promise<OwnedProcess>;
    settled: boolean;
    closed: boolean;
    fault: boolean;
    proved: boolean;
    businessStarted: boolean;
    ready: boolean;
    journalsVerified: boolean;
    ack: Promise<void>;
    acknowledge(): void;
    outer?: Observation;
    chrome?: Observation;
    server?: BrowserServer;
    records?: DarwinPrivateDirectory;
    directories: DarwinPrivateDirectory[];
    commandFile?: DarwinPrivateFile;
    cliFile?: DarwinPrivateFile;
}

/** 固定身份、有限输出和当前 IPC 对象共同限定 READY 与取消 ACK，错误只写入内存故障位而不复制不受信内容到日志；
 * 即使之后实际退出，已经发生的观察错误仍不会被业务成功或重试停止覆盖。
 */
function sameBinding(value: unknown, expected: DarwinProcessRecord["commandBinding"]): boolean {
    try {
        return JSON.stringify(validateBinding(value)) === JSON.stringify(expected);
    } catch {
        return false;
    }
}

/** 每次实际对象返回后立即同步登记 exit 与 error，已有退出字段表示错过观察而不是允许补登记；exited 永远只由这个对象的
 * exit 事件完成，error 和 deadline 都不能使它伪装成已经结束。
 */
function observe(entry: Attempt, child: ChildProcess, browser: boolean): Observation {
    let finish!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
    const observation: Observation = {
        child,
        exited: new Promise((resolve) => {
            finish = resolve;
        }),
    };
    if (
        !Number.isSafeInteger(child.pid) ||
        child.pid! < 1 ||
        child.exitCode !== null ||
        child.signalCode !== null
    )
        entry.fault = true;
    child.on("error", () => {
        entry.fault = true;
    });
    child.once("exit", (code, signal) => {
        observation.fact = { pid: child.pid!, code, signal, observed: true };
        if (browser ? !entry.record.browserStopAuthorized : !entry.ready) entry.fault = true;
        finish({ code, signal });
    });
    return observation;
}

/** 所有异步等待共享调用方给定的绝对期限，不能把多个相对超时串联成更长的停止预算；超时只拒绝等待且不改变真实对象退出事
 * 实，调用方继续持有对象并在同一停止路径执行保守终止和隔离。
 */
async function before<T>(promise: Promise<T>, deadline: number): Promise<T> {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error("DARWIN_CONTROLLED_TIMEOUT");
    let timer!: ReturnType<typeof setTimeout>;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("DARWIN_CONTROLLED_TIMEOUT")), remaining);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/** 实际后端可以没有源码启动能力而只承担已提交历史的读取，带能力时必须消费私有品牌原对象；同一实例保留失败和成功
 * Attempt 的终态，禁止重新使用旧意图或把未知容量随对象暂时消失而释放。
 */
export class DarwinProcesses {
    private source?: DarwinSourceState;
    private attempts = new Map<string, Attempt>();
    private stopping = new Map<string, Promise<StopReceipt>>();
    /** 构造只登记可选私有品牌而不创建文件或查询进程，没有源码能力的实例保持纯历史观察用途；安装角色仍会由原有 B loader
     * 拒绝，调用者不能通过恢复持久 PID 或伪造配置重新获得启动与信号发送权限。
     */
    constructor(
        private directory: string,
        capability?: DarwinSourceCapability,
    ) {
        if (capability !== undefined) this.source = requireDarwinSource(capability);
    }

    /** 启动在第一次 await 之前同步占用 Attempt 身份并关闭重复准入，generation 来自可信宿主既有 fence；
     * 随后的任何持久化、浏览器或准备失败都保留同一个未知条目，不会借异常名称返回没有派生。
     */
    start(id: string, command: Command, launch?: DarwinControlledLaunch): Promise<OwnedProcess> {
        if (!this.source) throw new Error("UNSUPPORTED_PROCESS_PLATFORM");
        if (
            !launch ||
            !["TEST", "VALIDATE", "CLEANUP"].includes(launch.kind) ||
            !Number.isSafeInteger(launch.ownerGeneration) ||
            launch.ownerGeneration < 1 ||
            typeof launch.prepare !== "function"
        )
            throw new Error("DARWIN_CONTROLLED_LAUNCH_REQUIRED");
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))
            throw new Error("INVALID_ATTEMPT_ID");
        if (
            command.executable !== this.source!.nodeExecutable ||
            !Array.isArray(command.args) ||
            command.args.some((arg) => typeof arg !== "string")
        )
            throw new Error("DARWIN_SOURCE_COMMAND_REJECTED");
        if (launch.headless !== undefined && typeof launch.headless !== "boolean")
            throw new Error("INVALID_BROWSER_MODE");
        if (
            launch.downloadsPath !== undefined &&
            (typeof launch.downloadsPath !== "string" ||
                Buffer.byteLength(launch.downloadsPath) > 4096 ||
                launch.downloadsPath !== join(command.cwd, "downloads"))
        )
            throw new Error("DARWIN_DOWNLOAD_DIRECTORY_INVALID");
        if (this.attempts.has(id)) throw new Error("PROCESS_ALREADY_RUNNING");
        if (this.stopping.has(id)) throw new Error("DARWIN_ATTEMPT_STOPPING");
        const binding = Object.freeze(
            validateBinding({
                version: 1,
                attemptId: id,
                ownerGeneration: launch.ownerGeneration,
                nonce: randomBytes(32).toString("hex"),
                commandSlot: randomUUID(),
            }),
        );
        const cliBinding = Object.freeze(
            validateBinding({ ...binding, commandSlot: randomUUID() }),
        );
        let acknowledge!: () => void;
        const entry: Attempt = {
            record: {
                version: 1,
                platform: "darwin",
                attemptId: id,
                uid: process.getuid!(),
                kind: launch.kind,
                ownerGeneration: binding.ownerGeneration,
                nonce: binding.nonce,
                commandBinding: binding,
                cliBinding,
                state: "SPAWNING",
                outerPlanned: true,
                browserPlanned: launch.kind === "TEST",
                cancellationAuthorized: false,
                browserStopAuthorized: false,
            },
            starting: undefined!,
            settled: false,
            closed: false,
            fault: false,
            proved: false,
            businessStarted: false,
            ready: false,
            journalsVerified: false,
            ack: new Promise((resolve) => {
                acknowledge = resolve;
            }),
            acknowledge: () => acknowledge(),
            directories: [],
        };
        this.attempts.set(id, entry);
        const actual = this.launch(entry, command, launch).finally(() => {
            entry.settled = true;
            if (entry.closed && entry.fault) {
                this.forceHeld(entry);
                this.deferCleanup(entry);
            }
        });
        entry.starting = before(actual, performance.now() + 30000).catch((error: unknown) => {
            const stoppedDuringStart = entry.closed;
            entry.fault = true;
            entry.closed = true;
            this.forceHeld(entry);
            this.deferCleanup(entry);
            if (
                !stoppedDuringStart &&
                error instanceof Error &&
                /^DARWIN_(?:WORKER_(?:READY|PROTOCOL)_|CONTROLLED_TIMEOUT)/.test(error.message)
            )
                throw error;
            throw new Error(
                stoppedDuringStart ? "DARWIN_ATTEMPT_STOPPING" : "DARWIN_CONTROLLED_START_FAILED",
            );
        });
        return entry.starting;
    }

    /** 原子私有发布使用父层已经持有的 B 目录，不先验证字符串路径再重新打开；正式过程和证明都受六万五千字节限制，
     * 发布或父目录刷新不确定性直接传给终结路径，调用者不能自动重试覆盖未知结果。
     */
    private save(entry: Attempt): void {
        entry.records!.replace(
            `${entry.record.attemptId}.process.json`,
            `.${randomUUID()}.tmp`,
            Buffer.from(JSON.stringify(entry.record)),
            65536,
        );
    }
    private admitted(entry: Attempt): void {
        if (entry.closed || entry.fault) throw new Error("DARWIN_ATTEMPT_STOPPING");
    }

    /** 启动意图的独占空成员先保留名称，完整 SPAWNING 原子落盘后才允许 Chrome 或 outer 派生；空保留、
     * 中途日志目录和已存在成员都保持可见未知，绝不删除或覆盖以前的 Attempt 来取得一次新的执行机会
     * 。
     */
    private async launch(
        entry: Attempt,
        command: Command,
        launch: DarwinControlledLaunch,
    ): Promise<OwnedProcess> {
        const source = this.source!,
            id = entry.record.attemptId;
        entry.records = source.native.openPrivateDirectory(this.directory, true);
        const previous = entry.records.entries(8192);
        if (
            previous.overflow ||
            previous.names.some((name) =>
                [`${id}.process.json`, `${id}.controlled.json`, `${id}.drained.json`].includes(
                    name,
                ),
            )
        )
            throw new Error("PROCESS_JOURNAL_EXISTS");
        const reservation = entry.records.createExclusive(`${id}.process.json`);
        reservation.close();
        this.save(entry);
        this.admitted(entry);
        const existing = entry.records.entries(8192);
        if (
            existing.overflow ||
            existing.names.includes(`${id}.controlled.json`) ||
            existing.names.includes(`${id}.drained.json`)
        )
            throw new Error("PROCESS_PROOF_EXISTS");
        const journals = join(dirname(this.directory), "controlled-journals", id);
        const journalDirectory = source.native.openPrivateDirectory(journals, true);
        entry.directories.push(journalDirectory);
        entry.commandFile = journalDirectory.createExclusive("command.jsonl");
        entry.cliFile = journalDirectory.createExclusive("cli.jsonl");
        const work = source.native.openPrivateDirectory(command.cwd, false);
        entry.directories.push(work);
        if (launch.downloadsPath !== undefined)
            entry.directories.push(source.native.openPrivateDirectory(launch.downloadsPath, false));
        let wsEndpoint: string | undefined;
        if (entry.record.browserPlanned) {
            const home = join(journals, "browser-home"),
                temporary = join(journals, "browser-tmp");
            for (const path of [home, temporary])
                entry.directories.push(source.native.openPrivateDirectory(path, true));
            entry.server = await chromium.launchServer({
                executablePath: source.browserExecutable,
                host: "127.0.0.1",
                port: 0,
                chromiumSandbox: true,
                headless: launch.headless ?? true,
                ...(launch.downloadsPath ? { downloadsPath: launch.downloadsPath } : {}),
                timeout: Math.min(30000, source.stopTimeoutMs),
                env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", HOME: home, TMPDIR: temporary },
            });
            entry.chrome = observe(entry, entry.server.process(), true);
            entry.record.chromePid = entry.chrome.child.pid!;
            this.save(entry);
            this.admitted(entry);
            wsEndpoint = entry.server.wsEndpoint();
        }
        let preparing = true;
        const context: DarwinLaunchContext = Object.freeze({
            commandBinding: entry.record.commandBinding,
            cliBinding: entry.record.cliBinding,
            controlled: Object.freeze({
                commandBinding: entry.record.commandBinding,
                cliBinding: entry.record.cliBinding,
                commandJournalFd: 5 as const,
                cliJournalFd: 4 as const,
            }),
            ...(wsEndpoint ? { wsEndpoint } : {}),
            publish: (name: string, bytes: Buffer) => {
                this.admitted(entry);
                if (!preparing) throw new Error("DARWIN_WORK_PREPARATION_CLOSED");
                if (!["invocation.json", "playwright.config.mjs"].includes(name))
                    throw new Error("DARWIN_WORK_MEMBER_INVALID");
                if (!Buffer.isBuffer(bytes) || bytes.length > 65536)
                    throw new Error("DARWIN_WORK_LIMIT");
                work.replace(name, `.${randomUUID()}.tmp`, bytes, 65536);
            },
        });
        try {
            await launch.prepare(context);
        } finally {
            preparing = false;
        }
        this.admitted(entry);
        const env = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", ...command.env };
        delete (env as NodeJS.ProcessEnv).VERIQ_CHILD_OBSERVER;
        const child = spawn(command.executable, command.args, {
            cwd: command.cwd,
            env,
            stdio: ["ignore", "ignore", "ignore", "ipc", entry.cliFile.fd, entry.commandFile.fd],
        });
        entry.outer = observe(entry, child, false);
        entry.record.outerPid = child.pid!;
        let ready!: () => void, fail!: (error: Error) => void;
        const handshake = new Promise<void>((resolve, reject) => {
            ready = resolve;
            fail = reject;
        });
        void handshake.catch(() => {});
        child.on("message", (message: unknown) => {
            const value = message as { type?: unknown; binding?: unknown; pid?: unknown } | null;
            if (
                value?.type === "CONTROLLED_READY" &&
                !entry.ready &&
                value.pid === child.pid &&
                sameBinding(value.binding, entry.record.commandBinding)
            ) {
                entry.ready = true;
                ready();
            } else if (
                value?.type === "CANCEL_ACK" &&
                entry.record.cancellationAuthorized &&
                sameBinding(value.binding, entry.record.commandBinding)
            )
                entry.acknowledge();
            else {
                entry.fault = true;
                fail(new Error("DARWIN_WORKER_PROTOCOL_INVALID"));
            }
        });
        child.on("error", () => fail(new Error("DARWIN_WORKER_READY_FAILED")));
        child.once("exit", () => fail(new Error("DARWIN_WORKER_READY_FAILED")));
        this.save(entry);
        await before(handshake, performance.now() + Math.min(5000, source.stopTimeoutMs));
        this.admitted(entry);
        if (entry.outer.fact) throw new Error("DARWIN_WORKER_READY_FAILED");
        entry.record.state = "RUNNING";
        this.save(entry);
        return {
            pid: child.pid!,
            child,
            exited: entry.outer.exited,
            firstLine: async () => {
                throw new Error("PROCESS_NO_OUTPUT");
            },
            send: (message) => {
                this.admitted(entry);
                if (
                    !message ||
                    typeof message !== "object" ||
                    Object.keys(message).length !== 1 ||
                    (message as { type?: unknown }).type !== "START" ||
                    entry.businessStarted
                )
                    throw new Error("INVALID_WORKER_COMMAND");
                entry.businessStarted = true;
                this.send(entry, { type: "START", binding: entry.record.commandBinding });
            },
        };
    }

    /** IPC 只送往自己保留的 outer 原对象，发送错误会粘滞破坏本次观察而不会回退裸 PID；START 与 CANCEL
     * 的身份都由父层固定添加，外部调用者不能通过 OwnedProcess.send 开放停止期间已
     * 经关闭的业务准入。
     */
    private send(entry: Attempt, message: object): void {
        const child = entry.outer?.child;
        if (!child?.connected) {
            entry.fault = true;
            throw new Error("DARWIN_WORKER_DISCONNECTED");
        }
        child.send(message, (error) => {
            if (error) entry.fault = true;
        });
    }

    /** 活性查询只匹配本次确实保留的原对象，没有对象时明确拒绝而不查询 proc 或对 PID 发送零信号；单对象已经 exit
     * 只回答它的状态，不替代下方整套受控集合停止证明或容量释放。
     */
    async isRunning(pid: number): Promise<boolean> {
        for (const entry of this.attempts.values())
            for (const held of [entry.outer, entry.chrome]) {
                if (held?.child.pid === pid) {
                    if (entry.fault && !held.fact) throw new Error("DARWIN_PROCESS_UNKNOWN");
                    return !held.fact;
                }
            }
        throw new Error("DARWIN_PROCESS_UNKNOWN");
    }

    /** 未知 Attempt 即使其原对象已经退出也继续出现在活动隔离集合，只有本实例完成持久正证明才从容量观察中移除；
     * 终态条目仍保留以拒绝旧 Attempt 重启，并且不从历史状态恢复可发信号的对象。
     */
    active(): string[] {
        return [...this.attempts].filter(([, entry]) => !entry.proved).map(([id]) => id);
    }

    /** 停止去重与关闭准入都发生在返回 promise 以前，正在准备或等待 launchServer 的启动随后必须重新检查关闭位；
     * 所有等待共用同一绝对期限，重复原因不能重新授予授权、延长期限或覆盖先前观察故障。
     */
    terminateAttempt(
        id: string,
        reason: string,
        deadlineMonotonicMs?: number,
    ): Promise<StopReceipt> {
        const existing = this.stopping.get(id);
        if (existing) return existing;
        const entry = this.attempts.get(id);
        if (entry) entry.closed = true;
        /** 调用者期限来自同一 Node 进程的单调时钟，坏参数和已耗尽预算都会立即关闭准入并保守终止；首次 promise
         * 与期限永久绑定本次 Attempt，重复停止不能刷新三十秒预算或把已经观察到的未知状态变成正常成
         * 功。
         */
        const now = performance.now();
        const supplied =
            deadlineMonotonicMs === undefined
                ? Infinity
                : typeof deadlineMonotonicMs === "number" && Number.isFinite(deadlineMonotonicMs)
                  ? deadlineMonotonicMs
                  : now;
        const deadline = Math.min(now + (this.source?.stopTimeoutMs ?? 30000), supplied);
        if (entry && deadline <= now) {
            entry.fault = true;
            this.forceHeld(entry);
        }
        const operation = this.stop(id, entry, reason, deadline);
        this.stopping.set(id, operation);
        return operation;
    }

    /** 历史确认只读取有限正式私有成员并检查平台专用配对，任何混入 drained、缺失、staging、超额或损坏都返回 false；
     * 读取不创建目录、不修权限、不删除残留，也不会从曾经记录的 PID 重新获得实际进程所有权。
     */
    async confirmStopped(id: string): Promise<boolean> {
        let records: ProcessRecords | undefined;
        try {
            if (this.attempts.get(id)?.fault) return false;
            if (!/^[a-f0-9-]{36}$/.test(id)) return false;
            records = await ProcessRecords.open(this.directory);
            if (!records) return false;
            const names = new Set(await records.names(8192));
            if ([...names].some((name) => !isControlledProcessMember(name))) return false;
            if (
                !names.has(`${id}.process.json`) ||
                !names.has(`${id}.controlled.json`) ||
                names.has(`${id}.drained.json`)
            )
                return false;
            return validateControlledPair(
                await records.read(`${id}.process.json`, 65536),
                await records.read(`${id}.controlled.json`, 65536),
                { attemptId: id, uid: process.getuid!() },
            );
        } catch {
            return false;
        } finally {
            try {
                await records?.close();
            } catch {
                return false;
            }
        }
    }

    /** 截止时间或管理错误后的尽力终止只使用仍保留的原对象与公共 BrowserServer.kill，不会恢复进程树或扫描任意后代；
     * 调用不代表实际 exit，所有观察器和文件拥有者仍留在 Attempt 中直到事实能够结清。
     */
    private forceHeld(entry: Attempt): void {
        if (entry.outer && !entry.outer.fact) entry.outer.child.kill("SIGKILL");
        if (entry.server && entry.chrome && !entry.chrome.fact)
            void entry.server.kill().catch(() => {
                entry.fault = true;
            });
    }

    /** 关闭 File 仅发生于原始写者退出以后且最终快照已经读取，目录清理也只关闭本次拥有者而不删除证据；
     * 错误路径若仍可能有迟到启动或写者就继续持有这些对象，不能提前关闭借出的数字描述符冒充容量释放。
     */
    private closeFiles(entry: Attempt): void {
        if (entry.outer && !entry.journalsVerified)
            throw new Error("DARWIN_JOURNAL_WRITER_UNKNOWN");
        entry.commandFile?.close();
        delete entry.commandFile;
        entry.cliFile?.close();
        delete entry.cliFile;
        for (const directory of entry.directories.splice(0)) directory.close();
    }

    /** outer 和 Chrome 退出不能单独证明借出 CLI 日志的写者已经退出，故原 outer 存在但 C1 最终闭合尚未核验时保留全部
     * File 与目录锚点；当前源码切片没有猜测孤儿生命周期的恢复能力，后续真实退出
     * 也不能自动绕过这道保留条件。
     */
    private deferCleanup(entry: Attempt): void {
        if (!entry.settled || (entry.outer && !entry.journalsVerified)) return;
        void Promise.all([entry.outer?.exited, entry.chrome?.exited]).then(() => {
            try {
                this.closeFiles(entry);
                entry.records?.close();
                delete entry.records;
            } catch {
                entry.fault = true;
            }
        });
    }

    /** 停止先持久取消再等待真实 outer 及两份封存，Chrome 的主动关闭同样先保存授权并等原对象 exit；proof 先于 STOPPED
     * 发布，中断留下的任意半配对仍然不能在重启中恢复正结论，ACK 从来不作为退
     * 出或封存证据。
     */
    private async stop(
        id: string,
        entry: Attempt | undefined,
        reason: string,
        deadline: number,
    ): Promise<StopReceipt> {
        const receipt = (stopped: boolean): StopReceipt => ({
            attemptId: id,
            processStopped: stopped,
            ...(stopped ? { processStopScope: "CONTROLLED_WORKER_BROWSER" as const } : {}),
            reason: stopped ? reason : "PROCESS_STOP_UNCONFIRMED",
            stoppedAt: new Date().toISOString(),
        });
        if (!entry || entry.proved) return receipt(await this.confirmStopped(id));
        let journals: DarwinControlledProof["journals"] | undefined;
        try {
            try {
                await before(entry.starting, deadline);
            } catch {
                entry.fault = true;
            }
            if (entry.outer && !entry.outer.fact) {
                entry.record.cancellationAuthorized = true;
                this.save(entry);
                this.send(entry, { type: "CANCEL", binding: entry.record.commandBinding });
                if (!entry.businessStarted) {
                    await before(entry.ack, deadline);
                    this.send(entry, { type: "START", binding: entry.record.commandBinding });
                }
                await before(entry.outer.exited, deadline);
            }
            if (entry.outer?.fact && entry.commandFile && entry.cliFile) {
                const commands = entry.commandFile.read(LIMITS.fileBytes),
                    cli = entry.cliFile.read(LIMITS.fileBytes);
                if (
                    !commands.equals(entry.commandFile.read(LIMITS.fileBytes)) ||
                    !cli.equals(entry.cliFile.read(LIMITS.fileBytes))
                )
                    throw new Error("DARWIN_JOURNAL_CHANGED");
                journals = verifyControlledJournals(entry.record, commands, cli);
                entry.journalsVerified = true;
            } else entry.fault = true;
        } catch {
            entry.fault = true;
        }
        try {
            if (entry.server && entry.chrome && !entry.chrome.fact) {
                entry.record.browserStopAuthorized = true;
                this.save(entry);
                await before(entry.server.close(), deadline);
                await before(entry.chrome.exited, deadline);
            }
        } catch {
            entry.fault = true;
        }
        if (
            entry.fault ||
            !entry.settled ||
            !entry.outer?.fact ||
            (entry.record.browserPlanned && !entry.chrome?.fact) ||
            !journals ||
            performance.now() >= deadline
        ) {
            entry.fault = true;
            this.forceHeld(entry);
            this.deferCleanup(entry);
            return receipt(false);
        }
        try {
            const {
                version,
                platform,
                attemptId,
                uid,
                kind,
                ownerGeneration,
                nonce,
                commandBinding,
                cliBinding,
            } = entry.record;
            const proof: DarwinControlledProof = {
                version,
                platform,
                attemptId,
                uid,
                kind,
                ownerGeneration,
                nonce,
                commandBinding,
                cliBinding,
                state: "CONTROLLED_STOPPED",
                scope: "CONTROLLED_WORKER_BROWSER",
                outer: entry.outer.fact,
                chrome: entry.chrome?.fact ?? null,
                journals,
            };
            const final = { ...entry.record, state: "STOPPED" as const };
            if (!validateControlledPair(final, proof, { attemptId: id, uid }))
                throw new Error("CONTROLLED_PROOF_INVALID");
            this.closeFiles(entry);
            const reservation = entry.records!.createExclusive(`${id}.controlled.json`);
            reservation.close();
            entry.records!.replace(
                `${id}.controlled.json`,
                `.${randomUUID()}.tmp`,
                Buffer.from(JSON.stringify(proof)),
                65536,
            );
            if (performance.now() >= deadline) throw new Error("DARWIN_CONTROLLED_TIMEOUT");
            entry.record.state = "STOPPED";
            this.save(entry);
            entry.proved = true;
            entry.records!.close();
            delete entry.records;
            return receipt(true);
        } catch {
            entry.fault = true;
            this.deferCleanup(entry);
            return receipt(false);
        }
    }
}
