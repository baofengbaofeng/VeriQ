import fs from "node:fs";
import { channel } from "node:diagnostics_channel";
import { ChildProcess } from "node:child_process";
import { inspectJournalFd, LIMITS, parseActivation, validateJournal } from "./controlled-child-protocol.mjs";

const raw = process.env.VERIQ_CHILD_OBSERVER;
if (raw !== undefined) {
    const exit = process.exit.bind(process);
    delete process.env.VERIQ_CHILD_OBSERVER;
    let fault = false;
    let sealed = false;
    let terminating = false;
    let position = 0;
    let seq = 0;
    let slots = 0;
    const roster = new Map();
    const frames = [];

    /** 激活后先消费标记并捕获公开退出入口，任何故障都先置粘滞位再同步结束当前进程；通道订阅异常可能被 Node 延迟处理，因此这里绝不能以 throw 充当派生闸门。 */
    function fail() {
        fault = true;
        exit(73);
    }

    try {
        const { binding, fd } = parseActivation(raw);
        inspectJournalFd(fd, true);

        /** 单写者明确从零定位写入，不依赖父子共享的隐含文件偏移；短写循环必须取得正进展且每条完整帧刷新成功，只有这样构造回调返回才表示意图已经持久写入。 */
        function append(type, fields = {}) {
            const frame = Buffer.from(`${JSON.stringify({ version: 1, seq, type, ...fields })}\n`);
            if (fault || sealed || seq >= LIMITS.records || frame.length > LIMITS.frameBytes
                || position + frame.length > LIMITS.fileBytes) fail();
            try {
                let written = 0;
                while (written < frame.length) {
                    const count = fs.writeSync(fd, frame, written, frame.length - written, position + written);
                    if (!Number.isSafeInteger(count) || count <= 0 || count > frame.length - written) fail();
                    written += count;
                }
                fs.fsyncSync(fd);
            } catch {
                fail();
            }
            position += frame.length;
            seq++;
            frames.push(frame);
        }

        append("OBSERVER_READY", binding);
        /** 未捕获异常的默认退出码也可能是一，不能与固定 CLI 的正常业务失败混同；公开 monitor 不吞掉异常，而是在异常终止路径先置观察故障并同步退出专用码，保留保守语义。 */
        process.on("uncaughtExceptionMonitor", fail);

        /** 保存真正的 ChildProcess 对象而非复用 PID，先提交 INTENT 再订阅该同一对象的生命周期；error 不猜测是否派生成功，任何不完整构造或异常事件都阻止封存。 */
        channel("child_process").subscribe(({ process: child }) => {
            if (fault || sealed || terminating) fail();
            try {
                if (!(child instanceof ChildProcess) || roster.has(child) || slots >= LIMITS.objects) fail();
                const slot = ++slots;
                append("INTENT", { slot });
                roster.set(child, "INTENT");
                child.once("spawn", () => {
                    if (fault || sealed || roster.get(child) !== "INTENT" || !Number.isSafeInteger(child.pid) || child.pid <= 0) fail();
                    append("SPAWNED", { slot, pid: child.pid });
                    roster.set(child, "SPAWNED");
                });
                child.on("error", fail);
                child.once("exit", (exitCode, signal) => {
                    if (fault || sealed || roster.get(child) !== "SPAWNED") fail();
                    append("EXITED", { slot, exitCode, signal });
                    roster.delete(child);
                });
            } catch {
                fail();
            }
        });

        /** 唯一正常封存点位于同步 exit handler，空 roster 仍须通过完整协议检查；先置终结闸防止重入，封存后任何后续 exit handler 再构造对象都必须在派生前同步退出 73。 */
        process.on("exit", () => {
            if (fault || sealed || terminating || roster.size !== 0) fail();
            terminating = true;
            try {
                append("SEAL");
                validateJournal(Buffer.concat(frames), binding);
                sealed = true;
            } catch {
                fail();
            }
        });
    } catch {
        fail();
    }
}
