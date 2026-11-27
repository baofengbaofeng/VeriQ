/**
 * 卡片表单和会话并列挂载。只有显式打开且仍受同一轮次、工作区授权的卡片能取得带操作来源的请求信号。
 */
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { scopeAgentFormSignal } from "../../api";
import { useAppLocale } from "../../locale";
import { PinnedFormWorkspace } from "../workspaces/WorkspaceContext";
import { PinnedFormDirectory } from "../workspaces/WorkspaceDirectory";
import { InlineFormRouter } from "./InlineFormRouter";
import { formDestination, formLabel, type FormLauncher, type WorkspaceFormReference } from "./workspace-forms";
import "./inline-form.css";

type OpenPanel = {
    mountId: number;
    href: string;
    reference: WorkspaceFormReference;
    signal: AbortSignal;
    controller: AbortController;
    onClose: () => void;
    trigger: HTMLElement | null;
};

export function WebAgentFormHost({
    workspaceId,
    signal,
    children,
}: {
    workspaceId: string;
    signal?: AbortSignal;
    children: (launcher: FormLauncher) => ReactNode;
}) {
    const { language } = useAppLocale();
    const [panel, setPanel] = useState<OpenPanel>();
    const active = useRef<OpenPanel>();
    const mountId = useRef(0);
    const closeButton = useRef<HTMLButtonElement>(null);
    const launcher = useMemo<FormLauncher>(
        () => ({
            platform: "web",
            open(destination, reference, source, onClose) {
                if (
                    destination.platform !== "web" ||
                    reference.workspaceId !== workspaceId ||
                    destination.workspaceId !== workspaceId ||
                    signal?.aborted ||
                    source.aborted
                )
                    return;
                const expected = formDestination({ type: "OPEN_WORKSPACE_FORM", ...reference }, "web");
                if (expected?.platform !== "web" || destination.href !== expected.href) return;
                const previous = active.current;
                previous?.controller.abort();
                previous?.onClose();
                const controller = new AbortController();
                const lifetime = AbortSignal.any(
                    signal ? [controller.signal, signal, source] : [controller.signal, source],
                );
                const next = {
                    mountId: ++mountId.current,
                    href: expected.href,
                    reference,
                    controller,
                    onClose,
                    signal: scopeAgentFormSignal(lifetime, reference.turnId, reference.capability),
                    trigger: document.activeElement instanceof HTMLElement ? document.activeElement : null,
                };
                active.current = next;
                setPanel(next);
            },
        }),
        [workspaceId, signal],
    );
    useLayoutEffect(
        () => () => {
            const current = active.current;
            active.current = undefined;
            current?.controller.abort();
        },
        [],
    );
    useLayoutEffect(() => {
        if (!panel) return;
        const retire = () => {
            if (active.current !== panel) return;
            active.current = undefined;
            setPanel(undefined);
        };
        if (panel.signal.aborted) retire();
        else {
            panel.signal.addEventListener("abort", retire, { once: true });
            closeButton.current?.focus();
        }
        return () => panel.signal.removeEventListener("abort", retire);
    }, [panel]);
    function close() {
        if (!panel || panel.signal.aborted) return;
        panel.controller.abort();
        panel.onClose();
        if (panel.trigger?.isConnected) panel.trigger.focus();
    }
    const label = panel && formLabel(panel.reference.capability, language);
    return (
        <>
            {panel && !panel.signal.aborted && (
                <section className="vq-agent-inline-form" aria-label={label}>
                    <header>
                        <h2>{label}</h2>
                        <button ref={closeButton} type="button" onClick={close}>
                            {language === "zh" ? "关闭表单" : "Close form"}
                        </button>
                    </header>
                    <PinnedFormWorkspace key={panel.mountId} selected={workspaceId} signal={panel.signal}>
                        <PinnedFormDirectory id={workspaceId} signal={panel.signal}>
                            <InlineFormRouter href={panel.href} reference={panel.reference} signal={panel.signal} />
                        </PinnedFormDirectory>
                    </PinnedFormWorkspace>
                </section>
            )}
            {children(launcher)}
        </>
    );
}
