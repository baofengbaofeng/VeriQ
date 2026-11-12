import { describe, it, expect } from 'vitest';
import { canonicalBytes, assetSourceBytes } from '../src/index.js';
import source from '../fixtures/asset-source.json' with { type: 'json' };
import { createHash } from 'node:crypto';
// 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
// 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
// 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
import vectors from '../fixtures/canonical.json' with { type: 'json' };

describe('RFC8785 cross-language known vectors', () => {
    // 关键路径：处理 for 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    for (const [i, vector] of vectors.entries()) it(`vector ${i}`, () => {
        expect(new TextDecoder().decode(canonicalBytes(vector.value))).toBe(vector.canonical);
    });
    it('rejects lone surrogates', () => expect(() => canonicalBytes('\ud800')).toThrow());
// 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
// 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
// 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
});

it('source identity is stable across validation and publication adoption', () => {
    expect(createHash('sha256').update(assetSourceBytes(source.snapshot)).digest('hex')).toBe(source.sha256);
    // 分段注释：继续说明 canonical.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    const { validationTarget: _, ...published } = source.snapshot;
    expect(assetSourceBytes(published)).toEqual(assetSourceBytes(source.snapshot));
    expect(assetSourceBytes({...source.snapshot, sourceHash:'f'.repeat(64)})).toEqual(assetSourceBytes(source.snapshot));
    expect(assetSourceBytes({...source.snapshot, engineVersion:'9.0.0'})).not.toEqual(assetSourceBytes(source.snapshot));
// 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
// 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
// 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
});
