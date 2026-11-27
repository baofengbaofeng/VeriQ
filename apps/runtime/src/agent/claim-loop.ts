/**
 * 本文件实现 Agent 认领循环：本地持久化 claim 请求、恢复后隔离未排空进程，并按租约预算串行执行每次 Attempt。
 */
import { RuntimeError } from "../enrollment.ts";
import { randomUUID } from "node:crypto";
import { addAbortListener } from "node:events";
import { mkdir } from "node:fs/promises";
import { clearPending, preserveForeignRequest, publishPending, readPending } from "./pending-claim.ts";
import timers from "node:timers/promises";
import type { PlatformComponents } from "@veriq/contracts";
import type { AgentClient, Claim } from "./transport.ts";
import type { ExecutionSupervisor } from "../execution/supervisor.ts";
import type { StoragePauseReason } from "../execution/storage-admission.ts";
import type { DataCleanup } from "../execution/storage.ts";

type S = PlatformComponents["schemas"];

/**
 * 领取状态只反映当前磁盘暂停和本机已知的暂存核对事项，供现有控制界面读取；不传递任务标识、路径或原生错误。
 */
export interface ClaimLoopState {
    pausedReason?: StoragePauseReason;
    scratchCleanupPending?: boolean;
}

/**
 * 只投影未核对的所有权或停止事实，特意保留的私有报告仍有自己的处置类别，不作为要求回收报告的依据。
 */
function cleanupPending(value: DataCleanup | undefined): boolean {
    return value === "OWNERSHIP_UNCONFIRMED" || value === "STOP_UNCONFIRMED";
}

/**
 * 只取消领取对只读容量探针的等待，底层文件系统查询可以稍后返回；监听按次释放，迟到结果没有状态发布入口。
 */
async function waitForStorageAdmission(supervisor: ExecutionSupervisor, signal: AbortSignal) {
    let notifyStop!: () => void;
    const stopped = new Promise<undefined>((resolve) => {
        notifyStop = () => resolve(undefined);
    });
    const subscription = addAbortListener(signal, notifyStop);
    try {
        return await Promise.race([supervisor.checkStorageAdmission(), stopped]);
    } finally {
        subscription[Symbol.dispose]();
    }
}

/**
 * 公开函数 claimLoop 在租约预算内幂等认领平台任务，崩溃恢复时先隔离未知进程，再串行跑完一整次 Attempt。平台独占重试
 * Attempt 的创建；停机证明失败则抛出 PROCESS_QUARANTINED，禁止继续认领。
 */
export async function claimLoop(options: {
    client: AgentClient;
    supervisor: ExecutionSupervisor;
    root: string;
    runnerId: string;
    capabilities: S["RuntimeCapabilitiesV1"];
    signal: AbortSignal;
    once?: boolean;
    onStateChange?: (state: Readonly<ClaimLoopState>) => void;
}) {
    const { client, supervisor, signal } = options;
    await mkdir(options.root, { recursive: true, mode: 0o700 });
    let state: ClaimLoopState = {};
    const publish = (
        pausedReason: StoragePauseReason | undefined,
        scratchCleanupPending = !!state.scratchCleanupPending,
    ) => {
        if (pausedReason === state.pausedReason && scratchCleanupPending === !!state.scratchCleanupPending) return;
        state = {
            ...(pausedReason ? { pausedReason } : {}),
            ...(scratchCleanupPending ? { scratchCleanupPending } : {}),
        };
        options.onStateChange?.(state);
    };
    const waitForPoll = () =>
        timers.setTimeout(10000, undefined, { signal }).catch((error) => {
            if (!signal.aborted) throw error;
        });
    const recovered = await supervisor.recover((value) => {
        if (cleanupPending(value)) publish(undefined, true);
    }, options.runnerId);
    // 恢复收据仍报告未停止进程时隔离本机容量，拒绝继续认领，以免未知执行与新任务同时占用设备。
    if (recovered.some((r) => !r.processStopped)) throw new Error("PROCESS_QUARANTINED");
    let checkRecoveredRequest = true;
    try {
        while (!signal.aborted) {
            const pausedReason = await waitForStorageAdmission(supervisor, signal);
            if (signal.aborted) break;
            publish(pausedReason);
            if (pausedReason) {
                if (options.once) throw new Error(pausedReason);
                await waitForPoll();
                continue;
            }
            let request = await readPending(options.root);
            if (request && request.runnerId !== options.runnerId) {
                await preserveForeignRequest(options.root, request);
                request = undefined;
            }
            const pendingId = request?.clientRequestId;
            if (pendingId && checkRecoveredRequest && recovered.some((r) => r.claimRequestId === pendingId)) {
                await clearPending(options.root);
                request = undefined;
            }
            checkRecoveredRequest = false;
            if (!request) {
                request = {
                    runnerId: options.runnerId,
                    clientRequestId: randomUUID(),
                    capabilities: options.capabilities,
                    availableSlots: 1,
                };
                await publishPending(options.root, request);
            }
            const requestStarted = performance.now();
            let claim: Claim | undefined;
            try {
                claim = await client.request<Claim | undefined>("/internal/v1/jobs/claim", "POST", request, signal);
            } catch (error) {
                if (
                    !(error instanceof RuntimeError) ||
                    error.status !== 409 ||
                    error.code !== "UNACTIVATED_CLAIM_CLOSED" ||
                    error.clientRequestId !== request.clientRequestId.toLowerCase()
                )
                    throw error;
                await clearPending(options.root);
                continue;
            }
            const responseReceived = performance.now();
            if (claim) {
                const result = await supervisor.runAttempt(
                    {
                        claim,
                        runnerId: options.runnerId,
                        requestStarted,
                        responseReceived,
                        claimRequestId: request.clientRequestId,
                    },
                    signal,
                );
                if (cleanupPending(result.dataCleanup)) publish(undefined, true);
                if (!result.stop.processStopped) throw new Error("PROCESS_QUARANTINED");
                if (!result.completion) throw new Error(result.stop.reason);
            }
            await clearPending(options.root);
            if (claim) await supervisor.archiveCompleted(claim);
            if (options.once) return;
            // 循环在空认领后先等十秒，纯空轮询每二十四小时最多产生八千六百四十条空回执，低于一万条上限。
            if (!claim) await waitForPoll();
        }
    } finally {
        publish(undefined);
    }
}
