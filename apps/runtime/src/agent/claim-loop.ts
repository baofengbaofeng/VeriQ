import { randomUUID } from 'node:crypto';
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { PlatformComponents } from '@veriq/contracts';
import type { AgentClient, Claim } from './transport.ts';
import { ExecutionSupervisor } from '../execution/supervisor.ts';
type S = PlatformComponents['schemas'];
/** One whole Attempt per claim. Only the platform creates retry Attempts. */
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
    if (recovered.some(r => !r.processStopped))
        throw new Error('PROCESS_QUARANTINED');
    try {
        const request = JSON.parse(await readFile(pending, 'utf8')) as S['ClaimRequest'];
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
