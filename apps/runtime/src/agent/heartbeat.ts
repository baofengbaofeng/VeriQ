import { leaseDeadline } from '../lease.ts';
import type { PlatformComponents } from '@veriq/contracts';
import type { AgentClient, Claim } from './transport.ts';
/** Watchdog never waits for the HTTP queue or a heartbeat response before requesting stop. */
export class Heartbeat {
    private timer?: ReturnType<typeof setTimeout>;
    private watch?: ReturnType<typeof setTimeout>;
    private done = false;
    private phase: "LEASED" | "RUNNING" = "LEASED";
    private deadline: number;
    constructor(private client: AgentClient, private claim: Claim, sent: number, received: number, private stop: (reason: string) => void) {
        this.deadline = leaseDeadline({ ...claim, leaseExpiresAt: claim.expiresAt }, sent, received);
    }
    start() { this.arm(); this.timer = setTimeout(() => void this.beat(), 10000); }
    private arm() { clearTimeout(this.watch); this.watch = setTimeout(() => this.stop('LEASE_LOST'), Math.max(0, this.deadline - performance.now())); }
    private async beat() {
        if (this.done)
            return;
        const sent = performance.now();
        try {
            const grant = await this.client.request<PlatformComponents['schemas']['HeartbeatDTO']>(`/internal/v1/attempts/${this.claim.attemptId}/heartbeat`, 'POST', { leaseToken: this.claim.leaseToken, fencingToken: this.claim.fencingToken, progress: { phase: this.phase } });
            if (this.done)
                return;
            if (grant.cancelRequested) {
                this.stop('USER_CANCELLED');
                return;
            }
            this.deadline = leaseDeadline(grant, sent, performance.now());
            this.arm();
            this.timer = setTimeout(() => void this.beat(), Math.max(0, 10000 - (performance.now() - sent)));
        }
        catch {
            if (!this.done)
                this.stop('CONTROL_CONNECTION_LOST');
        }
    }
    activated() { this.phase = "RUNNING"; }
    close() { this.done = true; clearTimeout(this.timer); clearTimeout(this.watch); }
    remaining() { return Math.max(0, this.deadline - performance.now()); }
}
