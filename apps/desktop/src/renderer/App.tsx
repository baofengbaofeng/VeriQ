import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
    ResourceWorkspaceView,
    ReportWorkspaceView,
    BundleWorkspaceView,
    AiWorkspaceView,
    editorI18n,
    aiI18n,
    type ResourceAdapter,
    type Workspace,
} from "@veriq/web/desktop";
import type { PlatformComponents } from "@veriq/contracts";
import type { DesktopState } from "../shared/bridge";
import { cloudAdapters, localResources, DesktopLocalReports } from "./adapters";

type S = PlatformComponents["schemas"];
type Tab = "overview" | "resources" | "bundles" | "local" | "reports" | "ai" | "settings";
const bridge = window.veriq;
const labels = {
    zh: {
        overview: "工作台",
        resources: "云端资源",
        bundles: "下载与导出",
        local: "本机缓存",
        reports: "报告与历史",
        ai: "AI 辅助",
        settings: "设置与诊断",
        loading: "正在读取…",
        signIn: "登录",
        signOut: "退出登录",
        refresh: "刷新",
        workspace: "工作区",
        execute: "独立执行",
        cancel: "取消执行",
        upload: "回传结果",
        empty: "尚无本机执行记录",
        error: "操作未完成",
        connected: "已登录",
        offline: "离线 / 未登录",
        cache: "已验签的本机资源",
        select: "选择",
        save: "保存",
        stop: "停止后台",
        quit: "退出界面",
        tray: "收起窗口",
    },
    en: {
        overview: "Overview",
        resources: "Cloud resources",
        bundles: "Downloads & exports",
        local: "Local cache",
        reports: "Reports & history",
        ai: "AI assistance",
        settings: "Settings & diagnostics",
        loading: "Loading…",
        signIn: "Sign in",
        signOut: "Sign out",
        refresh: "Refresh",
        workspace: "Workspace",
        execute: "Run independently",
        cancel: "Cancel run",
        upload: "Upload result",
        empty: "No local runs yet",
        error: "Operation failed",
        connected: "Signed in",
        offline: "Offline / signed out",
        cache: "Verified local resources",
        select: "Select",
        save: "Save",
        stop: "Stop Agent",
        quit: "Quit UI",
        tray: "Minimize window",
    },
};

/** 桌面工作台把平台会话与本机后台明确区分，联网编辑复用共享视图，断网缓存继续使用验签后的只读适配器；状态轮询仅读取后台事实，窗口关闭和页面切换都不会改变执行归属。 */
export function App() {
    const [language, setLanguage] = useState<"zh" | "en">("zh"),
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
    const [localWorkspace, setLocalWorkspace] = useState(""),
        [bundleId, setBundle] = useState("");
    const [resources, setResources] = useState<ResourceAdapter>();
    const [runId, setRun] = useState(""),
        [reportLocal, setReportLocal] = useState(true);
    const [headed, setHeaded] = useState(false),
        [retry, setRetry] = useState(false),
        [debug, setDebug] = useState(false);
    const [deviceName, setDeviceName] = useState("VeriQ Desktop");
    const [enrollment, setEnrollment] = useState<Omit<S["EnrollmentDTO"], "deviceCode">>();
    const [shared, setShared] = useState(false),
        [device, setDevice] = useState<S["RuntimeDTO"]>();
    const [issuer, setIssuer] = useState(""),
        [fingerprint, setFingerprint] = useState("");
    const [diagnostics, setDiagnostics] = useState<unknown>();
    const [credential, setCredential] = useState("");
    const [routing, setRouting] = useState({ baseURL: "", apiBaseURL: "", fixtureBaseURL: "" });
    const [pins, setPins] = useState<{
        issuerId: string;
        workspaceId: string;
        references: { secretRef: string; versionId: string }[];
    }>();
    const [pinIndex, setPinIndex] = useState(0);
    const queries = useQueryClient();
    const workspaceId = workspace?.id;
    const adapters = useMemo(
        () => (workspaceId ? cloudAdapters(workspaceId, debug) : undefined),
        [workspaceId, debug],
    );
    const localReports = useMemo(
        () => (localWorkspace ? new DesktopLocalReports(localWorkspace) : undefined),
        [localWorkspace],
    );
    // biome-ignore lint/correctness/useExhaustiveDependencies: 此控制器身份有意随三项授权视图作用域改变，虽然构造函数不读取这些值，删掉依赖会让旧报告订阅越过工作区或本机云端切换继续存活。
    const scope = useMemo(
        () => new AbortController(),
        [workspace?.id, localWorkspace, reportLocal],
    );
    const agent = state?.agent;

    const refresh = useCallback(async () => {
        const value = await bridge.state();
        setState(value);
        setOrigin((current) => current || value.origin);
        setWorkspace(value.workspace);
        if (value.agent?.workspaceId) setLocalWorkspace(value.agent.workspaceId);
    }, []);
    /** 统一动作包装器只管理本次交互的忙碌、错误和刷新状态，不将捕获异常改写成成功结果；后台执行有独立的 preparing 和 active 状态，因此 UI 请求结束并不代表业务 Run 已经终结。 */
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
        const timer = setInterval(
            () => void refresh().catch((error) => setError(String(error))),
            1500,
        );
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
    useEffect(() => {
        void editorI18n.changeLanguage(language);
        void aiI18n.changeLanguage(language);
        document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
    }, [language]);

    /** 从后台列出的缓存包选择其所属工作区，再获取验签资源投影与固定凭证引用供离线查看；此处不根据用户输入路径读取文件，失败会交由动作包装器显示而不会构造空成功快照。 */
    async function chooseLocal(id: string) {
        const selected = agent?.bundles.find((bundle) => bundle.id === id);
        if (!selected) throw new Error("BUNDLE_NOT_FOUND");
        await bridge.local({ operation: "select", workspaceId: selected.workspaceId });
        setLocalWorkspace(selected.workspaceId);
        setBundle(id);
        setResources(await localResources(id));
        setPins((await bridge.local({ operation: "credentials", bundleId: id })) as typeof pins);
        setPinIndex(0);
        setTab("local");
    }
    /** 普通登录只经过专用宿主 Session，成功后清空输入框中的密码并加载真实成员工作区；设备登记状态由另一组后台字段显示，登录成功不能被用来代替设备令牌的注册流程。 */
    async function login() {
        await bridge.login({ email, password });
        setPassword("");
        setWorkspaces((await bridge.workspaces()).items);
        setNotice(t.connected);
    }
    /** 云端工作区切换等待宿主完成成员检查后才更新页面，并清空共享查询缓存和旧资源报告选择；已有本机 Run 的持久状态由独立 Agent 保留，清除页面选择不会取消执行。 */
    async function selectWorkspace(id: string) {
        const selected = await bridge.select(id);
        setWorkspace(selected);
        queries.clear();
        setResources(undefined);
        setRun("");
    }
    const localView: Workspace | undefined = localWorkspace
        ? {
              id: localWorkspace,
              key: "local",
              name: "本机只读快照 / Local snapshot",
              role: "VIEWER",
              archived: false,
          }
        : undefined;
    const roles = workspace?.role;
    const canExecute = roles !== "VIEWER";

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
                    {(Object.keys(labels.zh).slice(0, 7) as Tab[]).map((key) => (
                        <button
                            type="button"
                            key={key}
                            aria-current={tab === key ? "page" : undefined}
                            onClick={() => setTab(key)}
                        >
                            {t[key]}
                        </button>
                    ))}
                </nav>
                <div className="sidebar-status">
                    <span className={agent ? "status-dot ready" : "status-dot"} />
                    {agent ? `Agent · Node ${agent.node}` : "Agent unavailable"}
                    <small>
                        {agent?.active
                            ? "执行中 / Running"
                            : agent?.online
                              ? "在线领取 / Online worker"
                              : "就绪 / Idle"}
                    </small>
                </div>
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
                            onChange={(event) => setLanguage(event.target.value as "zh" | "en")}
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
                            <p>{error}</p>
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
                    {(tab === "overview" || tab === "settings") && (
                        <section className="panel">
                            <h2>控制平台 / Control platform</h2>
                            <p>普通账户用于编辑和查看资源；设备绑定单独授权后台下载与回传。</p>
                            <form
                                onSubmit={(event) => {
                                    event.preventDefault();
                                    void action(login);
                                }}
                                className="form-grid"
                            >
                                <label>
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
                                        void action(async () =>
                                            setWorkspaces((await bridge.workspaces()).items),
                                        )
                                    }
                                >
                                    读取工作区 / Load workspaces
                                </button>
                                <label>
                                    {t.workspace}
                                    <select
                                        aria-label="平台工作区 / Platform workspace"
                                        value={workspace?.id ?? ""}
                                        onChange={(event) =>
                                            void action(() => selectWorkspace(event.target.value))
                                        }
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
                    {tab === "overview" && (
                        <>
                            <div className="summary-grid">
                                <section className="panel">
                                    <span className="eyebrow">SIGNED CACHE</span>
                                    <strong className="metric">{agent?.bundles.length ?? 0}</strong>
                                    <p>已下载资源包 / Downloaded packages</p>
                                </section>
                                <section className="panel">
                                    <span className="eyebrow">LOCAL RUNS</span>
                                    <strong className="metric">{agent?.history.length ?? 0}</strong>
                                    <p>本机持久历史 / Durable history</p>
                                </section>
                                <section className="panel">
                                    <span className="eyebrow">PENDING UPLOAD</span>
                                    <strong className="metric">
                                        {agent?.history.filter(
                                            (item) => item.uploadState !== "COMPLETE",
                                        ).length ?? 0}
                                    </strong>
                                    <p>重连后可手动回传 / Ready to synchronize</p>
                                </section>
                            </div>
                            <section className="panel">
                                <h2>设备与独立后台 / Device & Agent</h2>
                                <p>
                                    {agent?.device
                                        ? `设备 ${agent.device.id} · Workspace ${agent.device.workspaceId}`
                                        : "尚未绑定设备。 / Device is not enrolled."}
                                </p>
                                <div className="toolbar">
                                    <label>
                                        设备名称 / Device name
                                        <input
                                            value={deviceName}
                                            onChange={(event) => setDeviceName(event.target.value)}
                                        />
                                    </label>
                                    <button
                                        type="button"
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
                                        <strong data-testid="enrollment-code">
                                            {enrollment.userCode}
                                        </strong>
                                        <p>
                                            请核对设备名与当前工作区后批准。 / Verify this device
                                            and workspace.
                                        </p>
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
                                        onClick={() =>
                                            void action(() =>
                                                bridge.local({ operation: "onlineStart" }),
                                            )
                                        }
                                    >
                                        启动在线领取 / Start online worker
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() =>
                                            void action(() =>
                                                bridge.local({ operation: "onlineStop" }),
                                            )
                                        }
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
                                        onClick={() =>
                                            void action(() => bridge.local({ operation: "unbind" }))
                                        }
                                    >
                                        解绑设备 / Unbind
                                    </button>
                                </div>
                                <p className="muted">
                                    关闭窗口与退出界面不会中止后台。
                                    {state?.tray
                                        ? "托盘可重新打开窗口。"
                                        : "本桌面未确认托盘可用，关闭时最小化；再次启动可恢复窗口。"}{" "}
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
                    {tab === "bundles" && (
                        <>
                            <label className="panel inline">
                                <input
                                    type="checkbox"
                                    checked={debug}
                                    onChange={(event) => setDebug(event.target.checked)}
                                />
                                允许明确标记的未验证 DEBUG 包 / Allow explicitly unvalidated DEBUG
                                package
                            </label>
                            {workspace && adapters ? (
                                <BundleWorkspaceView
                                    workspaceId={workspace.id}
                                    adapter={adapters.bundles}
                                    signal={scope.signal}
                                    canDownload={canExecute}
                                    canEdit={["OWNER", "ADMIN", "EDITOR"].includes(workspace.role)}
                                />
                            ) : (
                                <p className="panel">
                                    请先登录并选择工作区。 / Choose an authenticated workspace.
                                </p>
                            )}
                        </>
                    )}
                    {tab === "local" && (
                        <>
                            <section className="panel">
                                <h2>{t.cache}</h2>
                                <p>
                                    断网时仍可读取与运行。离线权限撤销状态未知，结果不等同正式门禁通过。
                                    / Cached snapshots stay usable offline; revocation is unknown.
                                </p>
                                <div className="toolbar">
                                    <label>
                                        资源包 / Package
                                        <select
                                            aria-label="本机资源包 / Local package"
                                            value={bundleId}
                                            onChange={(event) =>
                                                void action(() => chooseLocal(event.target.value))
                                            }
                                        >
                                            <option value="">
                                                选择已下载包 / Select a package
                                            </option>
                                            {agent?.bundles.map((item) => (
                                                <option key={item.id} value={item.id}>
                                                    {item.id} · {item.engineVersion}
                                                    {item.debug ? " · DEBUG" : ""}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                    <button
                                        type="button"
                                        disabled={!bundleId}
                                        onClick={() => void action(() => chooseLocal(bundleId))}
                                    >
                                        {t.refresh}
                                    </button>
                                    <button
                                        type="button"
                                        disabled={!bundleId}
                                        onClick={() =>
                                            void action(async () => {
                                                await bridge.local({
                                                    operation: "clearBundle",
                                                    bundleId,
                                                });
                                                setBundle("");
                                                setResources(undefined);
                                                setPins(undefined);
                                            })
                                        }
                                    >
                                        清理所选缓存 / Remove cache
                                    </button>
                                </div>
                                {!agent?.bundles.length && (
                                    <p>尚未下载资源包。 / No downloaded packages yet.</p>
                                )}
                                <div className="toolbar">
                                    <label>
                                        <input
                                            type="checkbox"
                                            disabled={!agent?.headedAvailable}
                                            checked={headed}
                                            onChange={(event) => setHeaded(event.target.checked)}
                                        />
                                        可见浏览器 / Visible browser
                                    </label>
                                    <label>
                                        <input
                                            type="checkbox"
                                            checked={retry}
                                            onChange={(event) => setRetry(event.target.checked)}
                                        />
                                        允许一次整用例重试 / One whole-case retry
                                    </label>
                                    <button
                                        type="button"
                                        disabled={
                                            !bundleId ||
                                            !!agent?.active ||
                                            !!agent?.preparing ||
                                            agent?.online
                                        }
                                        onClick={() =>
                                            void action(() =>
                                                bridge.local({
                                                    operation: "run",
                                                    bundleId,
                                                    headed,
                                                    retry,
                                                    overrides: Object.fromEntries(
                                                        Object.entries(routing)
                                                            .filter(([, value]) => value.trim())
                                                            .map(([key, value]) => [
                                                                key,
                                                                value.trim(),
                                                            ]),
                                                    ),
                                                }),
                                            )
                                        }
                                    >
                                        {t.execute}
                                    </button>
                                </div>
                                <details>
                                    <summary>本次本机环境 / Local environment for this run</summary>
                                    <p>
                                        留空使用签名包环境；覆盖需要原生确认，报告标记
                                        dirty，不同步回平台资源。 / Overrides require confirmation
                                        and do not edit the signed resource.
                                    </p>
                                    {(["baseURL", "apiBaseURL", "fixtureBaseURL"] as const).map(
                                        (key) => (
                                            <label key={key}>
                                                {key}
                                                <input
                                                    aria-label={`Local ${key}`}
                                                    value={routing[key]}
                                                    onChange={(event) =>
                                                        setRouting((current) => ({
                                                            ...current,
                                                            [key]: event.target.value,
                                                        }))
                                                    }
                                                />
                                            </label>
                                        ),
                                    )}
                                </details>
                                {!agent?.headedAvailable && (
                                    <p className="muted">
                                        当前安装仅提供已匹配的无头浏览器；完整可见浏览器尚未配置。 /
                                        The installed browser supports headless execution only.
                                    </p>
                                )}
                                {agent?.preparing && (
                                    <p role="status">
                                        {agent.preparing.cancelling
                                            ? "正在取消启动 / Cancelling startup"
                                            : "正在准备执行 / Preparing execution"}
                                        <button
                                            type="button"
                                            disabled={agent.preparing.cancelling}
                                            onClick={() =>
                                                void action(() =>
                                                    bridge.local({
                                                        operation: "cancel",
                                                        startupId: agent.preparing!.id,
                                                    }),
                                                )
                                            }
                                        >
                                            取消启动 / Cancel startup
                                        </button>
                                    </p>
                                )}
                                {agent?.active && (
                                    <p role="status">
                                        {agent.active.runId} · {agent.active.state}{" "}
                                        <button
                                            type="button"
                                            onClick={() =>
                                                void action(() =>
                                                    bridge.local({
                                                        operation: "cancel",
                                                        runId: agent.active!.runId,
                                                    }),
                                                )
                                            }
                                        >
                                            {t.cancel}
                                        </button>
                                    </p>
                                )}
                                {agent?.error && <p role="alert">{agent.error}</p>}
                            </section>
                            {pins && (
                                <section className="panel">
                                    <h2>本机凭证映射 / Local credential mapping</h2>
                                    <p>
                                        仅写入所选签名包钉选的引用；已存值不可读取。 / Write-only
                                        pinned references.
                                    </p>
                                    <label>
                                        引用 / Reference
                                        <select
                                            value={pinIndex}
                                            onChange={(event) =>
                                                setPinIndex(Number(event.target.value))
                                            }
                                        >
                                            {pins.references.map((pin, index) => (
                                                <option
                                                    key={pin.secretRef + pin.versionId}
                                                    value={index}
                                                >
                                                    {pin.secretRef} · {pin.versionId}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                    <label>
                                        JSON 凭证 / JSON credential
                                        <textarea
                                            value={credential}
                                            onChange={(event) => setCredential(event.target.value)}
                                            spellCheck={false}
                                            autoComplete="off"
                                        />
                                    </label>
                                    <button
                                        type="button"
                                        disabled={!pins.references[pinIndex]}
                                        onClick={() =>
                                            void action(async () => {
                                                const pin = pins.references[pinIndex]!;
                                                await bridge.local({
                                                    operation: "setCredential",
                                                    bundleId,
                                                    reference: {
                                                        issuerId: pins.issuerId,
                                                        workspaceId: pins.workspaceId,
                                                        ...pin,
                                                    },
                                                    value: JSON.parse(credential),
                                                });
                                                setCredential("");
                                                setNotice("凭证已保存 / Credential saved");
                                            })
                                        }
                                    >
                                        {t.save}
                                    </button>
                                    <button
                                        type="button"
                                        disabled={!pins.references[pinIndex]}
                                        onClick={() =>
                                            void action(async () => {
                                                const pin = pins.references[pinIndex]!;
                                                await bridge.local({
                                                    operation: "removeCredential",
                                                    bundleId,
                                                    reference: {
                                                        issuerId: pins.issuerId,
                                                        workspaceId: pins.workspaceId,
                                                        ...pin,
                                                    },
                                                });
                                                setNotice(
                                                    "本机凭证已移除 / Local credential removed",
                                                );
                                            })
                                        }
                                    >
                                        移除映射 / Remove mapping
                                    </button>
                                </section>
                            )}
                            {resources && localView && (
                                <ResourceWorkspaceView
                                    key={bundleId}
                                    workspace={localView}
                                    adapter={resources}
                                    signal={scope.signal}
                                />
                            )}
                        </>
                    )}
                    {tab === "reports" && (
                        <>
                            <section className="panel">
                                <div className="toolbar">
                                    <button
                                        type="button"
                                        aria-pressed={reportLocal}
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
                                        <h2>执行与回传 / Runs & uploads</h2>
                                        {!agent?.history.length && <p>{t.empty}</p>}
                                        <ul className="run-list">
                                            {agent?.history.map((item) => (
                                                <li key={item.id}>
                                                    <button
                                                        type="button"
                                                        onClick={() => setRun(item.id)}
                                                    >
                                                        {item.id}
                                                    </button>
                                                    <span>
                                                        {item.state} · {item.uploadState}
                                                    </span>
                                                    {item.uploadError && (
                                                        <strong>{item.uploadError}</strong>
                                                    )}
                                                    <button
                                                        type="button"
                                                        onClick={() =>
                                                            void action(() =>
                                                                bridge.local({
                                                                    operation: "upload",
                                                                    runId: item.id,
                                                                }),
                                                            )
                                                        }
                                                    >
                                                        {t.upload}
                                                    </button>
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
                                />
                            )}
                            {!reportLocal && adapters && (
                                <ReportWorkspaceView
                                    adapter={adapters.reports}
                                    signal={scope.signal}
                                    rawEvidenceAllowed={roles === "OWNER" || roles === "ADMIN"}
                                />
                            )}
                        </>
                    )}
                    {tab === "ai" &&
                        (workspace && adapters ? (
                            <AiWorkspaceView
                                workspace={workspace}
                                adapter={adapters.ai}
                                resources={adapters.resources}
                                signal={scope.signal}
                            />
                        ) : (
                            <p className="panel">
                                AI 配置需要平台连接；离线确定性执行不调用模型。 / AI requires a
                                platform connection; offline execution never calls a model.
                            </p>
                        ))}
                    {tab === "settings" && (
                        <>
                            <section className="panel">
                                <h2>连接与存储 / Connection & storage</h2>
                                <label>
                                    服务端 Origin / Server origin
                                    <input
                                        value={origin}
                                        onChange={(event) => setOrigin(event.target.value)}
                                    />
                                </label>
                                <label>
                                    HTTP(S) 代理 / Proxy
                                    <input
                                        value={proxy}
                                        placeholder="http://proxy.example:8080"
                                        onChange={(event) => setProxy(event.target.value)}
                                    />
                                </label>
                                <button
                                    type="button"
                                    onClick={() =>
                                        void action(() => bridge.configure(origin, proxy))
                                    }
                                >
                                    {t.save}
                                </button>
                                <p>
                                    证书使用系统信任库；不接受无效 TLS 证书。 / Certificates use the
                                    system trust store; invalid TLS is rejected.
                                </p>
                                <p>
                                    本机执行容量：1；在线默认全局4 / Workspace2，由平台授权限制。 /
                                    Local capacity: 1.
                                </p>
                                <button
                                    type="button"
                                    onClick={() => void action(() => bridge.directory())}
                                >
                                    打开资源目录 / Open resource directory
                                </button>
                            </section>
                            <section className="panel">
                                <h2>签发者信任 / Issuer trust</h2>
                                <p>
                                    HTTPS 绑定从认证控制平台刷新；本机开发 HTTP
                                    必须核对管理员提供的公钥指纹。 / Verify an
                                    administrator-provided fingerprint for local HTTP development.
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
                                                setDiagnostics(
                                                    await bridge.local({ operation: "doctor" }),
                                                ),
                                            )
                                        }
                                    >
                                        运行自检 / Run diagnostics
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() =>
                                            void action(async () =>
                                                setDiagnostics(
                                                    await bridge.local({ operation: "recover" }),
                                                ),
                                            )
                                        }
                                    >
                                        恢复中断执行 / Recover interrupted run
                                    </button>
                                </div>
                                <p>
                                    停止本机执行和在线领取后，可显式迁移旧凭据。迁移会核验系统保险库和加密数据，再移除旧明文文件。
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
                                {diagnostics !== undefined && (
                                    <pre data-testid="diagnostics">
                                        {JSON.stringify(diagnostics, null, 2)}
                                    </pre>
                                )}
                                <p>
                                    VeriQ {state?.version} · Node24 Agent{" "}
                                    {agent?.node ?? "unavailable"} ·{" "}
                                    {agent?.browser.version ?? "Browser unavailable"} ·{" "}
                                    {agent?.browser.source}
                                </p>
                            </section>
                        </>
                    )}
                </main>
            </div>
        </div>
    );
}
