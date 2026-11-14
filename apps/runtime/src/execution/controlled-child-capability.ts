import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { trackObservedCli } from "./controlled-child.ts";
import type { ObserverBinding } from "./controlled-child-protocol.mjs";

/** 能力探针必须执行调用者指定的发行 Node 而不是只匹配版本文本，所有临时普通文件在调用者允许的目录下独立创建；失败后仍持有真实句柄清理且不改变 doctor 或平台 ready。 */
export interface ControlledChildCapabilityOptions {
    nodeExecutable: string;
    temporaryDirectory: string;
    timeoutMs?: number;
}

/** 支持结果只说明本次具体 Node 实际通过公开通道、fork 继承与同步退出闸门探针，不是 macOS 真机认证或停止证明；失败只报告固定英文原因而不转储原始错误和执行环境。 */
export type ControlledChildCapability =
    | { supported: true; nodeVersion: string; coverage: "DIRECT_ASYNC_CHILDREN" }
    | { supported: false; reason: string };

/** 自检在原生 --import CLI 中确认构造回调先于 spawn 返回并收到同对象 exit，再以真实 fork 检查被动继承和无日志描述符，最后单独确认 seal 后构造即使 FD 关闭仍同步退出七十三。 */
export async function runControlledChildCapability(options: ControlledChildCapabilityOptions): Promise<ControlledChildCapability> {
    if (process.platform === "win32" || typeof process.getuid !== "function") return { supported: false, reason: "UNIX_FD_UNSUPPORTED" };
    const root = mkdtempSync(join(options.temporaryDirectory, "veriq-child-capability-"));
    const preload = fileURLToPath(new URL("./controlled-child-preload.mjs", import.meta.url));
    const binding: ObserverBinding = {
        version: 1, attemptId: randomUUID(), commandSlot: randomUUID(), ownerGeneration: 1, nonce: randomBytes(32).toString("hex"),
    };
    const timeoutMs = options.timeoutMs ?? 10000;
    let child: ChildProcess | undefined;
    let waited: Promise<void> | undefined;
    let fd: number | undefined;
    try {
        const forkFixture = join(root, "fork.mjs");
        writeFileSync(forkFixture, `import {fstatSync} from 'node:fs';
            let inherited = false;
            for (let fd = 4; fd < 128; fd++) {
                try { const stat = fstatSync(fd); if (String(stat.dev) === process.env.JDEV && String(stat.ino) === process.env.JINO) inherited = true; } catch {}
            }
            process.send({passive:process.env.VERIQ_CHILD_OBSERVER === undefined, inherited, imported:process.execArgv.includes('--import')});
            process.disconnect();`);
        const fixture = join(root, "probe.mjs");
        writeFileSync(fixture, `import {fork} from 'node:child_process';
            import {channel} from 'node:diagnostics_channel';
            import {fstatSync,fsyncSync,readSync} from 'node:fs';
            const stat = fstatSync(4);
            const read = () => {const bytes=Buffer.alloc(fstatSync(4).size);readSync(4,bytes,0,bytes.length,0);return bytes.toString();};
            let constructed;
            let intent = false;
            let spawned = false;
            channel('child_process').subscribe(({process:object})=>{constructed=object; intent=read().includes('"type":"INTENT"');});
            const child = fork(${JSON.stringify(forkFixture)}, [], {env:{...process.env,JDEV:String(stat.dev),JINO:String(stat.ino)}});
            const same = child === constructed;
            let inheritance;
            child.once('spawn',()=>{spawned=true;});
            child.once('message',value=>{inheritance=value;});
            child.once('exit',(code,signal)=>{
                fsyncSync(4);
                process.send({same,intent,spawned,exited:code===0&&signal===null&&read().includes('"type":"EXITED"'),inheritance,nodeVersion:process.version});
                process.disconnect();
            });`);
        let facts: unknown;
        for (const late of [false, true]) {
            fd = openSync(join(root, late ? "late-journal" : "probe-journal"), "wx+", 0o600);
            if (late) writeFileSync(fixture, `import {spawn} from 'node:child_process'; import {closeSync} from 'node:fs';
                process.on('exit',()=>{closeSync(4);spawn(process.execPath,['-e','process.exit(0)']);});`);
            const env = { ...process.env, VERIQ_CHILD_OBSERVER: JSON.stringify({ ...binding, fd: 4 }) };
            child = spawn(options.nodeExecutable, ["--import", preload, fixture], { env, stdio: ["ignore", "ignore", "ignore", "ipc", fd] });
            waited = new Promise((resolve) => {
                child!.once("exit", () => resolve());
                child!.once("error", () => resolve());
            });
            child.on("message", (value) => { facts = value; });
            const observed = trackObservedCli(child, { journalFd: fd, expectedBinding: binding, timeoutMs });
            const exit = await observed.exited;
            if (late) {
                if (exit.kind !== "exit" || exit.code !== 73 || exit.signal !== null) return { supported: false, reason: "LATE_SPAWN_GATE_UNSUPPORTED" };
            } else {
                const result = await observed.verifyFinal();
                if (!result.ok || result.exitCode !== 0 || result.objects.length !== 1) return { supported: false, reason: "CHILD_OBSERVATION_UNSUPPORTED" };
            }
            await waited;
            closeSync(fd);
            fd = undefined;
            child = undefined;
        }
        const actual = facts as {
            same?: unknown; intent?: unknown; spawned?: unknown; exited?: unknown; nodeVersion?: unknown;
            inheritance?: { passive?: unknown; inherited?: unknown; imported?: unknown };
        } | undefined;
        if (!actual || actual.same !== true || actual.intent !== true || actual.spawned !== true || actual.exited !== true
            || actual.inheritance?.passive !== true || actual.inheritance.inherited !== false || actual.inheritance.imported !== true
            || typeof actual.nodeVersion !== "string") return { supported: false, reason: "CONSTRUCTOR_FORK_CAPABILITY_UNSUPPORTED" };
        return { supported: true, nodeVersion: actual.nodeVersion, coverage: "DIRECT_ASYNC_CHILDREN" };
    } catch {
        return { supported: false, reason: "CAPABILITY_PROBE_FAILED" };
    } finally {
        if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await waited;
        if (fd !== undefined) closeSync(fd);
        rmSync(root, { recursive: true, force: true });
    }
}
