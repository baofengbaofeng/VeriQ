/**
 * 桌面窗口使用本地内存路由挂载同一组管理表单。员工资料与成员详情分别通过现有宿主操作核验，每次打开独立持有查询缓存。
 */
import { useQuery } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { api } from "../../api";
import { Auth } from "../../auth-context";
import { tx, useAppLocale } from "../../locale";
import type { ReportAdapter } from "../reports/adapters";
import { PinnedFormWorkspace } from "../workspaces/WorkspaceContext";
import { PinnedFormDirectory } from "../workspaces/WorkspaceDirectory";
import { InlineFormRouter } from "./InlineFormRouter";
import { formDestination, type WorkspaceFormReference } from "./workspace-forms";

type Props = {
    employeeId: string;
    href: string;
    reference: WorkspaceFormReference;
    signal: AbortSignal;
    reports: ReportAdapter;
};

export function DesktopManagementForm(props: Props) {
    const { reference, signal, href } = props;
    const target = formDestination({ type: "OPEN_WORKSPACE_FORM", ...reference }, "desktop");
    if (signal.aborted || target?.platform !== "desktop" || target.tab !== "management" || target.href !== href)
        return null;
    return (
        <PinnedFormWorkspace selected={reference.workspaceId} signal={signal}>
            <DesktopFormIdentity {...props} />
        </PinnedFormWorkspace>
    );
}

/**
 * 宿主登录摘要只用于比对当前员工身份；角色和账号状态均取自当前员工资料。身份失效或响应不匹配时不挂载领域页。
 */
function DesktopFormIdentity({ employeeId, href, reference, signal, reports }: Props) {
    const { language } = useAppLocale();
    const account = useQuery({
        queryKey: ["agent-form-employee", employeeId],
        queryFn: ({ signal: querySignal }) => api.account(AbortSignal.any([querySignal, signal])),
    });
    if (signal.aborted) return null;
    if (account.isPending) return <p role="status">{tx("Loading VeriQ…")}</p>;
    if (!account.isSuccess || !account.data || account.data.id !== employeeId || account.data.disabled)
        return (
            <p role="alert">
                {language === "zh" ? "无法验证当前员工身份。" : "Unable to verify the current employee."}
            </p>
        );
    return (
        <Auth.Provider
            value={{
                user: account.data,
                refresh: async () => {
                    await account.refetch();
                },
                setupComplete: () => {},
            }}
        >
            <PinnedFormDirectory id={reference.workspaceId} signal={signal}>
                <MemoryRouter>
                    <InlineFormRouter href={href} reference={reference} signal={signal} nativeReportAdapter={reports} />
                </MemoryRouter>
            </PinnedFormDirectory>
        </Auth.Provider>
    );
}
