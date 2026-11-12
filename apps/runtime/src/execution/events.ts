import { validateSchema, type ExecutionEventV1 } from '@veriq/contracts';
import type { LiveStepEvent, CaseResult } from '@veriq/runner-sdk';
import type { AgentClient, Claim } from '../agent/transport.ts';
export type Fact = {
    type: ExecutionEventV1['type'];
    stepId?: string;
    assertionId?: string;
    payload: unknown;
};
export class EventBuffer {
    private queue: ExecutionEventV1[] = [];
    private bytes = 0;
    private sequence = 0;
    private flushing: Promise<void> | undefined;
    constructor(private claim: Claim, private client: AgentClient, private limit = 4 * 1024 * 1024) { }
    append(fact: Fact) {
        const event = executionEvent(this.claim.attemptId, this.sequence + 1, fact);
        const size = Buffer.byteLength(JSON.stringify(event));
        if (this.bytes + size > this.limit || this.queue.length >= 10000)
            throw new Error('EVENT_BUFFER_FULL');
        this.queue.push(event);
        this.bytes += size;
        this.sequence++;
    }
    async sdk(event: SdkEvent) { this.append(sdkFact(event)); }
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

export type SdkEvent = LiveStepEvent | {
        type: 'CLEANUP_RESULT';
        cleanupStatus: CaseResult['cleanupStatus'];
    } | {
        type: 'CASE_FINISHED';
        result: CaseResult;
    };
export function executionEvent(attemptId: string, sequence: number, fact: Fact): ExecutionEventV1 {
    const event = {schemaVersion:'1.0',attemptId,sequence,timestamp:new Date().toISOString(),...fact} as ExecutionEventV1;
    if(validateSchema('ExecutionEventV1',event).length) throw new Error('INVALID_EXECUTION_EVENT');
    return event;
}
export function sdkFact(event: SdkEvent): Fact {
    switch(event.type) {
      case 'STEP_STARTED': return {type:event.type,stepId:event.stepId,payload:{}};
      case 'STEP_FINISHED': case 'OBSERVER_RESULT': return {type:event.type,stepId:event.stepId,payload:event.result};
      case 'ASSERTION_RESULT': return {type:event.type,stepId:event.stepId,assertionId:event.assertionId,payload:event.result};
      case 'CLEANUP_RESULT': return {type:event.type,payload:{cleanupStatus:event.cleanupStatus}};
      case 'CASE_FINISHED': return {type:'ATTEMPT_FINISHED',payload:{outcome:event.result.outcome,cleanupStatus:event.result.cleanupStatus}};
    }
}
