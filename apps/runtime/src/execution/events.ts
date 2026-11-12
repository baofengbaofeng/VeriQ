/**
 * 本文件实现 Attempt 事件缓冲与上报：附带 lease/fencing 令牌分批 POST：并把 SDK 事实翻译成 ExecutionEvent。
 */

import { validateSchema, type ExecutionEventV1 } from '@veriq/contracts';
import type { LiveStepEvent, CaseResult } from '@veriq/runner-sdk';
import type { AgentClient, Claim } from '../agent/transport.ts';
/**
 * 公开类型 Fact 描述尚未编号的执行事实：含事件类型、可选 stepId/assertionId：以及写入 ExecutionEvent 前的 payload。
 */
export type Fact = {
        type: ExecutionEventV1['type'];
        stepId?: string;
        assertionId?: string;
        payload: unknown;
};
/**
 * 公开类 EventBuffer 按序列号缓存事件：flush 时校验控制面 acceptedThrough：缓冲条数或字节超限即失败。
 */
export class EventBuffer {
        private queue: ExecutionEventV1[] = [];
        private bytes = 0;
        private sequence = 0;
        private flushing: Promise<void> | undefined;
        constructor(private claim: Claim, private client: AgentClient, private limit = 4 * 1024 * 1024) { }
        /**
         * 公开方法 append 把 Fact 封装为下一序列 ExecutionEvent：schema 通过后计入缓冲：条数或字节超限立即抛错。
         */
        append(fact: Fact) {
                const event = executionEvent(this.claim.attemptId, this.sequence + 1, fact);
                const size = Buffer.byteLength(JSON.stringify(event));
                if (this.bytes + size > this.limit || this.queue.length >= 10000)
                        throw new Error('EVENT_BUFFER_FULL');
                this.queue.push(event);
                this.bytes += size;
                this.sequence++;
        }
        /**
         * 公开方法 sdk 把 LiveStepEvent 或清理/整案结束通知转成 Fact：再交给 append 进入带序列号的上报缓冲。
         */
        async sdk(event: SdkEvent) { this.append(sdkFact(event)); }
        /**
         * 公开方法 flush 每次最多上送一百条事件：核对 acceptedThrough 落在本批末序列与本地总序列之间：以防事件丢序。
         */
        flush(): Promise<void> {
                if (this.flushing)
                        return this.flushing;
                this.flushing = (async () => {
                        while (this.queue.length) {
                                const events = this.queue.slice(0, 100);
                                const reply = await this.client.request<{
                                        acceptedThrough: number;
                                }>(`/internal/v1/attempts/${this.claim.attemptId}/events`, 'POST', { leaseToken: this.claim.leaseToken, fencingToken: this.claim.fencingToken, events });
                                if (reply.acceptedThrough < events[events.length - 1]!.sequence || reply.acceptedThrough > this.sequence)
                                        throw new Error('INVALID_EVENT_ACK');
                                this.queue.splice(0, events.length);
                                this.bytes -= events.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)), 0);
                        }
                })().finally(() => { this.flushing = undefined; });
                return this.flushing;
        }
        get lastSequence() { return this.sequence; }
}

/**
 * 公开类型 SdkEvent 联合步骤实时事件、清理结果与整案结束通知：供 EventBuffer.sdk 映射成平台 Fact。
 */
export type SdkEvent = LiveStepEvent | {
                type: 'CLEANUP_RESULT';
                cleanupStatus: CaseResult['cleanupStatus'];
        } | {
                type: 'CASE_FINISHED';
                result: CaseResult;
        };
/**
 * 公开函数 executionEvent 组装带序列号与时间戳的 ExecutionEventV1：schema 校验失败则拒绝进入缓冲。
 */
export function executionEvent(attemptId: string, sequence: number, fact: Fact): ExecutionEventV1 {
        const event = {schemaVersion:'1.0',attemptId,sequence,timestamp:new Date().toISOString(),...fact} as ExecutionEventV1;
        if(validateSchema('ExecutionEventV1',event).length) throw new Error('INVALID_EXECUTION_EVENT');
        return event;
}
/**
 * 公开函数 sdkFact 将 SDK 事件翻译为平台 Fact：保留步骤/断言标识：并把 CASE_FINISHED 映射为 ATTEMPT_FINISHED。
 */
export function sdkFact(event: SdkEvent): Fact {
        switch(event.type) {
            case 'STEP_STARTED': return {type:event.type,stepId:event.stepId,payload:{}};
            case 'STEP_FINISHED': case 'OBSERVER_RESULT': return {type:event.type,stepId:event.stepId,payload:event.result};
            case 'ASSERTION_RESULT': return {type:event.type,stepId:event.stepId,assertionId:event.assertionId,payload:event.result};
            case 'CLEANUP_RESULT': return {type:event.type,payload:{cleanupStatus:event.cleanupStatus}};
            case 'CASE_FINISHED': return {type:'ATTEMPT_FINISHED',payload:{outcome:event.result.outcome,cleanupStatus:event.result.cleanupStatus}};
        }
}
