/**
 * 本文件按真实平台分派 Attempt 监督器：Linux 保持原有子收割守护与 ECHILD 证明，Windows 使用独立 Job 守护；两条路径都只有在可信排空证明成立后才能认定进程已停止并释放容量。
 * 未知进程必须隔离容量。
 */

import { readFileSync, statSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { access, chmod, mkdir, readFile, rename, writeFile, open } from "node:fs/promises";
import { constants } from "node:fs";
import { constants as osConstants } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Readable, Writable } from "node:stream";
import type { ProcessStopScope } from "@veriq/contracts";
import { ProcessRecords } from "./records.ts";
import { WindowsProcesses } from "./windows-processes.ts";
/**
 * 停止回执分别记录是否已确认与实际核验的进程范围，缺失范围保持未声明；新范围只能由本次平台证明或持久未派生状态产生，读取旧回执不会补写或升级其保证。
 */
export interface StopReceipt {
    attemptId: string;
    processStopped: boolean;
    processStopScope?: ProcessStopScope;
    reason: string;
    stoppedAt: string;
}
interface Journal {
    uid: number;
    attemptId: string;
    nonce: string;
    pid?: number;
    startTime?: string;
    guardianPid?: number;
    guardianStartTime?: string;
    state: "SPAWNING" | "RUNNING" | "STOPPED";
}
/**
 * 公开接口 Command 描述业务工作进程启动命令：含可执行文件、参数、工作目录与环境变量：由监督器交给原生守护进程启动。
 */
export interface Command {
    executable: string;
    args: string[];
    cwd: string;
    env?: Record<string, string>;
}
/**
 * 公开接口 OwnedProcess 暴露业务 worker 的 pid 与 IPC 通道：exited 等待退出码：firstLine/send 用于协议握手。
 */
export interface OwnedProcess {
    /** 这里公开业务工作进程的真实 PID，原生守护拥有另外的 PID 与进程组；停止证明会同时绑定两者，调用方不能把 IPC 子进程句柄中的守护身份误作业务工作进程身份。 */
    pid: number;
    exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
    firstLine(): Promise<string>;
    send(message: unknown): void;
    child: ChildProcess;
}
interface Proc {
    uid: number;
    pid: number;
    group: number;
    startTime: string;
    state: string;
}
function inspect(pid: number): Proc | undefined {
    try {
        const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
        const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
        return {
            uid: statSync(`/proc/${pid}`).uid,
            pid,
            state: fields[0]!,
            group: Number(fields[2]),
            startTime: fields[19]!,
        };
    } catch (error) {
        if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
        throw error;
    }
}
const launcher = fileURLToPath(
    new URL(
        process.platform === "win32"
            ? "../../build/Release/veriq_guardian.exe"
            : "../../build/veriq_runner",
        import.meta.url,
    ),
);
/**
 * 公开类 ProcessSupervisor 负责 Attempt 进程生命周期：启动原生守护并解读排空证明：terminateAttempt 在未排空时隔离容量。
 */
export class ProcessSupervisor {
    private live = new Map<string, OwnedProcess>();
    private stopping = new Map<string, Promise<StopReceipt>>();
    private windows: WindowsProcesses | undefined;
    /** 安装宿主只能传入完整库存已核验的 guardian 路径，开发调用默认保持原目录；增加路径参数不改变持久身份日志、START 门或排空证明，无法访问所选二进制时仍在创建进程之前失败。 */
    constructor(
        private directory: string,
        private graceMs = 500,
        private launcherPath = launcher,
    ) {
        if (process.platform === "win32")
            this.windows = new WindowsProcesses(directory, launcherPath);
    }
    private path(id: string) {
        if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("INVALID_ATTEMPT_ID");
        return join(this.directory, `${id}.process.json`);
    }
    private proofPath(id: string) {
        this.path(id);
        return join(this.directory, `${id}.drained.json`);
    }
    private async save(journal: Journal) {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await chmod(this.directory, 0o700);
        const path = this.path(journal.attemptId),
            temporary = `${path}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(journal), {
            mode: 0o600,
            flag: "wx",
            flush: true,
        });
        await rename(temporary, path);
        const directory = await open(this.directory, "r");
        try {
            await directory.sync();
        } finally {
            await directory.close();
        }
    }
    /**
     * 公开方法 start 先选择平台实现并写入进程日志，再拉起受信任的原生守护等待 READY 与 worker 身份校验通过；未支持的平台和重复 Attempt 都在业务执行前失败，不能绕过平台所有权协议。
     */
    async start(id: string, command: Command): Promise<OwnedProcess> {
        if (this.windows) return this.windows.start(id, command);
        if (process.platform !== "linux") throw new Error("UNSUPPORTED_PROCESS_PLATFORM");
        if (this.live.has(id)) throw new Error("PROCESS_ALREADY_RUNNING");
        // 启动前只检查安装宿主交入的固定守护路径是否可执行，业务 Job 无权选择该程序；缺少已构建组件时直接失败，不能通过搜索全局工具或临时编译改变发行组件身份。
        try {
            await access(this.launcherPath, constants.X_OK);
        } catch {
            throw new Error("NATIVE_LAUNCHER_REQUIRED");
        }
        try {
            await readFile(this.path(id));
            throw new Error("PROCESS_JOURNAL_EXISTS");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const journal: Journal = {
            uid: process.getuid!(),
            attemptId: id,
            nonce: randomUUID(),
            state: "SPAWNING",
        };
        await this.save(journal);
        const child = spawn(
            this.launcherPath,
            [
                this.proofPath(id),
                journal.nonce,
                String(this.graceMs),
                command.executable,
                ...command.args,
            ],
            {
                cwd: command.cwd,
                detached: true,
                stdio: ["ignore", "pipe", "pipe", "ipc", "pipe", "pipe"],
                env: {
                    PATH: "/usr/bin:/bin",
                    LANG: "C.UTF-8",
                    ...command.env,
                    VERIQ_PROCESS_NONCE: journal.nonce,
                },
            },
        );
        const descriptors: readonly (Readable | Writable | null | undefined)[] = child.stdio;
        const control = descriptors[5],
            status = descriptors[4];
        if (!(control instanceof Writable) || !(status instanceof Readable)) {
            child.kill("SIGTERM");
            throw new Error("INVALID_GUARDIAN_CHANNEL");
        }
        control.on("error", () => {});
        let resolveLine!: (line: string) => void, rejectLine!: (error: Error) => void;
        const line = new Promise<string>((resolve, reject) => {
            resolveLine = resolve;
            rejectLine = reject;
        });
        void line.catch(() => {});
        let output = "",
            bytes = 0;
        const overflow = () => {
            rejectLine(new Error("PROCESS_OUTPUT_LIMIT"));
            control.write("STOP\n");
        };
        child.stdout!.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 65536) {
                overflow();
                return;
            }
            output += chunk.toString();
            if (output.includes("\n")) {
                resolveLine(output.slice(0, output.indexOf("\n")));
                output = "";
            }
        });
        child.stderr!.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 65536) overflow();
        });
        let ready!: (pid: number) => void, failed!: (error: Error) => void;
        const started = new Promise<number>((resolve, reject) => {
            ready = resolve;
            failed = reject;
        });
        let exited!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
        const workerExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
            (resolve) => {
                exited = resolve;
            },
        );
        let statusBuffer = "",
            statusBytes = 0,
            sawReady = false,
            sawExit = false;
        status.on("data", (chunk: Buffer) => {
            statusBytes += chunk.length;
            if (statusBytes > 4096) {
                failed(new Error("INVALID_GUARDIAN_PROTOCOL"));
                control.write("STOP\n");
                return;
            }
            statusBuffer += chunk.toString();
            while (statusBuffer.includes("\n")) {
                const end = statusBuffer.indexOf("\n"),
                    record = statusBuffer.slice(0, end);
                statusBuffer = statusBuffer.slice(end + 1);
                try {
                    const value = JSON.parse(record);
                    if (
                        value.type === "READY" &&
                        !sawReady &&
                        Number.isSafeInteger(value.workerPid) &&
                        value.workerPid > 1
                    ) {
                        sawReady = true;
                        ready(value.workerPid);
                    } else if (
                        value.type === "EXIT" &&
                        sawReady &&
                        !sawExit &&
                        ((Number.isInteger(value.code) &&
                            value.code >= 0 &&
                            value.code <= 255 &&
                            value.signal === null) ||
                            (value.code === null &&
                                Number.isInteger(value.signal) &&
                                value.signal > 0 &&
                                value.signal < 128))
                    ) {
                        sawExit = true;
                        const signal =
                            value.signal === null
                                ? null
                                : (Object.entries(osConstants.signals).find(
                                      ([, number]) => number === value.signal,
                                  )?.[0] as NodeJS.Signals | undefined);
                        exited({ code: value.code, signal: signal ?? null });
                    } else throw new Error("INVALID_GUARDIAN_PROTOCOL");
                } catch {
                    failed(new Error("INVALID_GUARDIAN_PROTOCOL"));
                    control.write("STOP\n");
                }
            }
        });
        child.once("error", () => failed(new Error("NATIVE_LAUNCHER_FAILED")));
        child.once("exit", (_code, signal) => {
            failed(new Error("GUARDIAN_EXITED_BEFORE_READY"));
            rejectLine(new Error("PROCESS_NO_OUTPUT"));
            exited({ code: null, signal });
        });
        const startup = setTimeout(() => {
            failed(new Error("GUARDIAN_START_TIMEOUT"));
            control.end();
        }, 5000);
        try {
            journal.pid = await started;
            journal.guardianPid = child.pid!;
            const worker = inspect(journal.pid),
                guardian = inspect(journal.guardianPid);
            if (!worker || !guardian || worker.uid !== journal.uid || guardian.uid !== journal.uid)
                throw new Error("PROCESS_IDENTITY_UNKNOWN");
            journal.startTime = worker.startTime;
            journal.guardianStartTime = guardian.startTime;
            journal.state = "RUNNING";
            await this.save(journal);
            const owned: OwnedProcess = {
                pid: journal.pid,
                child,
                exited: workerExit,
                firstLine: () => line,
                send: (message) => {
                    if (child.connected)
                        child.send(message as import("node:child_process").Serializable);
                },
            };
            this.live.set(id, owned);
            // 原生守护持有工作进程启动门，只有工作进程与守护的双身份都已持久化后才发送 START；即使待执行的是可信 Node 代码，也不能在恢复日志落盘之前开始运行。
            control.write("START\n");
            return owned;
        } catch (error) {
            control.end();
            throw error;
        } finally {
            clearTimeout(startup);
        }
    }
    /**
     * 公开方法 isRunning 根据 /proc 状态判断 pid 是否仍为非僵尸存活进程：供停机路径确认业务 worker 去向。
     */
    async isRunning(pid: number) {
        if (this.windows) return this.windows.isRunning(pid);
        const proc = inspect(pid);
        return !!proc && !["Z", "X"].includes(proc.state);
    }
    /**
     * 公开方法 active 返回当前仍登记为存活的 Attempt 标识列表：供恢复扫描与容量核算使用（active）（active）。
     */
    active() {
        return this.windows ? this.windows.active() : [...this.live.keys()];
    }
    /**
     * 公开方法 terminateAttempt 请求守护进程停机并等待排空证明：缺少 ECHILD 证明则 processStopped 为 false。
     * 恢复路径据此隔离未知进程容量。
     */
    terminateAttempt(id: string, reason: string): Promise<StopReceipt> {
        if (this.windows) return this.windows.terminateAttempt(id, reason);
        const existing = this.stopping.get(id);
        if (existing) return existing;
        const operation = this.stop(id, reason).finally(() => this.stopping.delete(id));
        this.stopping.set(id, operation);
        return operation;
    }
    /** 迁移观察只接受已经持久化的停止状态、完整双进程身份和真实排空证明，并再次核验守护确已退出；该接口不发信号、不保存状态、不释放执行容量，缺失或无法解析的私有记录只会返回未确认。 */
    async confirmStopped(id: string): Promise<boolean> {
        if (this.windows) return this.windows.confirmStopped(id);
        let records: ProcessRecords | undefined;
        try {
            this.path(id);
            records = await ProcessRecords.open(this.directory);
            if (!records) return false;
            const journal = (await records.read(`${id}.process.json`, 2048)) as Journal;
            if (
                !journal ||
                journal.attemptId !== id ||
                journal.uid !== process.getuid!() ||
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
            return await this.provedStopped(journal);
        } catch {
            return false;
        } finally {
            await records?.close();
        }
    }
    private async hasProof(journal: Journal): Promise<boolean> {
        let records: ProcessRecords | undefined;
        try {
            records = await ProcessRecords.open(this.directory);
            if (!records) return false;
            const proof = (await records.read(`${journal.attemptId}.drained.json`, 2048)) as Record<
                string,
                unknown
            >;
            return (
                proof.version === 1 &&
                proof.state === "DRAINED" &&
                proof.nonce === journal.nonce &&
                proof.uid === journal.uid &&
                proof.guardianPid === journal.guardianPid &&
                proof.guardianStartTime === journal.guardianStartTime &&
                proof.workerPid === journal.pid &&
                proof.workerStartTime === journal.startTime
            );
        } catch {
            return false;
        } finally {
            await records?.close();
        }
    }
    private async provedStopped(journal: Journal): Promise<boolean> {
        if (!(await this.hasProof(journal))) return false;
        const guardian = inspect(journal.guardianPid!);
        return (
            !guardian ||
            guardian.startTime !== journal.guardianStartTime ||
            ["Z", "X"].includes(guardian.state)
        );
    }
    private releaseHandles(id: string) {
        const owned = this.live.get(id);
        if (!owned) return;
        for (const stream of owned.child.stdio) stream?.destroy();
        if (owned.child.connected) owned.child.disconnect();
        owned.child.unref();
        this.live.delete(id);
    }
    private async stop(id: string, reason: string): Promise<StopReceipt> {
        /** 范围仅随本次真实排空成功分支声明，所有身份、nonce 与原生证明核验仍在下方完成；失败回执不借根进程消失补成全后代保证，旧证明本次重新核验后才生成新的明确范围。 */
        const receipt = (processStopped: boolean, why = reason): StopReceipt => ({
            attemptId: id,
            processStopped,
            ...(processStopped ? { processStopScope: "FULL_DESCENDANT_TREE" as const } : {}),
            reason: why,
            stoppedAt: new Date().toISOString(),
        });
        let journal: Journal;
        try {
            journal = JSON.parse(await readFile(this.path(id), "utf8"));
        } catch {
            return receipt(false, "UNKNOWN_PROCESS");
        }
        if (
            journal.attemptId !== id ||
            !journal.nonce ||
            journal.uid !== process.getuid!() ||
            !journal.pid ||
            !journal.startTime ||
            !journal.guardianPid ||
            !journal.guardianStartTime
        )
            return receipt(false, "UNKNOWN_PROCESS");
        const confirmed = async (): Promise<StopReceipt | undefined> => {
            try {
                if (!(await this.provedStopped(journal))) return;
                journal.state = "STOPPED";
                await this.save(journal);
                this.releaseHandles(id);
                return receipt(true);
            } catch {
                return;
            }
        };
        const alreadyStopped = await confirmed();
        if (alreadyStopped) return alreadyStopped;
        try {
            const worker = inspect(journal.pid),
                guardian = inspect(journal.guardianPid);
            if (worker && (worker.uid !== journal.uid || worker.startTime !== journal.startTime))
                return receipt(false, "PROCESS_IDENTITY_CHANGED");
            if (!guardian || ["Z", "X"].includes(guardian.state)) {
                // 首次证明文件观察可能早于守护完成刷新和退出，这里再次观察原有交接窗口；仍必须匹配完整排空证明和守护身份，不能因为工作进程或守护先消失就宣称整棵树已停止。
                const drained = await confirmed();
                if (drained) return drained;
                // 对已知工作进程的尽力停止无法证明失去守护的后代树已经排空，因此即使该 PID 的退出已被观察也必须保留不确定回执；后续恢复只能依赖原始守护生成的可信证明。
                if (worker && worker.group === journal.pid) process.kill(-worker.group, "SIGKILL");
                this.releaseHandles(id);
                return receipt(false, "CONTAINMENT_LOST");
            }
            if (guardian.uid !== journal.uid || guardian.startTime !== journal.guardianStartTime)
                return receipt(false, "PROCESS_IDENTITY_UNKNOWN");
            if (
                !readFileSync(`/proc/${guardian.pid}/environ`)
                    .toString()
                    .split("\0")
                    .includes(`VERIQ_PROCESS_NONCE=${journal.nonce}`)
            ) {
                const drained = await confirmed();
                if (drained) return drained;
                return receipt(false, "PROCESS_IDENTITY_UNKNOWN");
            }
            process.kill(guardian.pid, "SIGUSR1");
            const deadline = performance.now() + this.graceMs + 2000;
            while (performance.now() < deadline) {
                if (await this.provedStopped(journal)) {
                    journal.state = "STOPPED";
                    await this.save(journal);
                    this.releaseHandles(id);
                    return receipt(true);
                }
                const current = inspect(guardian.pid);
                if (!current || ["Z", "X"].includes(current.state)) break;
                if (current.uid !== journal.uid || current.startTime !== journal.guardianStartTime)
                    break;
                await delay(20);
            }
            if (await this.provedStopped(journal)) {
                journal.state = "STOPPED";
                await this.save(journal);
                this.releaseHandles(id);
                return receipt(true);
            }
            this.releaseHandles(id);
            return receipt(false, "PROCESS_STOP_UNCONFIRMED");
        } catch {
            const drained = await confirmed();
            if (drained) return drained;
            this.releaseHandles(id);
            return receipt(false, "PROCESS_IDENTITY_UNKNOWN");
        }
    }
}
