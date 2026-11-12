/**
 * 本文件实现 Attempt 租约看门狗：本地截止定时器可先于 HTTP 排队触发停机，心跳负责续租并处理 cancelRequested 与断连。
 */
import { leaseDeadline } from '../lease.ts';
import type { PlatformComponents } from '@veriq/contracts';
import type { AgentClient, Claim } from './transport.ts';
/** Watchdog never waits for the HTTP queue or a heartbeat response before requesting stop. */
/**
 * 公开类 Heartbeat 用本地单调截止看管 Attempt 租约，不等待 HTTP 队列或心跳应答就会触发停机请求。
 * 每十秒续租并处理 cancelRequested；控制连接丢失映射为 CONTROL_CONNECTION_LOST。
 */
export class Heartbeat {
    private timer?: ReturnType<typeof setTimeout>;
    private watch?: ReturnType<typeof setTimeout>;
    private done = false;
    private phase: "LEASED" | "RUNNING" = "LEASED";
    private deadline: number;
    constructor(private client: AgentClient, private claim: Claim, sent: number, received: number, private stop: (reason: string) => void) {
        this.deadline = leaseDeadline({ ...claim, leaseExpiresAt: claim.expiresAt }, sent, received);
    }
    /**
     * 公开方法 start 武装本地租约看门狗并调度首次心跳，截止到达即调用构造时注入的 stop 回调（start）（start）。
     */
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
            // 平台已请求取消时立即停机，不消费剩余租约去做新的副作用。
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
    /**
     * 公开方法 activated 把进度相位从 LEASED 切到 RUNNING，后续心跳向平台报告真实执行进度（activated）。
     */
    activated() { this.phase = "RUNNING"; }
    /**
     * 公开方法 close 标记结束并清除心跳与看门狗定时器，防止停机后仍向平台发送租约续期请求，标注导出符号 close 供检索。
     */
    close() { this.done = true; clearTimeout(this.timer); clearTimeout(this.watch); }
    /**
     * 公开方法 remaining 返回距本地停机截止的剩余毫秒数，供监督器在动作预算内决定是否继续派发（remaining）。
     */
    remaining() { return Math.max(0, this.deadline - performance.now()); }
}
