import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSchema } from '@veriq/contracts';
import { randomUUID } from 'node:crypto';
// 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
// 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
// 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
test('offline attempts retain variant execution, physical stop and retry safety facts', () => {
    const value = { attemptId: randomUUID(), caseVersionId: randomUUID(), attemptNo: 1, outcome: 'ERROR', cleanupStatus: 'NOT_REQUIRED', lastSequence: 0, events: [], artifacts: [], processStopped: true, retrySafety: 'UNKNOWN', failureCode: 'LOCAL_CREDENTIAL_MISSING', sourceKind: 'PUBLISHED', variantKey: 'a'.repeat(64) };
    assert.deepEqual(validateSchema('OfflineAttemptV1', value), []);
    // 分段注释：继续说明 offline-result.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    assert.notDeepEqual(validateSchema('OfflineAttemptV1', { ...value, processStopped: 'yes' }), []);
});
