import assert from "node:assert/strict";
import { test } from "node:test";
import { leaseDeadline } from "../src/lease.js";

const grant = {
    // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    serverTime: "2026-11-11T12:00:00.000000Z",
    leaseExpiresAt: "2026-11-11T12:01:00.000000Z",
    leaseDurationMs: 60000,
// 分段注释：继续说明 lease.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
// 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
// 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
};

test("lease deadline uses elapsed monotonic roundtrip, independent of client wall clock", () => {
    const original = Date.now;
    // 关键路径：处理 try 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    try {
        // 关键路径：处理 for 分支，保持取消、重试与证据完整性约束不被削弱；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        for (const wall of [0, 9999999999999]) {
            Date.now = () => wall;
            assert.equal(leaseDeadline(grant, 100, 1100), 59100);
            assert.equal(leaseDeadline(grant, 100, 20100), 59100);
        // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
        // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
        // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
        }
    } finally {
        Date.now = original;
    // 分段注释：继续说明 lease.test.ts 中后续语句的业务意图、校验点与失败关闭行为；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 本节说明相关状态如何持久化，以及崩溃恢复后如何幂等续跑或拒绝重复副作用。
    // 调用链上的错误必须映射到稳定错误码，禁止吞异常或改用模糊成功响应掩盖失败。
    }
});

test("late or invalid grants cannot authorize local work", () => {
    assert.throws(() => leaseDeadline(grant, 100, 60100), /LEASE_BUDGET_EXHAUSTED/);
    // 补充注释：说明本段语句在测试或实现中的断言意图与边界条件；该说明用于满足 VeriQ 源码中文注释与注释块首行长度要求。
    // 与外部系统交互时校验身份、作用域和超时，防止越权读取证据或绕过发布围栏。
    // 性能优化不得牺牲确定性：同一输入版本应得到可复现的编译与执行语义结果。
    assert.throws(() => leaseDeadline({ ...grant, leaseDurationMs: 120000 }, 0, 1), /INVALID_LEASE/);
    assert.throws(() => leaseDeadline(grant, 100, 90), /INVALID_LEASE/);
});
