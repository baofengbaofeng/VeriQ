import assert from "node:assert/strict";
import test from "node:test";
import {
    localRetentionDefaults,
    parseLocalRetentionCommand,
    parseLocalRetentionOutcome,
} from "../src/shared/retention-policy.ts";
import { desktopErrorMessage } from "../src/shared/desktop-errors.ts";

const workspaceId = "11111111-1111-4111-8111-111111111111";

/**
 * 保留期协议只允许实际维护器支持的工作区和有限数字策略，测试验证正常能力与超限、分数、路径扩张的拒绝结果；不靠扫描源码
 * 关键字，也不把纯协议测试冒充 SQLite、原生文件或真实删除已经执行。
 */
test("retention policy permits bounded commands and refuses filesystem extensions", () => {
    const command = { operation: "pruneCache", workspaceId, ...localRetentionDefaults };
    assert.deepEqual(parseLocalRetentionCommand(command), command);
    for (const values of [
        { ...command, metadataDays: 0 },
        { ...command, bundleDays: 3651 },
        { ...command, rawSuccessDays: 1.5 },
        { ...command, rawFailureDays: Number.NaN },
        { ...command, batchSize: 101 },
        { ...command, workspaceId: "../other" },
        { ...command, profileRoot: "/other/profile" },
        { ...command, confirmed: true },
    ])
        assert.throws(() => parseLocalRetentionCommand(values), /LOCAL_RETENTION_INPUT_INVALID/);
});

/**
 * 用户提示保留有限机器错误码但必须解释忙碌或未确认结果，并去除异常中的宿主私有路径和系统堆栈；中英文都提供后续动作，未
 * 知错误也不能因为没有词条就回显未经筛选的原生异常正文。
 */
test("desktop errors provide actionable languages without exposing raw host messages", () => {
    assert.match(desktopErrorMessage(new Error("AGENT_BUSY"), "en"), /Wait for completion/);
    assert.match(desktopErrorMessage("LOCAL_RETENTION_INPUT_INVALID", "zh"), /3650/);
    for (const language of ["zh", "en"] as const) {
        const message = desktopErrorMessage(
            new Error("Read failed at /private/user/secret-file: UNKNOWN_NATIVE_ERROR"),
            language,
        );
        assert.match(message, /DESKTOP_OPERATION_FAILED/);
        assert.doesNotMatch(message, /secret-file|\/private\/user/);
    }
    assert.match(desktopErrorMessage("AGENT_REQUEST_TIMEOUT", "en"), /rollback is not guaranteed/);
    assert.match(
        desktopErrorMessage("Error invoking remote method 'veriq:desktop': Error: UNKNOWN_NATIVE_ERROR", "en"),
        /UNKNOWN_NATIVE_ERROR/,
    );
});

/**
 * 清理回执必须保留实际非负计数而且只包含受限协议字段，不能将缺少结果、未知路径或未确认计数转成空成功；结果解析位于真实
 * 维护之后，所以本测试只覆盖投影边界，不声明原生退休已经回滚或完成。
 */
test("retention outcome rejects empty success and unexpected filesystem data", () => {
    const outcome = {
        examinedRuns: 3,
        rawRetiredRuns: 1,
        metadataRetiredRuns: 0,
        bundlesRetired: 1,
        retained: 2,
        hasMore: true,
    };
    assert.deepEqual(parseLocalRetentionOutcome(outcome), outcome);
    for (const value of [
        undefined,
        {},
        { ...outcome, retained: -1 },
        { ...outcome, hasMore: "true" },
        { ...outcome, files: ["/private/profile"] },
    ])
        assert.throws(() => parseLocalRetentionOutcome(value), /LOCAL_RETENTION_RESULT_INVALID/);
});
