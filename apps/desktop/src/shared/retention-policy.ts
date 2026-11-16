/** 桌面保留期命令只包含当前工作区标识和有限天数及批量预算，不能带档案根、文件名或清理路径；main 在原生确认前与 Agent 在调用真实维护器前复用同一解析规则，静态类型不替代实际参数检查。 */
export interface LocalRetentionCommand {
    operation: "pruneCache";
    workspaceId: string;
    metadataDays: number;
    bundleDays: number;
    rawSuccessDays: number;
    rawFailureDays: number;
    batchSize: number;
}

/** 默认保留策略与本机维护器的现有业务约定一致，成功和失败原始证据分别计龄并保留更长的失败窗口；默认值只是交互初值，实际到期、停止证明和未回传保护仍由独立 Node 的持久维护事务决定。 */
export const localRetentionDefaults = Object.freeze({
    metadataDays: 90,
    bundleDays: 14,
    rawSuccessDays: 14,
    rawFailureDays: 30,
    batchSize: 50,
});

/** 所有预算都要求安全整数，天数限制一到三千六百五十且批量最多一百，未知字段直接拒绝而不能悄悄透传底层文件系统能力；工作区仍须由后台与当前真实选择逐字匹配，合法 UUID 不构成跨空间授权。 */
export function parseLocalRetentionCommand(input: unknown): LocalRetentionCommand {
    if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error("LOCAL_RETENTION_INPUT_INVALID");
    const value = input as Record<string, unknown>;
    const keys = ["operation", "workspaceId", ...Object.keys(localRetentionDefaults)];
    if (
        Object.keys(value).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(value, key)) ||
        value.operation !== "pruneCache" ||
        typeof value.workspaceId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.workspaceId)
    )
        throw new Error("LOCAL_RETENTION_INPUT_INVALID");
    for (const name of Object.keys(localRetentionDefaults)) {
        const number = value[name];
        if (
            typeof number !== "number" ||
            !Number.isSafeInteger(number) ||
            number < 1 ||
            number > (name === "batchSize" ? 100 : 3650)
        )
            throw new Error("LOCAL_RETENTION_INPUT_INVALID");
    }
    return {
        operation: "pruneCache",
        workspaceId: value.workspaceId,
        metadataDays: value.metadataDays as number,
        bundleDays: value.bundleDays as number,
        rawSuccessDays: value.rawSuccessDays as number,
        rawFailureDays: value.rawFailureDays as number,
        batchSize: value.batchSize as number,
    };
}

/** 本机维护结果只包含实际有界计数与后续批次提示，renderer 不接受后端附带任意文件路径或原始异常作为展示材料；retained 表示未满足年龄、上传或停止条件的候选，不能用零退休推断没有缓存或报告。 */
export interface LocalRetentionOutcome {
    examinedRuns: number;
    rawRetiredRuns: number;
    metadataRetiredRuns: number;
    bundlesRetired: number;
    retained: number;
    hasMore: boolean;
}

/** 返回值也要做有限结构核验后再进入用户结果表，协议失败不能用空计数假装维护成功；这个校验发生在持久操作之后，因此失败提示必须保留不确定性，不能向用户承诺原生操作已经撤销。 */
export function parseLocalRetentionOutcome(input: unknown): LocalRetentionOutcome {
    if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error("LOCAL_RETENTION_RESULT_INVALID");
    const value = input as Record<string, unknown>;
    const counters = [
        "examinedRuns",
        "rawRetiredRuns",
        "metadataRetiredRuns",
        "bundlesRetired",
        "retained",
    ];
    if (
        Object.keys(value).length !== counters.length + 1 ||
        Object.keys(value).some((key) => ![...counters, "hasMore"].includes(key)) ||
        !Object.hasOwn(value, "hasMore") ||
        typeof value.hasMore !== "boolean"
    )
        throw new Error("LOCAL_RETENTION_RESULT_INVALID");
    for (const name of counters) {
        const count = value[name];
        if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
            throw new Error("LOCAL_RETENTION_RESULT_INVALID");
    }
    return {
        examinedRuns: value.examinedRuns as number,
        rawRetiredRuns: value.rawRetiredRuns as number,
        metadataRetiredRuns: value.metadataRetiredRuns as number,
        bundlesRetired: value.bundlesRetired as number,
        retained: value.retained as number,
        hasMore: value.hasMore,
    };
}
