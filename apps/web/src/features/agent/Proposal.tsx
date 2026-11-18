/**
 * 对话中的提议展示服务器审核过的选择及原计划快照，回执则单独展示已完成的保存或派发结果。
 */
import { tx } from "../../locale";
import type { AgentSchemas } from "./adapters";

type ProposalValue = AgentSchemas["AgentProposal"];
type Receipt = AgentSchemas["AgentReceipt"];
type Preview = AgentSchemas["AgentPlanPreview"];
type Field = readonly [label: string, value: string | number | undefined, previous?: string | number];

const headings = { SAVE_PLAN: "Plan preview", TRIGGER_PLAN: "Saved plan run", RUN_ONCE: "One-time run" };
const confirmations = {
    SAVE_PLAN: "Confirm save plan",
    TRIGGER_PLAN: "Confirm run saved plan",
    RUN_ONCE: "Confirm one-time run",
};
const list = (values: readonly string[]) => values.join(", ") || "—";

// 原计划和新预览使用相同字段顺序，每列仅比较允许公开的计划数据，计划变量始终不在此表中出现。
function fields(plan: Preview): Field[] {
    return [
        ["Plan name", plan.name],
        ["Revision", plan.revision],
        ["Suite version", plan.suiteVersionId],
        ["Environment version", plan.environmentVersionId],
        ["Browsers", list(plan.browsers)],
        ["Runtime IDs", list(plan.runtimeIds)],
        ["Role keys", list(plan.roleKeys)],
        ["Overlap policy", plan.overlapPolicy],
        ["Case retries", plan.maxCaseRetries],
    ];
}

function selection(proposal: ProposalValue): Field[] {
    if (proposal.type === "SAVE_PLAN") {
        const previous = proposal.previousPlan ? fields(proposal.previousPlan) : undefined;
        return [
            ["Plan ID", proposal.planId],
            ...fields(proposal.plan).map(([label, value], index): Field => [label, value, previous?.[index]?.[1]]),
        ];
    }
    const base: Field[] = [
        ["Plan ID", proposal.planId],
        ["Revision", proposal.planRevision],
    ];
    if (proposal.type === "TRIGGER_PLAN")
        return [...base, ["Build SHA", proposal.triggerInput?.buildSha], ["Reason", proposal.triggerInput?.reason]];

    // 一次运行保留实际预选范围，客户端不把一组已发布用例展示成一个持久化套件或覆盖原计划。
    const run = proposal.selection;
    return [
        ...base,
        "suiteVersionId" in run ? ["Suite version", run.suiteVersionId] : ["Case versions", list(run.caseVersionIds)],
        ["Environment version", run.environmentVersionId],
        ["Browsers", list(run.browsers)],
        ["Runtime IDs", list(run.runtimeIds)],
        ["Role keys", list(run.roleKeys)],
        ["Case retries", run.maxRetries],
    ];
}

/**
 * 预览不从回复字符串推断操作，按钮由已验证的提议类别及外部权限控制，每类操作都使用明确的动作名称。
 */
export function Proposal({
    proposal,
    confirm,
    disabled,
}: {
    proposal: ProposalValue;
    confirm?: () => void;
    disabled: boolean;
}) {
    const title = tx(headings[proposal.type]);
    return (
        <section className="vq-agent-card" aria-label={title}>
            <h4>{title}</h4>
            <dl>
                {selection(proposal).map(([label, value, previous]) =>
                    value === undefined ? null : (
                        <div className="vq-agent-field" key={label}>
                            <dt>{tx(label)}</dt>
                            <dd>
                                {previous !== undefined && previous !== value ? (
                                    <>
                                        <span>
                                            {tx("Previous")} <del>{previous}</del>
                                        </span>
                                        <span>
                                            {tx("Proposed")} <ins>{value}</ins>
                                        </span>
                                    </>
                                ) : (
                                    value
                                )}
                            </dd>
                        </div>
                    ),
                )}
            </dl>
            {confirm && (
                <button type="button" disabled={disabled} onClick={confirm}>
                    {tx(confirmations[proposal.type])}
                </button>
            )}
        </section>
    );
}

/**
 * 每轮保留业务回执，包括同一 Run 上不同的派发决定；运行状态与门禁再由去重的报告卡独立读取和更新。
 */
export function ActionReceipt({ receipt }: { receipt: Receipt }) {
    if (receipt.type === "RUN_ONCE")
        return (
            <p>
                {tx("Run receipt")} <code>{receipt.runId}</code>
            </p>
        );
    if (receipt.type === "TRIGGER_PLAN")
        return (
            <p>
                {tx("Run receipt")} <code>{receipt.runId}</code> · {receipt.decision}
                {" · "} {tx("Revision")} {receipt.planRevision}
            </p>
        );
    return (
        <section className="vq-agent-card" aria-label={tx("Plan saved")}>
            <strong>{tx("Plan saved")}</strong>
            <p>
                {tx("Plan ID")} <code>{receipt.planId}</code> · {tx("Revision")} {receipt.planRevision}
            </p>
        </section>
    );
}
