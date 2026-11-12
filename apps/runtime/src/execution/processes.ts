/**
 * 本文件通过 linux veriq_runner 子收割守护进程管理 Attempt：仅在内核 ECHILD 排空证明后才认定进程已停止。
 * 未知进程必须隔离容量。
 */

import { readFileSync, statSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { access, chmod, mkdir, readFile, rename, writeFile, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Readable, Writable } from 'node:stream';
/**
 * 公开接口 StopReceipt 记录 Attempt 停机回执：含 processStopped、原因字符串与 stoppedAt。
 * 供恢复与控制面对账使用。
 */
export interface StopReceipt {
    attemptId: string;
    processStopped: boolean;
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
    state: 'SPAWNING' | 'RUNNING' | 'STOPPED';
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
    /** Business worker identity; the native guardian has a distinct PID/group. */
    pid: number;
    exited: Promise<{code: number | null; signal: NodeJS.Signals | null}>;
    firstLine(): Promise<string>;
    send(message: unknown): void;
    child: ChildProcess;
}
interface Proc { uid: number; pid: number; group: number; startTime: string; state: string }
function inspect(pid: number): Proc | undefined {
    try {
        const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
        return { uid: statSync(`/proc/${pid}`).uid, pid, state: fields[0]!, group: Number(fields[2]), startTime: fields[19]! };
    } catch (error) {
        if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
        throw error;
    }
}
const launcher = fileURLToPath(new URL('../../build/veriq_runner', import.meta.url));
/** Only the kernel subreaper's durable ECHILD proof authorizes positive stop. */
/**
 * 公开类 ProcessSupervisor 负责 Attempt 进程生命周期：启动原生守护并解读排空证明：terminateAttempt 在未排空时隔离容量。
 */
export class ProcessSupervisor {
    private live = new Map<string, OwnedProcess>();
    private stopping = new Map<string, Promise<StopReceipt>>();
    constructor(private directory: string, private graceMs = 500) { }
    private path(id: string) {
        if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('INVALID_ATTEMPT_ID');
        return join(this.directory, `${id}.process.json`);
    }
    private proofPath(id: string) { this.path(id); return join(this.directory, `${id}.drained.json`); }
    private async save(journal: Journal) {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await chmod(this.directory, 0o700);
        const path = this.path(journal.attemptId), temporary = `${path}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(journal), { mode: 0o600, flag: 'wx', flush: true });
        await rename(temporary, path);
        const directory = await open(this.directory, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
    }
    /**
     * 公开方法 start 写入进程日志并拉起 veriq_runner 守护进程：等待 READY 与 worker 身份校验通过。
     * 禁止在非 linux 平台或重复 id 上启动。
     */
    async start(id: string, command: Command): Promise<OwnedProcess> {
        if (process.platform !== 'linux') throw new Error('UNSUPPORTED_PROCESS_PLATFORM');
        if (this.live.has(id)) throw new Error('PROCESS_ALREADY_RUNNING');
        // 固定安装的 Agent 组件路径，绝不能改用 Job 提供路径或运行时编译器回退。
        try { await access(launcher, constants.X_OK); } catch { throw new Error('NATIVE_LAUNCHER_REQUIRED'); }
        try { await readFile(this.path(id)); throw new Error('PROCESS_JOURNAL_EXISTS'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        const journal: Journal = {uid: process.getuid!(), attemptId: id, nonce: randomUUID(), state: 'SPAWNING'};
        await this.save(journal);
        const child = spawn(launcher, [this.proofPath(id), journal.nonce, String(this.graceMs), command.executable, ...command.args], {
            cwd: command.cwd, detached: true,
            stdio: ['ignore', 'pipe', 'pipe', 'ipc', 'pipe', 'pipe'],
            env: {PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', ...command.env, VERIQ_PROCESS_NONCE: journal.nonce},
        });
        const descriptors: readonly (Readable | Writable | null | undefined)[] = child.stdio;
        const control = descriptors[5], status = descriptors[4];
        if (!(control instanceof Writable) || !(status instanceof Readable)) {
            child.kill('SIGTERM');
            throw new Error('INVALID_GUARDIAN_CHANNEL');
        }
        control.on('error', () => {});
        let resolveLine!: (line: string) => void, rejectLine!: (error: Error) => void;
        const line = new Promise<string>((resolve, reject) => {resolveLine = resolve; rejectLine = reject;});
        void line.catch(() => {});
        let output = '', bytes = 0;
        const overflow = () => { rejectLine(new Error('PROCESS_OUTPUT_LIMIT')); control.write('STOP\n'); };
        child.stdout!.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 65536) { overflow(); return; }
            output += chunk.toString();
            if (output.includes('\n')) { resolveLine(output.slice(0, output.indexOf('\n'))); output = ''; }
        });
        child.stderr!.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 65536) overflow(); });
        let ready!: (pid: number) => void, failed!: (error: Error) => void;
        const started = new Promise<number>((resolve, reject) => {ready = resolve; failed = reject;});
        let exited!: (value: {code: number | null; signal: NodeJS.Signals | null}) => void;
        const workerExit = new Promise<{code: number | null; signal: NodeJS.Signals | null}>(resolve => {exited = resolve;});
        let statusBuffer = '', statusBytes = 0, sawReady = false, sawExit = false;
        status.on('data', (chunk: Buffer) => {
            statusBytes += chunk.length;
            if (statusBytes > 4096) { failed(new Error('INVALID_GUARDIAN_PROTOCOL')); control.write('STOP\n'); return; }
            statusBuffer += chunk.toString();
            while (statusBuffer.includes('\n')) {
                const end = statusBuffer.indexOf('\n'), record = statusBuffer.slice(0, end);
                statusBuffer = statusBuffer.slice(end + 1);
                try {
                    const value = JSON.parse(record);
                    if (value.type === 'READY' && !sawReady && Number.isSafeInteger(value.workerPid) && value.workerPid > 1) {
                        sawReady = true; ready(value.workerPid);
                    } else if (value.type === 'EXIT' && sawReady && !sawExit &&
                        ((Number.isInteger(value.code) && value.code >= 0 && value.code <= 255 && value.signal === null) ||
                         (value.code === null && Number.isInteger(value.signal) && value.signal > 0 && value.signal < 128))) {
                        sawExit = true;
                        const signal = value.signal === null ? null : Object.entries(osConstants.signals).find(([,number]) => number === value.signal)?.[0] as NodeJS.Signals | undefined;
                        exited({code: value.code, signal: signal ?? null});
                    } else throw new Error('INVALID_GUARDIAN_PROTOCOL');
                } catch { failed(new Error('INVALID_GUARDIAN_PROTOCOL')); control.write('STOP\n'); }
            }
        });
        child.once('error', () => failed(new Error('NATIVE_LAUNCHER_FAILED')));
        child.once('exit', (_code, signal) => {
            failed(new Error('GUARDIAN_EXITED_BEFORE_READY'));
            rejectLine(new Error('PROCESS_NO_OUTPUT'));
            exited({code: null, signal});
        });
        const startup = setTimeout(() => {failed(new Error('GUARDIAN_START_TIMEOUT')); control.end();}, 5000);
        try {
            journal.pid = await started;
            journal.guardianPid = child.pid!;
            const worker = inspect(journal.pid), guardian = inspect(journal.guardianPid);
            if (!worker || !guardian || worker.uid !== journal.uid || guardian.uid !== journal.uid)
                throw new Error('PROCESS_IDENTITY_UNKNOWN');
            journal.startTime = worker.startTime;
            journal.guardianStartTime = guardian.startTime;
            journal.state = 'RUNNING';
            await this.save(journal);
            const owned: OwnedProcess = {pid: journal.pid, child, exited: workerExit, firstLine: () => line,
                send: message => {if (child.connected) child.send(message as import('node:child_process').Serializable);}};
            this.live.set(id, owned);
            // Native worker cannot exec even trusted Node code before both identities are durable.
            control.write('START\n');
            return owned;
        } catch (error) { control.end(); throw error; }
        finally { clearTimeout(startup); }
    }
    /**
     * 公开方法 isRunning 根据 /proc 状态判断 pid 是否仍为非僵尸存活进程：供停机路径确认业务 worker 去向。
     */
    async isRunning(pid: number) { const proc = inspect(pid); return !!proc && !['Z','X'].includes(proc.state); }
    /**
     * 公开方法 active 返回当前仍登记为存活的 Attempt 标识列表：供恢复扫描与容量核算使用（active）（active）。
     */
    active() { return [...this.live.keys()]; }
    /**
     * 公开方法 terminateAttempt 请求守护进程停机并等待排空证明：缺少 ECHILD 证明则 processStopped 为 false。
     * 恢复路径据此隔离未知进程容量。
     */
    terminateAttempt(id: string, reason: string): Promise<StopReceipt> {
        const existing = this.stopping.get(id);
        if (existing) return existing;
        const operation = this.stop(id, reason).finally(() => this.stopping.delete(id));
        this.stopping.set(id, operation);
        return operation;
    }
    private async hasProof(journal: Journal): Promise<boolean> {
        try {
            const path = this.proofPath(journal.attemptId), info = await lstat(path);
            if (!info.isFile() || info.isSymbolicLink() || info.uid !== journal.uid || info.size > 2048 || (info.mode & 0o077)) return false;
            const proof = JSON.parse(await readFile(path, 'utf8'));
            return proof.version === 1 && proof.state === 'DRAINED' && proof.nonce === journal.nonce && proof.uid === journal.uid &&
                proof.guardianPid === journal.guardianPid && proof.guardianStartTime === journal.guardianStartTime &&
                proof.workerPid === journal.pid && proof.workerStartTime === journal.startTime;
        } catch { return false; }
    }
    private async provedStopped(journal: Journal): Promise<boolean> {
        if (!await this.hasProof(journal)) return false;
        const guardian = inspect(journal.guardianPid!);
        return !guardian || guardian.startTime !== journal.guardianStartTime || ['Z','X'].includes(guardian.state);
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
        const receipt = (processStopped: boolean, why = reason): StopReceipt => ({attemptId:id, processStopped, reason:why, stoppedAt:new Date().toISOString()});
        let journal: Journal;
        try { journal = JSON.parse(await readFile(this.path(id), 'utf8')); }
        catch { return receipt(false, 'UNKNOWN_PROCESS'); }
        if (journal.attemptId !== id || !journal.nonce || journal.uid !== process.getuid!() || !journal.pid || !journal.startTime || !journal.guardianPid || !journal.guardianStartTime)
            return receipt(false, 'UNKNOWN_PROCESS');
        const confirmed = async (): Promise<StopReceipt | undefined> => {
            try {
                if (!await this.provedStopped(journal)) return;
                journal.state = 'STOPPED'; await this.save(journal); this.releaseHandles(id);
                return receipt(true);
            } catch { return; }
        };
        const alreadyStopped = await confirmed();
        if (alreadyStopped) return alreadyStopped;
        try {
            const worker = inspect(journal.pid), guardian = inspect(journal.guardianPid);
            if (worker && (worker.uid !== journal.uid || worker.startTime !== journal.startTime)) return receipt(false, 'PROCESS_IDENTITY_CHANGED');
            if (!guardian || ['Z','X'].includes(guardian.state)) {
                // The first file probe may precede fsync/exit. Observe that handoff again.
                const drained = await confirmed();
                if (drained) return drained;
                // Best-effort known worker stop is not proof that an orphaned tree drained.
                if (worker && worker.group === journal.pid) process.kill(-worker.group, 'SIGKILL');
                this.releaseHandles(id); return receipt(false, 'CONTAINMENT_LOST');
            }
            if (guardian.uid !== journal.uid || guardian.startTime !== journal.guardianStartTime)
                return receipt(false, 'PROCESS_IDENTITY_UNKNOWN');
            if (!readFileSync(`/proc/${guardian.pid}/environ`).toString().split('\0').includes(`VERIQ_PROCESS_NONCE=${journal.nonce}`)) {
                const drained = await confirmed();
                if (drained) return drained;
                return receipt(false, 'PROCESS_IDENTITY_UNKNOWN');
            }
            process.kill(guardian.pid, 'SIGUSR1');
            const deadline = performance.now() + this.graceMs + 2000;
            while (performance.now() < deadline) {
                if (await this.provedStopped(journal)) {
                    journal.state = 'STOPPED'; await this.save(journal); this.releaseHandles(id); return receipt(true);
                }
                const current = inspect(guardian.pid);
                if (!current || ['Z','X'].includes(current.state)) break;
                if (current.uid !== journal.uid || current.startTime !== journal.guardianStartTime) break;
                await delay(20);
            }
            if (await this.provedStopped(journal)) {
                journal.state = 'STOPPED'; await this.save(journal); this.releaseHandles(id); return receipt(true);
            }
            this.releaseHandles(id); return receipt(false, 'PROCESS_STOP_UNCONFIRMED');
        } catch {
            const drained = await confirmed();
            if (drained) return drained;
            this.releaseHandles(id); return receipt(false, 'PROCESS_IDENTITY_UNKNOWN');
        }
    }
}
