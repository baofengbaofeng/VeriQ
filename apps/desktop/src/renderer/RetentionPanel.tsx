import { desktopErrorMessage } from "../shared/desktop-errors";
import { useEffect, useRef, useState } from "react";
import {
    localRetentionDefaults,
    parseLocalRetentionCommand,
    parseLocalRetentionOutcome,
    type LocalRetentionOutcome,
} from "../shared/retention-policy";

/**
 * 本机保留期表单只发送有限工作区与数字预算，路径和文件选择始终留在可信后台；同步请求门闩防止双击在 React 忙碌状态刷新
 * 前重放，退出页面或关闭窗口不会被误呈现为原生清理已经撤销或回滚。操作前由 main 显示真正原生确认，
 * renderer 不能直接提交 confirmed 标记。当前工作区变化只影响之后的操作，已开始操作始终保留其实际工作区标识。没有取消按
 * 钮，因为持久退休不支持通过关闭 UI 保证撤销。结果仅显示后端返回的有限计数，
 * 不把请求完成等同为整个档案已经清空。
 */
export function RetentionPanel({
    workspaceId,
    unavailable,
    onCompleted,
}: {
    workspaceId: string | undefined;
    unavailable: boolean;
    onCompleted: () => Promise<void>;
}) {
    const [policy, setPolicy] = useState({ ...localRetentionDefaults });
    const [pending, setPending] = useState(false);
    const [result, setResult] = useState<{ workspaceId: string; outcome: LocalRetentionOutcome }>();
    const [error, setError] = useState("");
    /**
     * 请求中状态使用同步 ref 而不是只依赖下一次 React render，两个快速提交不能在 disabled 生效前发出两份原生请求；
     * mount 标记只控制迟到UI更新，绝不把组件卸载当成后台操作的取消或事务回滚。
     * 参数输入仍保留用户刚填写的值，不因轮询状态重置表单。工作区由父层真实 Agent 状态提供，后台还会重新核对。禁用输入
     * 不会改变已经发出的命令或猜测已完成文件删除。StrictMode 清理后重新挂载会重新启用 UI 更新，
     * 资源没有全局监听泄漏。
     */
    const running = useRef(false);
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);
    const fields: { name: keyof typeof localRetentionDefaults; label: string }[] = [
        { name: "rawSuccessDays", label: "成功原始证据天数 / Successful raw evidence days" },
        { name: "rawFailureDays", label: "失败原始证据天数 / Failed raw evidence days" },
        { name: "metadataDays", label: "执行元数据天数 / Run metadata days" },
        { name: "bundleDays", label: "未访问资源包天数 / Unused package days" },
        { name: "batchSize", label: "本次批量上限 / Batch limit" },
    ];
    /**
     * 一次提交先解析有限数字并只调用明确的 pruneCache 能力，得到真实结果后再刷新界面；如果结果已经返回而刷新失败，提示
     * 必须区分这两件事，不能让用户误以为清理失败从而重放同一批次。setResult
     * 只存有限计数与原来工作区，不保存宿主路径或异常对象。原生确认取消通过已知错误码说明未发出保护操作。真正维护一旦开
     * 始，不提供会假称撤销的 AbortController 或取消按钮。finally 释放 UI
     * 请求门闩不表示后台未知请求已经终结。后续批次只能由用户重新提交，hasMore 不驱动自动定时清理。
     */
    async function prune() {
        if (running.current || !workspaceId) return;
        running.current = true;
        setPending(true);
        setError("");
        setResult(undefined);
        try {
            const command = parseLocalRetentionCommand({
                operation: "pruneCache",
                workspaceId,
                ...policy,
            });
            const value = parseLocalRetentionOutcome(await window.veriq.local(command));
            if (mounted.current) setResult({ workspaceId: command.workspaceId, outcome: value });
            try {
                await onCompleted();
            } catch {
                if (mounted.current)
                    setError(
                        "本批已返回真实结果，但界面刷新未完成；请先刷新，不要因刷新失败重复清理。 / T" +
                            "he batch returned an outcome, but refreshing failed" +
                            ". Refresh before requesting another cleanup.",
                    );
            }
        } catch (failure) {
            if (mounted.current) {
                setError(`${desktopErrorMessage(failure, "zh")} / ${desktopErrorMessage(failure, "en")}`);
            }
        } finally {
            running.current = false;
            if (mounted.current) setPending(false);
        }
    }
    /**
     * 所有保留期选项使用关联label与原生number约束，disabled fieldset 同时覆盖键盘和鼠标提交；结果以双语计数表呈现，并
     * 明确保留项和后续批次，不能把空数组或成功HTTP状态画成档案已经清空。
     * 工作区缺失时仍显示原因，用户无需猜测为什么按钮不可用。
     * 忙碌状态包含原生确认等待，因此一份请求不会被用户双击重放。
     * 结果区域保留最初命令的Workspace，切换空间也不会重标旧结果归属。
     * error/status使用真实可访问性语义，失败不只靠颜色表达。
     * 不渲染任何任意文件浏览器或命令参数输入。
     */
    return (
        <section className="panel" aria-busy={pending}>
            <h2>本机保留期清理 / Local retention cleanup</h2>
            <p>
                仅清理当前本机工作区的过期材料。未回传结果、活动执行和未知或隔离进程会保留。 / Only expired data in the
                current local workspace is eligible. Pending uploads, active work and unknown or quarantined ownership
                remain protected.
            </p>
            <p>
                旧缓存首次观察后开始计龄；访问已验签资源会刷新访问时间。 / Legacy cache starts aging when first
                observed; verified package access refreshes its age.
            </p>
            <form
                className="form-grid"
                onSubmit={(event) => {
                    event.preventDefault();
                    void prune();
                }}
            >
                <fieldset disabled={pending || unavailable || !workspaceId}>
                    <legend>保留策略 / Retention policy</legend>
                    {fields.map(({ name, label }) => (
                        <label key={name}>
                            <span className="field-required" aria-hidden="true">
                                *
                            </span>
                            {label}
                            <input
                                type="number"
                                min={1}
                                max={name === "batchSize" ? 100 : 3650}
                                step={1}
                                required
                                value={Number.isNaN(policy[name]) ? "" : policy[name]}
                                onChange={(event) =>
                                    setPolicy((current) => ({
                                        ...current,
                                        [name]: event.target.value === "" ? Number.NaN : Number(event.target.value),
                                    }))
                                }
                            />
                        </label>
                    ))}
                    <button type="submit">核对并清理一批 / Confirm and clean one batch</button>
                </fieldset>
            </form>
            {!workspaceId && <p>请先选择本机工作区。 / Choose a local workspace first.</p>}
            {unavailable && (
                <p>
                    请先停止执行、在线领取与查看器，再重试。 / Stop execution, online polling and viewers before
                    retrying.
                </p>
            )}
            {pending && (
                <p role="status">
                    正在等待原生确认或清理；关闭此页不会撤销已开始的操作。 / Awaiting native confirmation or cleanup;
                    closing this page does not undo a started operation.
                </p>
            )}
            {error && <p role="alert">{error}</p>}
            {result !== undefined && (
                <div role="status">
                    <p>本批工作区 / Workspace: {result.workspaceId}</p>
                    <dl>
                        <dt>已检查执行 / Runs examined</dt>
                        <dd>{result.outcome.examinedRuns}</dd>
                        <dt>已退休原始证据 / Runs with raw evidence retired</dt>
                        <dd>{result.outcome.rawRetiredRuns}</dd>
                        <dt>已退休执行元数据 / Run metadata retired</dt>
                        <dd>{result.outcome.metadataRetiredRuns}</dd>
                        <dt>已退休资源包 / Packages retired</dt>
                        <dd>{result.outcome.bundlesRetired}</dd>
                        <dt>保留或未满足条件 / Retained or ineligible candidates</dt>
                        <dd>{result.outcome.retained}</dd>
                    </dl>
                    <p>
                        {result.outcome.hasMore
                            ? "仍有后续候选，可核对后再次发起一批。 / More candidates remain; explicitly re" +
                              "quest another batch after c" +
                              "hecking."
                            : "本批已结束；保留项不代表所有材料都已清除。 / This batch ended; retained cand" +
                              "idates do not mean all data wa" +
                              "s cleared."}
                    </p>
                </div>
            )}
        </section>
    );
}
