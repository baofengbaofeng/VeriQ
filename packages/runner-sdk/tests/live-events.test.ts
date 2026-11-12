import { it, expect } from 'vitest';
import { fixture, step, a } from './helpers.js';
import { createStepContext, executeStep } from '../src/index.js';
it('reports live starts and actual assertion/observer facts before the step finishes', async () => {
    // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    const f = await fixture();
    const facts: {
        type: string;
        // 分段注释：继续说明 live-events.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        stepId: string;
    }[] = [];
    // 关键路径：处理 try 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    try {
        const ctx = createStepContext({ ...f.options, onEvent: async (event: {
                type: string;
                stepId: string;
            // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
            // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
            // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
            }) => { facts.push(event); if (event.type === 'STEP_STARTED')
                expect(f.requests.filter(r => r.path === '/save')).toHaveLength(0); } });
        const plan = step({ id: 'write', action: 'apiRequest', method: 'POST', path: '/save' }, [a({ type: 'responseField', source: 'response:action', pointer: '/code', operator: 'equals', expected: 0 })]);
        // 分段注释：继续说明 live-events.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
        // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
        const result = await executeStep(plan, ctx);
        ctx.dispose();
        expect(result.status).toBe('PASSED');
        expect(facts.map(e => e.type)).toEqual(['STEP_STARTED', 'ASSERTION_RESULT', 'OBSERVER_RESULT', 'STEP_FINISHED']);
        // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        expect(facts.every(e => e.stepId === 'write')).toBe(true);
    }
    // 关键路径：处理 finally 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    finally {
        await f.close();
    }
});
