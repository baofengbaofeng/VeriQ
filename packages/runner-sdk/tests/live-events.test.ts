import { it, expect } from 'vitest';
import { fixture, step, a } from './helpers.js';
import { createStepContext, executeStep } from '../src/index.js';
it('reports live starts and actual assertion/observer facts before the step finishes', async () => {
    const f = await fixture();
    const facts: {
        type: string;
        stepId: string;
    }[] = [];
    try {
        const ctx = createStepContext({ ...f.options, onEvent: async (event: {
                type: string;
                stepId: string;
            }) => { facts.push(event); if (event.type === 'STEP_STARTED')
                expect(f.requests.filter(r => r.path === '/save')).toHaveLength(0); } });
        const plan = step({ id: 'write', action: 'apiRequest', method: 'POST', path: '/save' }, [a({ type: 'responseField', source: 'response:action', pointer: '/code', operator: 'equals', expected: 0 })]);
        const result = await executeStep(plan, ctx);
        ctx.dispose();
        expect(result.status).toBe('PASSED');
        expect(facts.map(e => e.type)).toEqual(['STEP_STARTED', 'ASSERTION_RESULT', 'OBSERVER_RESULT', 'STEP_FINISHED']);
        expect(facts.every(e => e.stepId === 'write')).toBe(true);
    }
    finally {
        await f.close();
    }
});
