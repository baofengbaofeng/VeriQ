/** Windows Attempt 监督器把持久身份日志与原生 Job 守护的 START 门相连，业务输出和可信状态分帧处理；停止只接受匹配 SID、nonce、精确创建时间的排空证明，守护消失而无证明时保留隔离状态。 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { windowsNative } from "../native/windows.ts";
import type { Command, OwnedProcess, StopReceipt } from "./processes.ts";

interface Journal {
    attemptId: string;
    nonce: string;
    sid: string;
    state: "SPAWNING" | "RUNNING" | "STOPPED";
    pid?: number;
    startTime?: string;
    guardianPid?: number;
    guardianStartTime?: string;
}
/** Windows 实现保持与 Linux 相同的有限 Attempt 生命周期接口，独立保存每次启动的 Job 身份和退出承诺；恢复停止不能依赖内存映射存在，必须重新检查持久日志和内核对象身份再发出请求。 */
export class WindowsProcesses {
    private live = new Map<string, OwnedProcess>();
    private stopping = new Map<string, Promise<StopReceipt>>();
    constructor(
        private directory: string,
        private launcher: string,
    ) {}
    private path(id: string, proof = false) {
        if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("INVALID_ATTEMPT_ID");
        return join(this.directory, `${id}.${proof ? "drained" : "process"}.json`);
    }
    private async save(journal: Journal) {
        const native = windowsNative();
        native.privatePath(this.directory, true);
        this.path(journal.attemptId);
        native.replacePrivate(
            this.directory,
            `${journal.attemptId}.process.json`,
            `.${randomUUID()}.tmp`,
            JSON.stringify(journal),
        );
    }
    /** 启动先创建私有日志，再让守护挂起并归属 Job；只有 READY 中的双进程身份与内核查询一致且 RUNNING 日志落盘后才允许原生 START，因此取消或宿主死亡不会留下已运行却尚未登记的业务进程。 */
    async start(id: string, command: Command): Promise<OwnedProcess> {
        const native = windowsNative();
        if (this.live.has(id)) throw new Error("PROCESS_ALREADY_RUNNING");
        try {
            native.readPrivateFile(this.path(id), 2048);
            throw new Error("PROCESS_JOURNAL_EXISTS");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const journal: Journal = {
            attemptId: id,
            nonce: randomUUID(),
            sid: native.sid,
            state: "SPAWNING",
        };
        await this.save(journal);
        const child = spawn(
            this.launcher,
            [this.path(id, true), journal.nonce, command.executable, ...command.args],
            {
                cwd: command.cwd,
                env: { ...command.env, VERIQ_WORKER_GATE_NONCE: journal.nonce },
                stdio: ["pipe", "pipe", "pipe"],
                windowsHide: true,
            },
        );
        child.stdin.on("error", () => {});
        const control = (type: string) => child.stdin.write(`${type} ${journal.nonce}\n`);
        let ready!: (value: Record<string, unknown>) => void, fail!: (error: Error) => void;
        const started = new Promise<Record<string, unknown>>((resolve, reject) => {
            ready = resolve;
            fail = reject;
        });
        let first!: (line: string) => void, failLine!: (error: Error) => void;
        const line = new Promise<string>((resolve, reject) => {
            first = resolve;
            failLine = reject;
        });
        void line.catch(() => {});
        let exit!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
        const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
            (resolve) => {
                exit = resolve;
            },
        );
        let buffered = Buffer.alloc(0),
            total = 0,
            output = Buffer.alloc(0),
            sawReady = false,
            sawExit = false;
        const invalid = () => {
            fail(new Error("INVALID_GUARDIAN_PROTOCOL"));
            failLine(new Error("INVALID_GUARDIAN_PROTOCOL"));
            control("STOP");
        };
        child.stdout.on("data", (chunk: Buffer) => {
            total += chunk.length;
            if (total > 140000) {
                invalid();
                return;
            }
            buffered = Buffer.concat([buffered, chunk]);
            while (buffered.includes(10)) {
                const end = buffered.indexOf(10),
                    frame = buffered.subarray(0, end);
                buffered = buffered.subarray(end + 1);
                try {
                    const value = JSON.parse(
                        new TextDecoder("utf-8", { fatal: true }).decode(frame),
                    );
                    if (value.nonce !== journal.nonce) throw new Error("GUARDIAN_NONCE_MISMATCH");
                    if (value.type === "READY" && !sawReady) {
                        sawReady = true;
                        ready(value);
                    } else if (
                        value.type === "OUTPUT" &&
                        sawReady &&
                        !sawExit &&
                        typeof value.hex === "string" &&
                        /^(?:[0-9a-f]{2})+$/.test(value.hex)
                    ) {
                        output = Buffer.concat([output, Buffer.from(value.hex, "hex")]);
                        if (output.length > 65536) throw new Error("PROCESS_OUTPUT_LIMIT");
                        if (output.includes(10))
                            first(
                                new TextDecoder("utf-8", { fatal: true }).decode(
                                    output.subarray(0, output.indexOf(10)),
                                ),
                            );
                    } else if (
                        value.type === "EXIT" &&
                        sawReady &&
                        !sawExit &&
                        Number.isInteger(value.code) &&
                        value.code >= 0 &&
                        value.code <= 0xffffffff
                    ) {
                        sawExit = true;
                        exit({ code: value.code, signal: null });
                    } else throw new Error("INVALID_GUARDIAN_PROTOCOL");
                } catch {
                    invalid();
                }
            }
        });
        let errors = 0;
        child.stderr.on("data", (chunk: Buffer) => {
            errors += chunk.length;
            if (errors > 4096) invalid();
        });
        child.once("error", () => fail(new Error("NATIVE_LAUNCHER_FAILED")));
        child.once("exit", (_code, signal) => {
            fail(new Error("GUARDIAN_EXITED_BEFORE_READY"));
            failLine(new Error("PROCESS_NO_OUTPUT"));
            if (!sawExit) exit({ code: null, signal });
        });
        const timer = setTimeout(() => {
            fail(new Error("GUARDIAN_START_TIMEOUT"));
            child.stdin.end();
        }, 5000);
        try {
            const value = await started;
            if (
                !Number.isSafeInteger(value.workerPid) ||
                Number(value.workerPid) < 1 ||
                value.guardianPid !== child.pid ||
                value.sid !== native.sid
            )
                throw new Error("PROCESS_IDENTITY_UNKNOWN");
            const worker = native.identity(Number(value.workerPid)),
                guardian = native.identity(child.pid!);
            if (
                !worker?.running ||
                !guardian?.running ||
                worker.sid !== native.sid ||
                guardian.sid !== native.sid ||
                worker.startTime !== value.workerStartTime ||
                guardian.startTime !== value.guardianStartTime
            )
                throw new Error("PROCESS_IDENTITY_UNKNOWN");
            Object.assign(journal, {
                pid: value.workerPid,
                startTime: worker.startTime,
                guardianPid: child.pid,
                guardianStartTime: guardian.startTime,
                state: "RUNNING",
            });
            await this.save(journal);
            const owned: OwnedProcess = {
                pid: Number(value.workerPid),
                child,
                exited,
                firstLine: () => line,
                send: (message) => {
                    if (
                        !message ||
                        typeof message !== "object" ||
                        (message as { type?: unknown }).type !== "START"
                    )
                        throw new Error("INVALID_WORKER_COMMAND");
                    control("BUSINESS_START");
                },
            };
            this.live.set(id, owned);
            control("START");
            return owned;
        } catch (error) {
            child.stdin.end();
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }
    /** 查询仅返回本次真实内核进程句柄的运行状态，访问被拒绝或身份不可读时抛出异常而不是当作已停止；业务停止证明仍必须走完整 Job 回执流程，不能把单个 PID 不存在等价为后代排空。 */
    async isRunning(pid: number) {
        return windowsNative().identity(pid)?.running ?? false;
    }
    /** 内存中的活跃 Attempt 只用于宿主状态展示与重复启动保护，恢复流程仍以磁盘日志为准；释放连接不会删除未知日志，也不会把正在隔离的容量转换为可用执行配额。 */
    active() {
        return [...this.live.keys()];
    }
    /** 同一 Attempt 的同时停止请求共享一个有界操作，身份和证明检查的任何失败都返回负回执；只有确认根进程已信号且 Job 为空的守护证明才能把持久状态转为 STOPPED 并释放宿主句柄。 */
    terminateAttempt(id: string, reason: string): Promise<StopReceipt> {
        const existing = this.stopping.get(id);
        if (existing) return existing;
        const operation = this.stop(id, reason).finally(() => this.stopping.delete(id));
        this.stopping.set(id, operation);
        return operation;
    }
    /** 凭据迁移只观察既有停止日志及匹配 SID、nonce 和双进程创建时间的原生排空证明，不向守护发送停止事件；任何私有读取或身份核验失败都保持未确认，不能通过缺失 PID 或人工 STOPPED 文本放行。 */
    async confirmStopped(id: string): Promise<boolean> {
        try {
            const native = windowsNative();
            const journal = JSON.parse(
                native.readPrivateFile(this.path(id), 2048).toString("utf8"),
            ) as Journal;
            if (
                !journal ||
                journal.attemptId !== id ||
                journal.sid !== native.sid ||
                journal.state !== "STOPPED" ||
                typeof journal.nonce !== "string" ||
                !/^[0-9a-f-]{36}$/.test(journal.nonce) ||
                !Number.isSafeInteger(journal.pid) ||
                journal.pid! <= 1 ||
                !Number.isSafeInteger(journal.guardianPid) ||
                journal.guardianPid! <= 1 ||
                typeof journal.startTime !== "string" ||
                !/^[0-9]+$/.test(journal.startTime) ||
                typeof journal.guardianStartTime !== "string" ||
                !/^[0-9]+$/.test(journal.guardianStartTime)
            )
                return false;
            return await this.proof(journal);
        } catch {
            return false;
        }
    }
    private release(id: string) {
        const child = this.live.get(id)?.child;
        for (const stream of child?.stdio ?? []) stream?.destroy();
        child?.unref();
        this.live.delete(id);
    }
    private async proof(journal: Journal) {
        try {
            const path = this.path(journal.attemptId, true);
            const proof = JSON.parse(windowsNative().readPrivateFile(path, 2048).toString("utf8"));
            const guardian = windowsNative().identity(journal.guardianPid!);
            return (
                proof.version === 1 &&
                proof.state === "DRAINED" &&
                proof.nonce === journal.nonce &&
                proof.sid === journal.sid &&
                proof.workerPid === journal.pid &&
                proof.workerStartTime === journal.startTime &&
                proof.guardianPid === journal.guardianPid &&
                proof.guardianStartTime === journal.guardianStartTime &&
                (!guardian || !guardian.running || guardian.startTime !== journal.guardianStartTime)
            );
        } catch {
            return false;
        }
    }
    private async stop(id: string, reason: string): Promise<StopReceipt> {
        const receipt = (processStopped: boolean, why = reason): StopReceipt => ({
            attemptId: id,
            processStopped,
            reason: why,
            stoppedAt: new Date().toISOString(),
        });
        const native = windowsNative();
        let journal: Journal;
        try {
            journal = JSON.parse(native.readPrivateFile(this.path(id), 2048).toString("utf8"));
        } catch {
            return receipt(false, "UNKNOWN_PROCESS");
        }
        if (
            journal.attemptId !== id ||
            journal.sid !== native.sid ||
            !journal.nonce ||
            !journal.pid ||
            !journal.startTime ||
            !journal.guardianPid ||
            !journal.guardianStartTime
        )
            return receipt(false, "UNKNOWN_PROCESS");
        const confirmed = async () => {
            if (!(await this.proof(journal))) return false;
            journal.state = "STOPPED";
            await this.save(journal);
            this.release(id);
            return true;
        };
        try {
            if (await confirmed()) return receipt(true);
            const guardian = native.identity(journal.guardianPid);
            if (!guardian?.running) return receipt(false, "CONTAINMENT_LOST");
            if (guardian.sid !== journal.sid || guardian.startTime !== journal.guardianStartTime)
                return receipt(false, "PROCESS_IDENTITY_CHANGED");
            /** 日志中真实的守护身份不能替代工作进程身份核验，二者必须同时属于当前用户并匹配精确创建时间；原生层还会用同时持有的两个句柄和同一 nonce 打开绑定事件，避免独立真实字段被跨 Attempt 拼接。 */
            const worker = native.identity(journal.pid);
            if (!worker || worker.sid !== journal.sid || worker.startTime !== journal.startTime)
                return receipt(false, "PROCESS_IDENTITY_CHANGED");
            native.signalStop(
                journal.nonce,
                journal.guardianPid,
                journal.guardianStartTime,
                journal.pid,
                journal.startTime,
            );
            const deadline = performance.now() + 3500;
            while (performance.now() < deadline) {
                if (await confirmed()) return receipt(true);
                await delay(20);
            }
            /** 停止请求和等待期限均不能替代排空证明，即便此前核验通过也保留现有守护连接与占用状态；之后再次查询可以接受迟到的真实证明，不能靠关闭输入流造成新的终止副作用来掩盖未知状态。 */
            return receipt(false, "PROCESS_STOP_UNCONFIRMED");
        } catch {
            /** 身份查询或停止事件打开失败不授予关闭活跃守护标准输入的权限，因为管道 EOF 本身会终止整个 Job；保留宿主连接和隔离日志，等待真实所有权恢复后的显式停止与排空证明。 */
            return receipt(false, "PROCESS_IDENTITY_UNKNOWN");
        }
    }
}
