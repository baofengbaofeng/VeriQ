/**
 * 每次点击都向该员工保存的轮次重新取得表单卡；宿主只收到验证后的内部目标，切换会话或离开页面会取消等待。
 */
import { useLayoutEffect, useRef, useState } from "react";
import { useAppLocale } from "../../locale";
import {
    authorizedFormDestination,
    formDestination,
    formLabel,
    isWorkspaceFormCard,
    type FormLauncher,
    type WorkspaceFormCard,
} from "./workspace-forms";

export type { WorkspaceFormCard, WorkspaceFormDestination } from "./workspace-forms";

export function CapabilityCard({
    card,
    workspaceId,
    sessionId,
    turnId,
    signal,
    launcher,
    authorize,
    onClose,
}: {
    card: WorkspaceFormCard;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    signal: AbortSignal;
    launcher: FormLauncher;
    authorize: (signal: AbortSignal) => Promise<WorkspaceFormCard>;
    onClose?: () => void;
}) {
    const { language } = useAppLocale();
    const pending = useRef<AbortController>();
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState(false);
    useLayoutEffect(() => () => pending.current?.abort(), []);
    if (!isWorkspaceFormCard(card) || card.workspaceId !== workspaceId || signal.aborted) return null;
    const label = formLabel(card.capability, language);
    const native = formDestination(card, launcher.platform);
    const external = !native && launcher.platform === "desktop" ? launcher.openWebForm : undefined;
    if (!native && !external) {
        const hint =
            launcher.platform === "web"
                ? language === "zh"
                    ? "请在桌面端的设置与诊断中打开。"
                    : "Open Settings & diagnostics in the desktop app."
                : language === "zh"
                  ? "请在已登录的 Web 控制台中打开。"
                  : "Open the signed-in Web console.";
        return (
            <p>
                <strong>{label}</strong> {hint}
            </p>
        );
    }
    async function open() {
        if (pending.current || signal.aborted) return;
        const controller = new AbortController();
        pending.current = controller;
        const active = AbortSignal.any([signal, controller.signal]);
        setBusy(true);
        setFailed(false);
        try {
            const destination = await authorizedFormDestination(
                card,
                workspaceId,
                external ? "web" : launcher.platform,
                active,
                () => authorize(active),
            );
            if (!destination || active.aborted) return;
            const ref = { workspaceId, sessionId, turnId, capability: card.capability };
            if (external) await external(ref, active);
            else
                launcher.open(destination, ref, signal, () => {
                    if (!signal.aborted) onClose?.();
                });
        } catch {
            if (!active.aborted) setFailed(true);
        } finally {
            pending.current = undefined;
            if (!active.aborted) setBusy(false);
        }
    }
    return (
        <div>
            <button type="button" disabled={busy} onClick={() => void open()}>
                {external ? (language === "zh" ? `${label}（浏览器）` : `${label} (browser)`) : label}
            </button>
            {failed && (
                <p role="alert">
                    {language === "zh"
                        ? "暂时无法打开此表单，请检查当前访问权限后重试。"
                        : "Unable to open the form. Check your access and try again."}
                </p>
            )}
        </div>
    );
}
