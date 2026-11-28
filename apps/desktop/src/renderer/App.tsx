import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
    ResourceWorkspaceView,
    ReportWorkspaceView,
    AiWorkspaceView,
    appI18n,
    canExportWorkspaceTable,
    setAppLanguage,
    type Workspace,
} from "@veriq/web/desktop";
import type { PlatformComponents } from "@veriq/contracts";
import type { DesktopState } from "../shared/bridge";
import { DesktopAgentForms } from "./AgentForms";
import { RetentionPanel } from "./RetentionPanel";
import { RecordingResources } from "./recording/RecordingResources";
import { RecordingWorkspace } from "./recording/RecordingWorkspace";
import { desktopErrorMessage, desktopStateLabel } from "../shared/desktop-errors";
import { credentialGuidance } from "../shared/credential-status";
import { cloudAdapters, DesktopLocalReports } from "./adapters";

type S = PlatformComponents["schemas"];
const tabs = ["overview", "resources", "recording", "reports", "ai", "conversation", "settings"] as const;
type Tab = (typeof tabs)[number];
const bridge = window.veriq;
const labels = {
    zh: {
        overview: "工作台",
        resources: "云端资源",
        recording: "浏览器测试设计",
        reports: "报告与历史",
        ai: "AI 辅助",
        conversation: "测试 Agent",
        settings: "设置与诊断",
        loading: "正在读取…",
        signIn: "登录",
        signOut: "退出登录",
        refresh: "刷新",
        workspace: "工作区",
        cancel: "取消执行",
        cancelStartup: "取消启动",
        empty: "尚无本机执行记录",
        error: "操作未完成",
        connected: "已登录",
        offline: "离线 / 未登录",
        select: "选择",
        save: "保存",
        stop: "停止后台",
        quit: "退出界面",
        tray: "收起窗口",
    },
    en: {
        overview: "Overview",
        resources: "Cloud resources",
        recording: "Browser test design",
        reports: "Reports & history",
        ai: "AI assistance",
        conversation: "Test Agent",
        settings: "Settings & diagnostics",
        loading: "Loading…",
        signIn: "Sign in",
        signOut: "Sign out",
        refresh: "Refresh",
        workspace: "Workspace",
        cancel: "Cancel run",
        cancelStartup: "Cancel startup",
        empty: "No local runs yet",
        error: "Operation failed",
        connected: "Signed in",
        offline: "Offline / signed out",
        select: "Select",
        save: "Save",
        stop: "Stop Agent",
        quit: "Quit UI",
        tray: "Minimize window",
    },
};

/**
 * 桌面工作台把平台会话与本机后台明确区分，联网编辑复用共享视图，断网缓存继续使用验签后的只读适配器；状态轮询仅读取后台
 * 事实，窗口关闭和页面切换都不会改变执行归属。
 */
export function App() {
    const [language, setLanguage] = useState<"zh" | "en">(appI18n.language.startsWith("zh") ? "zh" : "en"),
        t = labels[language];
    const [tab, setTab] = useState<Tab>("overview"),
        [state, setState] = useState<DesktopState>();
    const [error, setError] = useState(""),
        [busy, setBusy] = useState(false),
        [notice, setNotice] = useState("");
    const [email, setEmail] = useState(""),
        [password, setPassword] = useState("");
    const [origin, setOrigin] = useState(""),
        [proxy, setProxy] = useState("");
    const [workspaces, setWorkspaces] = useState<Workspace[]>([]),
        [workspace, setWorkspace] = useState<Workspace>();
    const [localWorkspace, setLocalWorkspace] = useState("");
    const [runId, setRun] = useState(""),
        [reportLocal, setReportLocal] = useState(false);
    const [cloudRun, setCloudRun] = useState<{ owner: string; id: string }>();
    const [deviceName, setDeviceName] = useState("VeriQ Desktop");
    const [enrollment, setEnrollment] = useState<Omit<S["EnrollmentDTO"], "deviceCode">>();
    const [shared, setShared] = useState(false),
        [device, setDevice] = useState<S["RuntimeDTO"]>();
    const [issuer, setIssuer] = useState(""),
        [fingerprint, setFingerprint] = useState("");
    const [diagnostics, setDiagnostics] = useState<unknown>();
    const queries = useQueryClient();
    const workspaceId = workspace?.id;
    // 在线对话和报告入口以真实会话身份及平台源为键，同一个 UUID 在另一登录或源下不能复用私有查询结果或运行选择。
    const userId = state?.user?.user.id;
    const conversationOwner = userId ? `${state?.origin}/${userId}` : "";
    const cloudScope = `${conversationOwner}/${workspaceId ?? ""}`;
    const initialCloudRun = cloudRun?.owner === cloudScope ? cloudRun.id : "";
    const adapters = useMemo(() => (workspaceId ? cloudAdapters(workspaceId) : undefined), [workspaceId]);
    const localReports = useMemo(
        () => (localWorkspace ? new DesktopLocalReports(localWorkspace) : undefined),
        [localWorkspace],
    );
    // 控制器随平台、员工、工作区和本机云端视图更改。清理允许旧订阅退出而不影响服务器执行。
    // biome-ignore lint/correctness/useExhaustiveDependencies: 依赖随授权视图作用域变化
    const scope = useMemo(() => new AbortController(), [cloudScope, localWorkspace, reportLocal]);
    const agent = state?.agent;
    const installedRuntimeRequired = state?.sourceWorkbench === true;

    const refresh = useCallback(async () => {
        const value = await bridge.state();
        setState(value);
        setOrigin((current) => current || value.origin);
        setWorkspace(value.workspace);
        if (value.agent?.workspaceId) setLocalWorkspace(value.agent.workspaceId);
    }, []);
    /**
     * 统一动作包装器只管理本次交互的忙碌、错误和刷新状态，不将捕获异常改写成成功结果；后台执行有独立的 preparing 和
     * active 状态，因此 UI 请求结束并不代表业务 Run 已经终结。
     */
    async function action(work: () => Promise<unknown>) {
        setBusy(true);
        setError("");
        setNotice("");
        try {
            await work();
            await refresh();
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
            setBusy(false);
        }
    }
    useEffect(() => {
        void refresh().catch((error) => setError(String(error)));
        const timer = setInterval(() => void refresh().catch((error) => setError(String(error))), 1500);
        return () => clearInterval(timer);
    }, [refresh]);
    useEffect(
        () => () => {
            scope.abort();
            void queries.cancelQueries();
            queries.removeQueries();
        },
        [scope, queries],
    );
    /**
     * 本地窗口只订阅共享应用实例，不再同时维护第二套编辑器和 AI 语言切换逻辑；Provider 负责各命名空间及偏好桥接，卸载
     * 时这里移除自己的监听，不重建表单、Workspace 或报告请求作用域。
     */
    useEffect(() => {
        const changed = (next: string) => setLanguage(next.startsWith("zh") ? "zh" : "en");
        appI18n.on("languageChanged", changed);
        changed(appI18n.language);
        return () => {
            appI18n.off("languageChanged", changed);
        };
    }, []);

    /**
     * 普通登录只经过专用宿主 Session，成功后清空输入框中的密码并加载真实成员工作区；设备登记状态由另一组后台字段显示，
     * 登录成功不能被用来代替设备令牌的注册流程。
     */
    async function login() {
        await bridge.login({ email, password });
        setPassword("");
        setWorkspaces((await bridge.workspaces()).items);
        setNotice(t.connected);
    }
    /**
     * 云端工作区切换等待宿主完成成员检查后才更新页面，并清空共享查询缓存和旧资源报告选择；已有本机 Run 的持久状态由独
     * 立Agent 保留，清除页面选择不会取消执行。
     */
    async function selectWorkspace(id: string) {
        const selected = await bridge.select(id);
        setWorkspace(selected);
        queries.clear();
        setRun("");
        setCloudRun(undefined);
    }
    const roles = workspace?.role;

    return (
        <div className="desktop-shell">
            <aside className="desktop-sidebar">
                <div className="desktop-brand">
                    <span className="brand-mark">V</span>
                    <div>
                        <strong>VeriQ</strong>
                        <small>Deterministic testing</small>
                    </div>
                </div>
                <nav aria-label="主导航 / Navigation">
                    {tabs.map((key) => (
                        <button
                            type="button"
                            key={key}
                            aria-current={tab === key ? "page" : undefined}
                            onClick={() => {
                                setError("");
                                setTab(key);
                            }}
                        >
                            {t[key]}
                        </button>
                    ))}
                </nav>
                {!installedRuntimeRequired && (
                    <div className="sidebar-status">
                        <span className={agent ? "status-dot ready" : "status-dot"} />
                        {agent
                            ? `Agent · Node ${agent.node}`
                            : state?.agentIssue === "LOCAL_CACHE_MAINTENANCE_BUSY"
                              ? "后台维护中 / Agent maintenance"
                              : "后台不可用 / Agent unavailable"}
                        <small>
                            {!agent
                                ? "状态未确认 / Status unconfirmed"
                                : agent.preparing
                                  ? "准备中 / Preparing"
                                  : agent.active
                                    ? desktopStateLabel(agent.active.state)
                                    : agent.online
                                      ? "在线领取 / Online worker"
                                      : "就绪 / Idle"}
                        </small>
                        {agent?.preparing && (
                            <button
                                type="button"
                                disabled={agent.preparing.cancelling}
                                onClick={() => {
                                    const startupId = agent.preparing?.id;
                                    if (startupId) void action(() => bridge.local({ operation: "cancel", startupId }));
                                }}
                            >
                                {t.cancelStartup}
                            </button>
                        )}
                    </div>
                )}
                <button type="button" onClick={() => void action(() => bridge.lifecycle("hide"))}>
                    {t.tray}
                </button>
                <button type="button" onClick={() => void action(() => bridge.lifecycle("quit"))}>
                    {t.quit}
                </button>
            </aside>
            <div className="desktop-content">
                <header className="desktop-header">
                    <div>
                        <span className="eyebrow">LOCAL WORKSPACE</span>
                        <h1>{t[tab]}</h1>
                    </div>
                    <div className="header-actions">
                        <span className="connection">{state?.user ? t.connected : t.offline}</span>
                        <select
                            aria-label="语言 / Language"
                            value={language}
                            onChange={(event) => setAppLanguage(event.target.value)}
                        >
                            <option value="zh">简体中文</option>
                            <option value="en">English</option>
                        </select>
                        <button type="button" onClick={() => void action(refresh)}>
                            {t.refresh}
                        </button>
                    </div>
                </header>
                <main>
                    {busy && (
                        <p role="status" className="notice">
                            {t.loading}
                        </p>
                    )}
                    {error && (
                        <div role="alert" className="error">
                            <strong>{t.error}</strong>
                            <p>{desktopErrorMessage(error, language)}</p>
                            <button type="button" onClick={() => setError("")}>
                                关闭 / Dismiss
                            </button>
                        </div>
                    )}
                    {notice && (
                        <p role="status" className="notice">
                            {notice}
                        </p>
                    )}
                    {!state && <p>{t.loading}</p>}
                    {state?.agentIssue && (
                        <p role="status" className="notice">
                            {desktopErrorMessage(state.agentIssue, language)}
                        </p>
                    )}
                    {agent?.pausedReason && (
                        <p role="status" className="notice">
                            {desktopErrorMessage(agent.pausedReason, language)}
                        </p>
                    )}
                    {agent?.scratchCleanupPending && (
                        <p role="status" className="notice">
                            {desktopErrorMessage("RUNTIME_SCRATCH_CLEANUP_PENDING", language)}
                        </p>
                    )}
                    {(tab === "overview" || tab === "settings") && (
                        <section className="panel">
                            <h2>控制平台 / Control platform</h2>
                            <p>
                                普通账户用于编辑和查看资源；设备绑定单独授权后台下载与回传。 / User accounts edit and
                                view resources; device enrollment separately authorizes Agent downloads and uploads.
                            </p>
                            <form
                                onSubmit={(event) => {
                                    event.preventDefault();
                                    void action(login);
                                }}
                                className="form-grid"
                            >
                                <label>
                                    <span className="field-required" aria-hidden="true">
                                        *
                                    </span>
                                    邮箱 / Email
                                    <input
                                        type="email"
                                        autoComplete="username"
                                        value={email}
                                        onChange={(event) => setEmail(event.target.value)}
                                        required
                                    />
                                </label>
                                <label>
                                    <span className="field-required" aria-hidden="true">
                                        *
                                    </span>
                                    密码 / Password
                                    <input
                                        type="password"
                                        autoComplete="current-password"
                                        value={password}
                                        onChange={(event) => setPassword(event.target.value)}
                                        required
                                    />
                                </label>
                                <button type="submit" disabled={busy}>
                                    {t.signIn}
                                </button>
                                {state?.user && (
                                    <button
                                        type="button"
                                        onClick={() =>
                                            void action(async () => {
                                                await bridge.logout();
                                                setWorkspace(undefined);
                                                setCloudRun(undefined);
                                                setWorkspaces([]);
                                                queries.clear();
                                            })
                                        }
                                    >
                                        {t.signOut}
                                    </button>
                                )}
                            </form>
                            <div className="toolbar">
                                <button
                                    type="button"
                                    onClick={() =>
                                        void action(async () => setWorkspaces((await bridge.workspaces()).items))
                                    }
                                >
                                    读取工作区 / Load workspaces
                                </button>
                                <label>
                                    {t.workspace}
                                    <select
                                        aria-label="平台工作区 / Platform workspace"
                                        value={workspace?.id ?? ""}
                                        onChange={(event) => void action(() => selectWorkspace(event.target.value))}
                                    >
                                        <option value="">选择工作区 / Choose workspace</option>
                                        {workspaces.map((item) => (
                                            <option key={item.id} value={item.id}>
                                                {item.name} · {item.role}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                            </div>
                            {workspace && (
                                <p className="muted">
                                    {workspace.name} · {workspace.role} · {state?.origin}
                                </p>
                            )}
                        </section>
                    )}
                    {tab === "overview" && installedRuntimeRequired && (
                        <section className="panel">
                            <h2>设备与独立后台 / Device &amp; Agent</h2>
                            <p>
                                {language === "zh"
                                    ? "设备注册和本机测试执行需要安装桌面 Runtime。"
                                    : "Device enrollment and local test execution require " +
                                      "an installed desktop Runtime."}
                            </p>
                        </section>
                    )}
                    {tab === "overview" && !installedRuntimeRequired && (
                        <>
                            <div className="summary-grid">
                                <section className="panel">
                                    <span className="eyebrow">LOCAL RUNS</span>
                                    <strong className="metric">{agent?.history.length ?? 0}</strong>
                                    <p>本机持久历史 / Durable history</p>
                                </section>
                            </div>
                            <section className="panel">
                                <h2>设备与独立后台 / Device & Agent</h2>
                                <p>
                                    {agent?.device
                                        ? `设备 / Device ${agent.device.id} · Workspace ${agent.device.workspaceId}`
                                        : agent?.credentialError
                                          ? "设备凭据暂不可读。 / Device credentials are not readable."
                                          : "尚未绑定设备。 / Device is not enrolled."}
                                </p>
                                {agent?.credentialError && (
                                    <p role="alert" data-testid="credential-status">
                                        {agent.credentialError} · {credentialGuidance[agent.credentialError]}
                                    </p>
                                )}
                                <div className="toolbar">
                                    <label>
                                        <span className="field-required" aria-hidden="true">
                                            *
                                        </span>
                                        设备名称 / Device name
                                        <input
                                            aria-required="true"
                                            value={deviceName}
                                            onChange={(event) => setDeviceName(event.target.value)}
                                        />
                                    </label>
                                    <button
                                        type="button"
                                        disabled={!!agent?.credentialError}
                                        onClick={() =>
                                            void action(async () =>
                                                setEnrollment(
                                                    (await bridge.local({
                                                        operation: "enroll",
                                                        name: deviceName,
                                                    })) as typeof enrollment,
                                                ),
                                            )
                                        }
                                    >
                                        发起绑定 / Enroll
                                    </button>
                                </div>
                                {enrollment && (
                                    <div className="notice">
                                        <strong data-testid="enrollment-code">{enrollment.userCode}</strong>
                                        <p>请核对设备名与当前工作区后批准。 / Verify this device and workspace.</p>
                                        <button
                                            type="button"
                                            disabled={!workspace}
                                            onClick={() =>
                                                void action(async () => {
                                                    if (!workspace) return;
                                                    await bridge.cloud({
                                                        operation: "approveEnrollment",
                                                        params: { enrollmentId: enrollment.id },
                                                        data: {
                                                            workspaceId: workspace.id,
                                                            private: !shared,
                                                            sharedWithUserIds: [],
                                                            userCode: enrollment.userCode,
                                                        },
                                                    });
                                                    await bridge.local({
                                                        operation: "pollEnrollment",
                                                    });
                                                    setEnrollment(undefined);
                                                })
                                            }
                                        >
                                            批准并完成绑定 / Approve binding
                                        </button>
                                    </div>
                                )}
                                <div className="toolbar">
                                    <label>
                                        <input
                                            type="checkbox"
                                            checked={shared}
                                            onChange={(event) => setShared(event.target.checked)}
                                        />
                                        共享给工作区 / Share with workspace
                                    </label>
                                    <button
                                        type="button"
                                        disabled={!workspace || !agent?.device}
                                        onClick={() =>
                                            void action(async () => {
                                                if (!workspace || !agent?.device) return;
                                                await bridge.cloud({
                                                    operation: "updateRuntimeGrants",
                                                    params: {
                                                        workspaceId: workspace.id,
                                                        runtimeId: agent.device.id,
                                                    },
                                                    data: {
                                                        workspaceId: workspace.id,
                                                        userIds: [],
                                                        sharedWithWorkspace: shared,
                                                    },
                                                });
                                                setDevice(
                                                    (await bridge.local({
                                                        operation: "device",
                                                    })) as S["RuntimeDTO"],
                                                );
                                            })
                                        }
                                    >
                                        更新共享授权 / Save sharing
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() =>
                                            void action(async () =>
                                                setDevice(
                                                    (await bridge.local({
                                                        operation: "device",
                                                    })) as S["RuntimeDTO"],
                                                ),
                                            )
                                        }
                                    >
                                        检查设备权限 / Inspect device
                                    </button>
                                </div>
                                {device && (
                                    <p>
                                        {device.name} · {device.status} · {device.trustStatus}
                                    </p>
                                )}
                                <div className="toolbar">
                                    <button
                                        type="button"
                                        onClick={() => void action(() => bridge.local({ operation: "onlineStart" }))}
                                    >
                                        启动在线领取 / Start online worker
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => void action(() => bridge.local({ operation: "onlineStop" }))}
                                    >
                                        停止在线领取 / Stop online worker
                                    </button>
                                    <button
                                        type="button"
                                        className="danger"
                                        onClick={() => void action(() => bridge.lifecycle("stop"))}
                                    >
                                        {t.stop}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => void action(() => bridge.local({ operation: "unbind" }))}
                                    >
                                        解绑设备 / Unbind
                                    </button>
                                </div>
                                <p className="muted">
                                    关闭窗口与退出界面不会中止后台。 / Closing or quitting the UI keeps Agent running.
                                    {state?.tray
                                        ? "托盘可重新打开窗口。 / Reopen the window from the tray."
                                        : "本桌面未确认托盘可用，关闭时最小化；再次启动可恢复窗口。 / Tray su" +
                                          "pport is unconfirmed. Closing minim" +
                                          "izes the window; reopening VeriQ restores it."}{" "}
                                    / UI close does not stop Agent.
                                </p>
                            </section>
                        </>
                    )}
                    {tab === "resources" &&
                        (workspace && adapters ? (
                            <ResourceWorkspaceView
                                key={workspace.id}
                                workspace={workspace}
                                adapter={adapters.resources}
                                signal={scope.signal}
                            />
                        ) : (
                            <p className="panel">
                                登录并选择工作区后浏览或编辑资源。 / Sign in and choose a workspace.
                            </p>
                        ))}
                    {tab === "reports" && (
                        <>
                            <section className="panel">
                                <div className="toolbar">
                                    <button
                                        type="button"
                                        aria-pressed={reportLocal}
                                        disabled={installedRuntimeRequired}
                                        title={
                                            installedRuntimeRequired
                                                ? desktopErrorMessage("INSTALLED_RUNTIME_REQUIRED", language)
                                                : undefined
                                        }
                                        onClick={() => setReportLocal(true)}
                                    >
                                        本机报告 / Local reports
                                    </button>
                                    <button
                                        type="button"
                                        aria-pressed={!reportLocal}
                                        disabled={!workspace}
                                        onClick={() => setReportLocal(false)}
                                    >
                                        云端报告 / Cloud reports
                                    </button>
                                </div>
                                {reportLocal && (
                                    <>
                                        <h2>历史记录 / Historical runs</h2>
                                        {!agent?.history.length && <p>{t.empty}</p>}
                                        <ul className="run-list">
                                            {agent?.history.map((item) => (
                                                <li key={item.id}>
                                                    <button type="button" onClick={() => setRun(item.id)}>
                                                        {item.id}
                                                    </button>
                                                    <span>
                                                        {desktopStateLabel(item.state)} ·{" "}
                                                        {desktopStateLabel(item.uploadState)}
                                                    </span>
                                                    {item.uploadError && (
                                                        <strong>
                                                            {desktopErrorMessage(item.uploadError, language)}
                                                        </strong>
                                                    )}
                                                    {item.state === "RUNNING" && (
                                                        <button
                                                            type="button"
                                                            onClick={() =>
                                                                void action(() =>
                                                                    bridge.local({
                                                                        operation: "cancel",
                                                                        runId: item.id,
                                                                    }),
                                                                )
                                                            }
                                                        >
                                                            {t.cancel}
                                                        </button>
                                                    )}
                                                </li>
                                            ))}
                                        </ul>
                                    </>
                                )}
                            </section>
                            {reportLocal && localReports && (
                                <ReportWorkspaceView
                                    key={localWorkspace + runId}
                                    adapter={localReports}
                                    initialRunId={runId}
                                    signal={scope.signal}
                                    rawEvidenceAllowed
                                    allowTableExport
                                />
                            )}
                            {!reportLocal && conversationOwner && adapters && (
                                <ReportWorkspaceView
                                    key={`${cloudScope}/${initialCloudRun}`}
                                    initialRunId={initialCloudRun}
                                    adapter={adapters.reports}
                                    signal={scope.signal}
                                    rawEvidenceAllowed={roles === "OWNER" || roles === "ADMIN"}
                                    allowTableExport={canExportWorkspaceTable(roles)}
                                />
                            )}
                        </>
                    )}
                    {tab === "recording" &&
                        (workspace && userId && state?.origin ? (
                            <RecordingWorkspace
                                key={cloudScope}
                                workspaceId={workspace.id}
                                owner={JSON.stringify([state.origin, userId, workspace.id])}
                                language={language}
                                resourceTools={
                                    adapters && (
                                        <RecordingResources
                                            workspace={workspace}
                                            adapters={adapters}
                                            language={language}
                                            signal={scope.signal}
                                        />
                                    )
                                }
                                openReport={(id) => {
                                    setCloudRun({ owner: cloudScope, id });
                                    setReportLocal(false);
                                    setTab("reports");
                                }}
                            />
                        ) : (
                            <p className="panel" role="status">
                                请连接平台、登录并选择工作区。 / Connect to VeriQ, sign in, and select a Workspace.
                            </p>
                        ))}
                    {tab === "conversation" &&
                        (workspace && userId && conversationOwner && adapters ? (
                            <section className="panel">
                                <h2>{t.conversation}</h2>
                                <DesktopAgentForms
                                    key={cloudScope}
                                    workspace={workspace}
                                    owner={conversationOwner}
                                    employeeId={userId}
                                    adapters={adapters}
                                    parentSignal={scope.signal}
                                    language={language}
                                    localWorkspaceId={agent?.workspaceId}
                                    retentionUnavailable={
                                        !!(
                                            installedRuntimeRequired ||
                                            busy ||
                                            agent?.active ||
                                            agent?.preparing ||
                                            agent?.online
                                        )
                                    }
                                    onRetentionComplete={async () => {
                                        setRun("");
                                        await queries.invalidateQueries({ queryKey: ["workspace", "reports"] });
                                        await refresh();
                                    }}
                                    navigate={(id) => (
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setCloudRun({ owner: cloudScope, id });
                                                setReportLocal(false);
                                                setTab("reports");
                                            }}
                                        >
                                            {language === "zh" ? "打开完整报告" : "Open full report"}
                                        </button>
                                    )}
                                />
                            </section>
                        ) : (
                            <p className="panel" role="status">
                                {language === "zh"
                                    ? "请连接平台、登录并选择工作区，再使用测试 Agent。"
                                    : "Connect to VeriQ, sign in, and select a Workspace to use Test Agent."}
                            </p>
                        ))}
                    {tab === "ai" &&
                        (workspace && adapters ? (
                            <AiWorkspaceView
                                workspace={workspace}
                                adapter={adapters.ai}
                                resources={adapters.resources}
                                signal={scope.signal}
                            />
                        ) : (
                            <p className="panel">AI 配置需要平台连接。 / AI requires a platform connection.</p>
                        ))}
                    {tab === "settings" && (
                        <>
                            <section className="panel">
                                <h2>连接与存储 / Connection & storage</h2>
                                <label>
                                    服务端 Origin / Server origin
                                    <input
                                        readOnly={installedRuntimeRequired}
                                        value={origin}
                                        onChange={(event) => setOrigin(event.target.value)}
                                    />
                                </label>
                                <label>
                                    HTTP(S) 代理 / Proxy
                                    <input
                                        disabled={installedRuntimeRequired}
                                        value={proxy}
                                        placeholder="http://proxy.example:8080"
                                        onChange={(event) => setProxy(event.target.value)}
                                    />
                                </label>
                                <button
                                    type="button"
                                    disabled={installedRuntimeRequired}
                                    onClick={() => void action(() => bridge.configure(origin, proxy))}
                                >
                                    {t.save}
                                </button>
                                <p>
                                    证书使用系统信任库；不接受无效 TLS 证书。 / Certificates use the system trust store;
                                    invalid TLS is rejected.
                                </p>
                                <p>
                                    联网执行默认容量为全局 4、每个工作区 2。 / Connected capacity defaults to 4 globally
                                    and 2 per workspace.
                                </p>
                                <button type="button" onClick={() => void action(() => bridge.directory())}>
                                    打开资源目录 / Open resource directory
                                </button>
                            </section>
                            {!installedRuntimeRequired && (
                                <>
                                    <section className="panel">
                                        <h2>签发者信任 / Issuer trust</h2>
                                        <p>
                                            HTTPS 绑定从认证控制平台刷新；本机开发 HTTP 必须核对管理员提供的公钥指纹。 /
                                            Verify an administrator-provided fingerprint for local HTTP development.
                                        </p>
                                        <label>
                                            公钥 JSON / Public issuer JSON
                                            <textarea
                                                value={issuer}
                                                onChange={(event) => setIssuer(event.target.value)}
                                            />
                                        </label>
                                        <label>
                                            已核对的 SHA256 指纹 / Verified fingerprint
                                            <input
                                                value={fingerprint}
                                                onChange={(event) => setFingerprint(event.target.value)}
                                            />
                                        </label>
                                        <button
                                            type="button"
                                            onClick={() =>
                                                void action(() =>
                                                    bridge.local({
                                                        operation: "trust",
                                                        issuer: JSON.parse(issuer),
                                                        fingerprint,
                                                    }),
                                                )
                                            }
                                        >
                                            建立信任 / Trust issuer
                                        </button>
                                    </section>
                                    <section className="panel">
                                        <h2>自检与恢复 / Diagnostics & recovery</h2>
                                        <div className="toolbar">
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    void action(async () =>
                                                        setDiagnostics(await bridge.local({ operation: "doctor" })),
                                                    )
                                                }
                                            >
                                                运行自检 / Run diagnostics
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    void action(async () =>
                                                        setDiagnostics(await bridge.local({ operation: "recover" })),
                                                    )
                                                }
                                            >
                                                恢复中断执行 / Recover interrupted run
                                            </button>
                                        </div>
                                        <p>
                                            {"停止本机执行和在线领取后，可显式迁移旧凭据。" +
                                                "迁移会核验系统保险库和加密数据，再移除旧明文文件。"}{" "}
                                            / Stop execution and online polling before explicitly migrating legacy
                                            credentials. Migration verifies the system vault and encrypted data before
                                            removing legacy plaintext.
                                        </p>
                                        <button
                                            type="button"
                                            onClick={() =>
                                                void action(async () =>
                                                    setDiagnostics(
                                                        await bridge.local({
                                                            operation: "migrateCredentials",
                                                        }),
                                                    ),
                                                )
                                            }
                                        >
                                            迁移本机凭据 / Migrate local credentials
                                        </button>
                                        <p>
                                            {"初始化中断且尚无凭据时，可明确恢复空保险库。" +
                                                "已激活档案缺钥不会被替换；请先停止执行与在线领取。"}{" "}
                                            / An interrupted empty initialization can be explicitly recovered. Missing
                                            keys in active profiles are not replaced. Stop execution and online polling
                                            first.
                                        </p>
                                        <button
                                            type="button"
                                            onClick={() =>
                                                void action(async () =>
                                                    setDiagnostics(
                                                        await bridge.local({
                                                            operation: "recoverCredentialInitialization",
                                                        }),
                                                    ),
                                                )
                                            }
                                        >
                                            恢复空保险库初始化 / Recover empty vault initialization
                                        </button>
                                        {diagnostics !== undefined && (
                                            <pre data-testid="diagnostics">{JSON.stringify(diagnostics, null, 2)}</pre>
                                        )}
                                        <RetentionPanel
                                            workspaceId={agent?.workspaceId}
                                            unavailable={
                                                !!(
                                                    installedRuntimeRequired ||
                                                    busy ||
                                                    agent?.active ||
                                                    agent?.preparing ||
                                                    agent?.online
                                                )
                                            }
                                            onCompleted={async () => {
                                                setRun("");
                                                queries.clear();
                                                await refresh();
                                            }}
                                        />
                                        <button type="button" onClick={() => void action(() => bridge.installUpdate())}>
                                            准备已验证升级或回滚 / Prepare verified update
                                        </button>
                                        <p>
                                            {"更新前请停止在线领取与执行；隔离或未知进程必须先恢复。" +
                                                "卸载默认保留本机配置、凭据与历史。"}{" "}
                                            / Stop online polling and execution before updates; recover unknown or
                                            quarantined processes first. Uninstall keeps local settings, credentials and
                                            history.
                                        </p>
                                        {state?.diagnostics && <pre>{JSON.stringify(state.diagnostics, null, 2)}</pre>}
                                        <p>
                                            VeriQ {state?.version} · Node24 Agent {agent?.node ?? "unavailable"} ·{" "}
                                            {agent?.browser.version ?? "Browser unavailable"} · {agent?.browser.source}
                                        </p>
                                    </section>
                                </>
                            )}
                            {installedRuntimeRequired && state?.diagnostics && (
                                <section className="panel">
                                    <h2>版本与诊断 / Versions and diagnostics</h2>
                                    <pre>{JSON.stringify(state.diagnostics, null, 2)}</pre>
                                </section>
                            )}
                        </>
                    )}
                </main>
            </div>
        </div>
    );
}
