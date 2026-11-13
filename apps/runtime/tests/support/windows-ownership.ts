/** 所有权负例共用真实重命名 Node 与原生守护夹具，每个 Attempt 单独保存未经改写的日志；无论业务断言还是部分启动失败，清理都必须取得实际排空回执，未知状态只保留证据而不能删除目录。 */
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ProcessSupervisor } from "../../src/execution/processes.ts";

/** 测试只对清理等待设置既有五秒上限，超时必须作为未知资源状态保留而不伪造停止成功；定时器总在操作结束后释放，实际停止仍由监督器核验身份、请求守护并读取真实排空证明。 */
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

/** 场景只能改写指定 Attempt 的测试日志或观察其真实工作进度，夹具另外持有不可被场景覆盖的原始字节；角色可执行文件来自当前固定 Node，所有停止操作仍经过正式监督器而非测试替代实现。 */
export interface WindowsOwnershipScenario {
    processes: ProcessSupervisor;
    role: string;
    journals: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
    /** 日志改写始终以该 Attempt 的原始数据为基础，仅替换当前负例指定的字段并保留原文件的 DACL；夹具的独立原始字节不会随此操作变化，供之后重新核验真实身份并合法排空使用。 */
    replaceJournal(id: string, changes: Record<string, unknown>): Promise<void>;
    /** 新挑战只在拒绝停止之后发给指定业务进程，每个进程必须继续处理并推进二十五次真实迭代；所有观察并行完成后统一报告，避免第一个断言失败掩盖另一个 Attempt 已被误停的事实。 */
    requireProgress(ids: string[]): Promise<void>;
}

/** 夹具只在真实 Windows 原生测试中使用，启动前就记录待清理的 Attempt，以覆盖 READY 或业务握手中途失败；每次清理恢复精确日志并保留原始失败和排空错误，任何不确定状态都不能变成成功清理。 */
export async function withWindowsOwnership(
    context: TestContext,
    ids: string[],
    exercise: (scenario: WindowsOwnershipScenario) => Promise<void>,
): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "veriq ownership cases 中文 "));
    const role = join(root, "veriq_runner.exe");
    const processes = new ProcessSupervisor(join(root, "processes"));
    const authentic = new Map<string, string>();
    const journals = new Map<string, Readonly<Record<string, unknown>>>();
    const attempted: string[] = [];
    const failures: unknown[] = [];
    const journalPath = (id: string) => join(root, "processes", `${id}.process.json`);
    const challengePath = (id: string) => join(root, `${id}.challenge`);
    const progressPath = (id: string) => join(root, `${id}.progress.json`);
    try {
        await copyFile(process.execPath, role);
        for (const id of ids) {
            await writeFile(challengePath(id), "initial");
            const script = `const fs=require('node:fs');let sequence=0;setInterval(()=>{const challenge=fs.readFileSync(${JSON.stringify(challengePath(id))},'utf8');fs.writeFileSync(${JSON.stringify(progressPath(id))},JSON.stringify({challenge,sequence:++sequence}));},20);console.log('READY');`;
            attempted.push(id);
            const owned = await processes.start(id, {
                executable: role,
                args: ["-e", script],
                cwd: root,
                env: { SystemRoot: process.env.SystemRoot! },
            });
            const bytes = await readFile(journalPath(id), "utf8");
            authentic.set(id, bytes);
            journals.set(id, Object.freeze(JSON.parse(bytes)));
            assert.equal(await owned.firstLine(), "READY");
        }
        await exercise({
            processes,
            role,
            journals,
            async replaceJournal(id, changes) {
                assert(authentic.has(id), "Only this fixture's recorded Attempt may be changed");
                await writeFile(
                    journalPath(id),
                    JSON.stringify({ ...journals.get(id), ...changes }),
                );
            },
            async requireProgress(observedIds) {
                const results = await Promise.allSettled(
                    observedIds.map(async (id) => {
                        assert(authentic.has(id), "Progress must belong to this fixture's Attempt");
                        const challenge = randomUUID();
                        await writeFile(challengePath(id), challenge);
                        let firstSequence: number | undefined;
                        let lastSequence = 0;
                        const deadline = performance.now() + 2000;
                        while (performance.now() < deadline) {
                            let progress: { challenge: string; sequence: number } | undefined;
                            try {
                                progress = JSON.parse(await readFile(progressPath(id), "utf8"));
                            } catch (error) {
                                if (
                                    !(error instanceof SyntaxError) &&
                                    (error as NodeJS.ErrnoException).code !== "ENOENT"
                                )
                                    throw error;
                            }
                            if (progress?.challenge === challenge) {
                                firstSequence ??= progress.sequence;
                                lastSequence = progress.sequence;
                                if (lastSequence - firstSequence >= 25) break;
                            }
                            await delay(10);
                        }
                        context.diagnostic(
                            `Ownership worker progress: ${JSON.stringify({ id, firstSequence, lastSequence })}`,
                        );
                        assert(
                            firstSequence !== undefined && lastSequence - firstSequence >= 25,
                            `${id}: denied ownership must preserve sustained fresh worker progress`,
                        );
                    }),
                );
                const rejected = results.filter((result) => result.status === "rejected");
                if (rejected.length)
                    throw new AggregateError(
                        rejected.map((result) => result.reason),
                        "Ownership worker progress failed",
                    );
            },
        });
    } catch (error) {
        failures.push(error);
    } finally {
        for (const id of attempted) {
            try {
                const bytes = authentic.get(id);
                if (bytes) await writeFile(journalPath(id), bytes);
                const receipt = await bounded(() =>
                    processes.terminateAttempt(id, "OWNERSHIP_SCENARIO_FINALLY"),
                );
                context.diagnostic(`Ownership cleanup: ${JSON.stringify(receipt)}`);
                assert.equal(
                    receipt.processStopped,
                    true,
                    `${id}: unproved cleanup: ${receipt.reason}`,
                );
                const proof = JSON.parse(
                    await readFile(join(root, "processes", `${id}.drained.json`), "utf8"),
                );
                const original = journals.get(id);
                assert.equal(proof.state, "DRAINED");
                if (original) {
                    assert.equal(proof.nonce, original.nonce);
                    assert.equal(proof.sid, original.sid);
                    assert.equal(proof.workerPid, original.pid);
                    assert.equal(proof.guardianPid, original.guardianPid);
                    assert.equal(proof.workerStartTime, original.startTime);
                    assert.equal(proof.guardianStartTime, original.guardianStartTime);
                }
            } catch (error) {
                failures.push(error);
            }
        }
        if (failures.length) context.diagnostic(`Ownership scenario evidence retained: ${root}`);
        else {
            try {
                await bounded(() => rm(root, { recursive: true, force: true }));
            } catch (error) {
                failures.push(error);
                context.diagnostic(
                    `Ownership scenario removal failed; retain remaining evidence: ${root}`,
                );
            }
        }
    }
    if (failures.length)
        throw new AggregateError(failures, "Windows ownership scenario failed", {
            cause: failures[0],
        });
}
