/**
 * 桌面测试对话保留在同一挂载位置，已经过服务端复核的表单在旁边复用普通领域视图，关闭时刷新原轮次回执。
 */
import { useCallback, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import {
    AgentWorkspaceView,
    DesktopManagementForm,
    canExportWorkspaceTable,
    formLabel,
    ReportWorkspaceView,
    ResourceWorkspaceView,
    scopeAgentFormSignal,
    type Workspace,
    type WorkspaceFormReference,
    type WorkspaceFormDestination,
} from "@veriq/web/desktop";
import type { cloudAdapters } from "./adapters";
import { RetentionPanel } from "./RetentionPanel";

type Destination = Extract<WorkspaceFormDestination, { platform: "desktop" }>;
type Form = {
    destination: Destination;
    reference: WorkspaceFormReference;
    mountId: number;
    signal: AbortSignal;
    controller: AbortController;
    onClose: () => void;
    opener: HTMLElement | null;
};
type AgentProps = ComponentProps<typeof AgentWorkspaceView>;
type Props = Pick<AgentProps, "owner" | "navigate"> & {
    employeeId: string;
    parentSignal: AbortSignal;
    workspace: Workspace;
    adapters: ReturnType<typeof cloudAdapters>;
    language: "zh" | "en";
    localWorkspaceId: string | undefined;
    retentionUnavailable: boolean;
    onRetentionComplete: () => Promise<void>;
};

export function DesktopAgentForms({
    workspace,
    owner,
    employeeId,
    navigate,
    parentSignal,
    adapters,
    language,
    localWorkspaceId,
    retentionUnavailable,
    onRetentionComplete,
}: Props) {
    const current = useRef<Form>();
    const mounts = useRef(0);
    const [form, setForm] = useState<Form>();
    const closeButton = useRef<HTMLButtonElement>(null);
    const close = useCallback((target: Form, refresh: boolean) => {
        if (current.current !== target) return;
        current.current = undefined;
        target.controller.abort();
        setForm(undefined);
        if (refresh) {
            target.onClose();
            if (target.opener?.isConnected) target.opener.focus();
        }
    }, []);
    useLayoutEffect(() => {
        if (!form) return;
        const leave = () => close(form, false);
        if (form.signal.aborted) leave();
        else {
            form.signal.addEventListener("abort", leave, { once: true });
            closeButton.current?.focus();
        }
        return () => form.signal.removeEventListener("abort", leave);
    }, [form, close]);
    useLayoutEffect(() => () => current.current?.controller.abort(), []);
    const launcher: NonNullable<AgentProps["formLauncher"]> = {
        platform: "desktop",
        open: (destination, ref, signal, onClose) => {
            if (
                parentSignal.aborted ||
                signal.aborted ||
                destination.platform !== "desktop" ||
                destination.workspaceId !== workspace.id ||
                ref.workspaceId !== workspace.id
            )
                return;
            const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            if (current.current) close(current.current, true);
            const controller = new AbortController();
            const active = scopeAgentFormSignal(
                AbortSignal.any([parentSignal, signal, controller.signal]),
                ref.turnId,
                ref.capability,
            );
            const next = {
                destination,
                reference: ref,
                mountId: ++mounts.current,
                signal: active,
                controller,
                opener,
                onClose,
            };
            current.current = next;
            setForm(next);
        },
    };
    const localMatches = localWorkspaceId === workspace.id;
    return (
        <div className={form ? "agent-native-layout agent-native-open" : "agent-native-layout"}>
            <AgentWorkspaceView
                workspace={workspace}
                owner={owner}
                adapter={adapters.conversation}
                providers={adapters.ai}
                reports={adapters.reports}
                parentSignal={parentSignal}
                formLauncher={launcher}
                navigate={navigate}
            />
            {form && !form.signal.aborted && (
                <aside className="agent-native-form" aria-labelledby="desktop-agent-form-title" key={form.mountId}>
                    <header className="agent-native-form-header">
                        <h3 id="desktop-agent-form-title">{formLabel(form.reference.capability, language)}</h3>
                        <button type="button" ref={closeButton} onClick={() => close(form, true)}>
                            {language === "zh" ? "关闭表单" : "Close form"}
                        </button>
                    </header>
                    {form.destination.tab === "management" && (
                        <DesktopManagementForm
                            employeeId={employeeId}
                            href={form.destination.href}
                            reference={form.reference}
                            signal={form.signal}
                            reports={adapters.reports}
                        />
                    )}
                    {form.destination.tab === "resources" && (
                        <ResourceWorkspaceView
                            workspace={workspace}
                            adapter={adapters.resources}
                            fixedKind={form.destination.resourceKind}
                            signal={form.signal}
                        />
                    )}
                    {form.destination.tab === "reports" && (
                        <ReportWorkspaceView
                            adapter={adapters.reports}
                            signal={form.signal}
                            initialAuditOpen={form.reference.capability === "WORKSPACE_AUDIT"}
                            rawEvidenceAllowed={workspace.role === "OWNER" || workspace.role === "ADMIN"}
                            allowTableExport={canExportWorkspaceTable(workspace.role)}
                        />
                    )}
                    {form.destination.tab === "settings" &&
                        (localMatches ? (
                            <RetentionPanel
                                workspaceId={workspace.id}
                                unavailable={retentionUnavailable}
                                onCompleted={onRetentionComplete}
                            />
                        ) : (
                            <p role="status">
                                {language === "zh"
                                    ? "请先将本机 Agent 切换到此工作区。"
                                    : "Select this workspace in the local Agent to manage its retention."}
                            </p>
                        ))}
                </aside>
            )}
        </div>
    );
}
