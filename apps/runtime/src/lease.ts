/** 本文件按认领与心跳请求的发出时刻和到达时刻（单调时钟）换算本地停机截止，扣除完整往返时延并预留一秒，绝不去对照设备墙钟（LeaseGrant）。 */

/**
 * 公开接口 LeaseGrant 描述平台下发的租约窗口，字段含 serverTime、leaseExpiresAt 与 leaseDurationMs，只供本地换算（LeaseGrant）。
 */
export interface LeaseGrant {
    serverTime: string;
    leaseExpiresAt: string;
    leaseDurationMs: number;
}

/**
 * 公开函数 leaseDeadline 用请求发出与响应到达的单调时刻换算停机截止；字段非法抛 INVALID_LEASE，预算耗尽抛 LEASE_BUDGET_EXHAUSTED（leaseDeadline）。
 * 时长非法、超过六十秒或预算在响应到达前已耗尽时分别抛出 INVALID_LEASE 与 LEASE_BUDGET_EXHAUSTED。
 */
export function leaseDeadline(
    grant: LeaseGrant,
    requestStarted: number,
    responseReceived: number,
): number {
    const duration = Date.parse(grant.leaseExpiresAt) - Date.parse(grant.serverTime);
    if (
        !Number.isFinite(duration) || duration <= 0 || duration > 60000 ||
        !Number.isSafeInteger(grant.leaseDurationMs) || grant.leaseDurationMs <= 0 ||
        grant.leaseDurationMs > 60000 || !Number.isFinite(requestStarted) ||
        !Number.isFinite(responseReceived) || requestStarted < 0 ||
        responseReceived < requestStarted
    ) throw new Error("INVALID_LEASE");
    // 从发送时刻起算扣完整往返，延迟应答也会吃掉租约预算。
    // 预留一秒让监督器在服务端授权结束前完成停机与排空。
    // Starting at send time deducts the complete roundtrip, including delayed responses.
    // A one-second reserve allows the supervisor to stop before the server authorization ends.
    const deadline = requestStarted + Math.min(duration, grant.leaseDurationMs) - 1000;
    if (deadline <= responseReceived) throw new Error("LEASE_BUDGET_EXHAUSTED");
    return deadline;
}
