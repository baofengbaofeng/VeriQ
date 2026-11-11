import { readFileSync, statSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
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
    state: 'SPAWNING' | 'RUNNING' | 'STOPPED';
    owned?: {pid: number; startTime: string}[];
}
export interface Command {
    executable: string;
    args: string[];
    cwd: string;
    env?: Record<string, string>;
}
export interface OwnedProcess {
    pid: number;
    exited: Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
    }>;
    firstLine(): Promise<string>;
    send(message: unknown): void;
    child: ChildProcess;
}
interface Proc {
    uid: number;
    pid: number;
    group: number;
    parent: number;
    startTime: string;
    state: string;
}
function inspectSync(pid: number): Proc | undefined {
    try {
        const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
        return { uid: statSync(`/proc/${pid}`).uid, pid, state: fields[0]!, group: Number(fields[2]), parent: Number(fields[1]), startTime: fields[19]! };
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH')
            return;
        throw error;
    }
}
async function inspect(pid: number): Promise<Proc | undefined> { return inspectSync(pid); }
/** Private crash journal is evidence of ownership, never evidence of successful business work. */
export class ProcessSupervisor {
    private live = new Map<string, OwnedProcess>();
    private stopping = new Map<string, Promise<StopReceipt>>();
    constructor(private directory: string, private graceMs = 500) { }
    private path(id: string) { if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id))
        throw new Error('INVALID_ATTEMPT_ID'); return join(this.directory, `${id}.process.json`); }
    private async save(journal: Journal) {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await chmod(this.directory, 0o700);
        const path = this.path(journal.attemptId), temporary = `${path}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(journal), { mode: 0o600, flag: 'wx', flush: true });
        await rename(temporary, path);
    }
    async start(id: string, command: Command): Promise<OwnedProcess> {
        if (process.platform !== 'linux')
            throw new Error('UNSUPPORTED_PROCESS_PLATFORM');
        if (this.live.has(id))
            throw new Error('PROCESS_ALREADY_RUNNING');
        try {
            await readFile(this.path(id));
            throw new Error('PROCESS_JOURNAL_EXISTS');
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                throw error;
        }
        const journal: Journal = { uid: process.getuid!(), attemptId: id, nonce: randomUUID(), state: 'SPAWNING' };
        await this.save(journal);
        // Build an allowlist from scratch. Device tokens, NODE_OPTIONS, proxy credentials and
        // the Agent's credential-store location must never enter a business child.
        const child = spawn(command.executable, command.args, {
            cwd: command.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', ...command.env, VERIQ_PROCESS_NONCE: journal.nonce },
        });
        let resolveLine!: (s: string) => void, rejectLine!: (e: Error) => void;
        const line = new Promise<string>((resolve, reject) => { resolveLine = resolve; rejectLine = reject; });
        void line.catch(() => { });
        let buffer = '', bytes = 0;
        child.stdout!.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 65536) {
                rejectLine(new Error('PROCESS_OUTPUT_LIMIT'));
                void this.terminateAttempt(id, 'PROCESS_OUTPUT_LIMIT');
                return;
            }
            buffer += chunk.toString('utf8');
            if (buffer.includes('\n')) {
                resolveLine(buffer.slice(0, buffer.indexOf('\n')));
                buffer = '';
            }
        });
        // Raw stderr stays out of ordinary logs; enforce the same bounded output budget.
        child.stderr!.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 65536)
            void this.terminateAttempt(id, 'PROCESS_OUTPUT_LIMIT'); });
        const exited = new Promise<{
            code: number | null;
            signal: NodeJS.Signals | null;
        }>((resolve, reject) => {
            child.once('error', reject);
            child.once('exit', (code, signal) => { rejectLine(new Error('PROCESS_NO_OUTPUT')); resolve({ code, signal }); });
        });
        void exited.catch(() => { });
        await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        journal.pid = child.pid!;
        const info = await inspect(journal.pid);
        if (!info)
            throw new Error('PROCESS_EXITED_BEFORE_JOURNAL');
        if (info.uid !== journal.uid)
            throw new Error('PROCESS_IDENTITY_CHANGED');
        journal.startTime = info.startTime;
        journal.state = 'RUNNING';
        const owned: OwnedProcess = { pid: child.pid!, child, exited, firstLine: () => line, send: (message) => { if (child.connected)
                child.send(message as import("node:child_process").Serializable); } };
        this.live.set(id, owned);
        try {
            await this.save(journal);
        }
        catch (error) {
            await this.terminateAttempt(id, 'JOURNAL_FAILED');
            throw error;
        }
        return owned;
    }
    async isRunning(pid: number): Promise<boolean> { const proc = await inspect(pid); return !!proc && proc.state !== 'Z' && proc.state !== 'X'; }
    active(): string[] { return [...this.live.keys()]; }
    terminateAttempt(id: string, reason: string): Promise<StopReceipt> {
        const current = this.stopping.get(id);
        if (current)
            return current;
        const promise = this.stop(id, reason).finally(() => this.stopping.delete(id));
        this.stopping.set(id, promise);
        return promise;
    }
    private async stop(id: string, reason: string): Promise<StopReceipt> {
        const receipt = (processStopped: boolean, why = reason): StopReceipt => ({ attemptId: id, processStopped, reason: why, stoppedAt: new Date().toISOString() });
        let journal: Journal;
        try {
            journal = JSON.parse(await readFile(this.path(id), 'utf8')) as Journal;
        }
        catch {
            return receipt(false, 'UNKNOWN_PROCESS');
        }
        if (journal.attemptId !== id || !journal.nonce || journal.uid !== process.getuid!())
            return receipt(false, 'UNKNOWN_PROCESS');
        if (journal.state === 'STOPPED')
            return receipt(true);
        if (!journal.pid || !journal.startTime)
            return receipt(false, 'UNKNOWN_PROCESS');
        const tracked = new Map((journal.owned ?? []).map(p => [p.pid, p.startTime]));
        const members = async () => {
            const entries = await readdir('/proc');
            const facts = entries.filter(s => /^\d+$/.test(s)).map(s => inspectSync(Number(s)))
                .filter((p): p is Proc => !!p && p.state !== 'Z' && p.state !== 'X');
            const leader = facts.find(p => p.pid === journal.pid);
            if (leader && leader.startTime !== journal.startTime) throw new Error('PROCESS_IDENTITY_CHANGED');
            const descendants = new Set<number>([journal.pid!]);
            for (let changed = true; changed;) {
                changed = false;
                for (const fact of facts) if (descendants.has(fact.parent) && !descendants.has(fact.pid)) {
                    descendants.add(fact.pid); changed = true;
                }
            }
            const matches = facts.map(fact => {
                if (fact.uid !== journal.uid) {
                    if (tracked.get(fact.pid) === fact.startTime || descendants.has(fact.pid) || fact.group === journal.pid)
                        throw new Error('PROCESS_IDENTITY_UNKNOWN');
                    return;
                }
                try {
                    const env = readFileSync(`/proc/${fact.pid}/environ`);
                    const owned = env.toString().split('\0').includes(`VERIQ_PROCESS_NONCE=${journal.nonce}`);
                    // Detached browser groups retain the nonce even after their parent dies.
                    return owned || tracked.get(fact.pid) === fact.startTime || descendants.has(fact.pid) || fact.group === journal.pid ? fact : undefined;
                } catch (error) {
                    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
                    if (tracked.get(fact.pid) === fact.startTime || descendants.has(fact.pid) || fact.group === journal.pid) throw new Error('PROCESS_IDENTITY_UNKNOWN');
                    return;
                }
            });
            const owned = matches.filter((fact): fact is Proc => !!fact);
            for (const fact of owned) tracked.set(fact.pid, fact.startTime);
            return owned;
        };
        const signal = async (members: Proc[], signal: NodeJS.Signals) => {
            journal.owned = [...tracked].map(([pid, startTime]) => ({pid, startTime}));
            await this.save(journal);
            for (const group of new Set(members.map(p => p.group))) {
                if (group <= 1) throw new Error('PROCESS_IDENTITY_UNKNOWN');
                const proof = members.find(p => p.group === group)!;
                const current = await inspect(proof.pid);
                if (!current) continue;
                if (current.uid !== journal.uid || current.startTime !== proof.startTime || current.group !== group) throw new Error('PROCESS_IDENTITY_CHANGED');
                try { process.kill(-group, signal); }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('PROCESS_STOP_FAILED'); }
            }
        };
        try {
            let group = await members();
            if (group.length) {
                await signal(group, 'SIGTERM');
                const until = performance.now() + this.graceMs;
                while ((group = await members()).length && performance.now() < until) await delay(20);
                const killUntil = performance.now() + 2000;
                while (group.length && performance.now() < killUntil) {
                    await signal(group, 'SIGKILL');
                    await delay(20);
                    group = await members();
                }
                if (group.length) return receipt(false, 'PROCESS_STOP_UNCONFIRMED');
            }
        } catch (error) {
            return receipt(false, error instanceof Error && /^PROCESS_/.test(error.message) ? error.message : 'PROCESS_IDENTITY_UNKNOWN');
        }
        journal.state = 'STOPPED';
        await this.save(journal);
        this.live.delete(id);
        return receipt(true);
    }
}
