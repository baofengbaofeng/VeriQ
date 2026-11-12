/**
 * 本文件实现 Agent 认领循环：本地持久化 claim 请求、恢复后隔离未排空进程，并按租约预算串行执行每次 Attempt。
 */
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { PlatformComponents } from '@veriq/contracts';
import type { AgentClient, Claim } from './transport.ts';
import { ExecutionSupervisor } from '../execution/supervisor.ts';
type S = PlatformComponents['schemas'];
/** One whole Attempt per claim. Only the platform creates retry Attempts. */
/**
 * 公开函数 claimLoop 在租约预算内幂等认领平台任务，崩溃恢复时先隔离未知进程，再串行跑完一整次 Attempt。
 * 平台独占重试 Attempt 的创建；停机证明失败则抛出 PROCESS_QUARANTINED，禁止继续认领。
 */
export async function claimLoop(options: {
    client: AgentClient;
    supervisor: ExecutionSupervisor;
    root: string;
    runnerId: string;
    capabilities: S['RuntimeCapabilitiesV1'];
    signal: AbortSignal;
    once?: boolean;
}) {
    const { client, supervisor, signal } = options;
    await mkdir(options.root, { recursive: true, mode: 0o700 });
    const pending = join(options.root, 'claim-request.json');
    const recovered = await supervisor.recover();
    // 仍有未排空进程时隔离容量，禁止在未知状态下继续认领。
    if (recovered.some(r => !r.processStopped))
        throw new Error('PROCESS_QUARANTINED');
    try {
        const request = JSON.parse(await readFile(pending, 'utf8')) as S['ClaimRequest'];
        // 崩溃前已为该 clientRequestId 产出停机回执时，清除陈旧认领请求以免重复副作用。
        if (request.runnerId === options.runnerId && recovered.some(receipt => receipt.claimRequestId === request.clientRequestId))
            await unlink(pending);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    while (!signal.aborted) {
        let request: S['ClaimRequest'];
        try {
            request = JSON.parse(await readFile(pending, 'utf8')) as S['ClaimRequest'];
            if (request.runnerId !== options.runnerId)
                throw new Error('CLAIM_PRINCIPAL_CHANGED');
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                throw error;
            request = { runnerId: options.runnerId, clientRequestId: randomUUID(), capabilities: options.capabilities, availableSlots: 1 };
            // 以 wx 原子写入持久化认领请求，崩溃后可按同一 clientRequestId 幂等续请。
            await writeFile(pending, JSON.stringify(request), { mode: 0o600, flag: 'wx', flush: true });
        }
        const requestStarted = performance.now();
        const claim = await client.request<Claim | undefined>('/internal/v1/jobs/claim', 'POST', request, signal);
        const responseReceived = performance.now();
        if (claim) {
            const result = await supervisor.runAttempt({ claim, requestStarted, responseReceived, claimRequestId: request.clientRequestId }, signal);
            if (!result.stop.processStopped)
                throw new Error('PROCESS_QUARANTINED');
            if (!result.completion)
                throw new Error(result.stop.reason);
        }
        await unlink(pending);
        if (options.once)
            return;
        // A fresh poll every >=10s gives at most8,640 empty receipts/24h (<10,000 cap).
        if (!claim)
            await delay(10000, undefined, { signal }).catch(error => { if (!signal.aborted)
                throw error; });
    }
}
