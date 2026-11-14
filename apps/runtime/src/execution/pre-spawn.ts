/** 在线与离线的未派生状态采用明确白名单而非排除某个启动中状态，未知新状态默认失败关闭；此函数只识别状态名称，持久提交、所有权代际与未结清原生意图仍须由各调用入口独立核实。 */
export function isPreSpawnState(state: string, source: "ONLINE" | "OFFLINE"): boolean {
    /** 两种状态机只有初始分配阶段含义相同，离线恢复只接受事务已明确标记的未派生代际；普通 RECOVERING 即便尚无内存 ChildProcess，也不能借共享函数得到未派生的停止结论。 */
    return source === "ONLINE"
        ? ["ALLOCATED", "ACTIVATING", "ACTIVATED"].includes(state)
        : ["ALLOCATED", "RECOVERING_UNSPAWNED"].includes(state);
}
