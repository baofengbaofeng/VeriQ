/** 本用例运行独立测试编译体，在真实 START 之后控制原算法进入取消发生于未来 ReadFile 之前的窗口；正式 guardian 和 addon 没有测试入口，调度成功也不能替代实际 Job 排空、身份回执和真实资源清理。 */
import assert from "node:assert/strict";
import test from "node:test";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ProcessSupervisor, type OwnedProcess } from "../../src/execution/processes.ts";
import { windowsNative } from "../../src/native/windows.ts";

assert.equal(process.platform, "win32", "Controlled native scheduling requires Windows");
const require = createRequire(import.meta.url);
const schedule = require("../../build/native-tests/veriq_test_schedule.node") as {
    waitPhase(nonce: string, phase: "read-ready" | "cancel-missed"): Promise<void>;
    releaseRead(nonce: string): void;
};

/** 测试保存的身份字段与正式日志中的字符串 FILETIME 完全一致，工作与守护 PID 分开记录；该类型仅用于校验本次真实启动返回的日志，不能把不确定身份补成默认值或经浮点计算重建创建时间。 */
interface ScheduleJournal {
    nonce: string;
    sid: string;
    pid: number;
    startTime: string;
    guardianPid: number;
    guardianStartTime: string;
}

/** 清理只在既有五秒测试预算内等待真实操作，超时保留原始失败与私有目录而不能伪造进程已停止；调度等待自身也在原生工作线程有界完成，因此本定时器保持可执行而非依赖同步阻塞调用返回。 */
async function bounded<T>(operation: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            Promise.resolve().then(operation),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("NATIVE_TEST_CLEANUP_TIMEOUT")), 5000);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/** 已消费 START 的控制线程停在原始 closed 检查之后，只有真实 CancelSynchronousIo 返回无挂起操作才放行下一次系统读取；请求必须在原有期限内产生真实 DRAINED，不能靠测试关闭输入流才能获得首次成功回执。 */
test("Windows guardian drains when cancellation precedes its next synchronous control read", async (context) => {
    const root = await mkdtemp(join(tmpdir(), "veriq scheduled 中文 "));
    const role = join(root, "veriq_runner.exe");
    const id = "scheduled-read";
    const journalPath = join(root, "processes", `${id}.process.json`);
    const launcher = fileURLToPath(
        new URL("../../build/native-tests/veriq_guardian_scheduled.exe", import.meta.url),
    );
    const processes = new ProcessSupervisor(join(root, "processes"), 500, launcher);
    const failures: unknown[] = [];
    let owned: OwnedProcess | undefined;
    let authentic: string | undefined;
    let journal: ScheduleJournal | undefined;
    try {
        const product = windowsNative() as unknown as Record<string, unknown>;
        assert.equal(Object.hasOwn(product, "waitPhase"), false);
        assert.equal(Object.hasOwn(product, "releaseRead"), false);
        await copyFile(process.execPath, role);
        owned = await processes.start(id, {
            executable: role,
            args: ["-e", "console.log('READY');setInterval(()=>{},1000)"],
            cwd: root,
            env: { SystemRoot: process.env.SystemRoot! },
        });
        authentic = await readFile(journalPath, "utf8");
        journal = JSON.parse(authentic);
        assert(journal);
        assert.equal(await owned.firstLine(), "READY");
        await schedule.waitPhase(journal.nonce, "read-ready");
        const stopping = processes.terminateAttempt(id, "CONTROL_READ_RACE_TEST");
        await schedule.waitPhase(journal.nonce, "cancel-missed");
        context.diagnostic(
            "Owned control thread returned actual CancelSynchronousIo ERROR_NOT_FOUND before its next ReadFile",
        );
        schedule.releaseRead(journal.nonce);
        const receipt = await stopping;
        context.diagnostic(`Controlled read stop receipt: ${JSON.stringify(receipt)}`);
        assert.equal(
            receipt.processStopped,
            true,
            "Cancellation before the future read must still drain the actual Job",
        );
        assert.equal(await processes.isRunning(owned.pid), false);
    } catch (error) {
        failures.push(error);
    } finally {
        try {
            if (journal) schedule.releaseRead(journal.nonce);
            if (authentic) await writeFile(journalPath, authentic);
            if (owned && journal) {
                const guardian = windowsNative().identity(journal.guardianPid);
                if (guardian?.running) {
                    assert.equal(owned.child.pid, journal.guardianPid);
                    assert.equal(guardian.sid, journal.sid);
                    assert.equal(guardian.startTime, journal.guardianStartTime);
                    owned.child.stdin?.end();
                }
            }
            const receipt = await bounded(() =>
                processes.terminateAttempt(id, "CONTROL_READ_RACE_FINALLY"),
            );
            context.diagnostic(`Controlled read cleanup receipt: ${JSON.stringify(receipt)}`);
            assert.equal(receipt.processStopped, true, `Unproved cleanup: ${receipt.reason}`);
            const proof = JSON.parse(
                await readFile(join(root, "processes", `${id}.drained.json`), "utf8"),
            );
            assert.equal(proof.state, "DRAINED");
            assert(journal);
            assert.equal(proof.nonce, journal.nonce);
            assert.equal(proof.sid, journal.sid);
            assert.equal(proof.workerPid, journal.pid);
            assert.equal(proof.workerStartTime, journal.startTime);
            assert.equal(proof.guardianPid, journal.guardianPid);
            assert.equal(proof.guardianStartTime, journal.guardianStartTime);
        } catch (error) {
            failures.push(error);
        }
        if (failures.length) context.diagnostic(`Controlled read evidence retained: ${root}`);
        else {
            try {
                await bounded(() => rm(root, { recursive: true, force: true }));
            } catch (error) {
                failures.push(error);
                context.diagnostic(
                    `Controlled read removal failed; preserve remaining evidence: ${root}`,
                );
            }
        }
    }
    if (failures.length)
        throw new AggregateError(failures, "Windows controlled read assertion or cleanup failed", {
            cause: failures[0],
        });
});
