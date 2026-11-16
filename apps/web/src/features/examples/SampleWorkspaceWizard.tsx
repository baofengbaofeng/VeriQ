import { useContext, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ApiError, request } from "../../api";
import { Auth } from "../../auth-context";
import {
    allItems,
    importFingerprint,
    importSample,
    loadSamplePackage,
    SampleImportError,
    targetOrigin,
} from "./importer";
import { exampleTranslationOptions } from "./i18n";
import { readProgress, writeProgress } from "./progress";
import type {
    ImportEvent,
    ImportOptions,
    ImportProgress,
    ImportSecrets,
    SamplePackage,
    Schemas,
} from "./types";

/** 宿主传入当前员工已选择的Workspace，成功后仅收到真实空间和计划标识；新空间可先单独创建供用户授权Runtime，组件不替宿主修改全局选择或隐式授予任何设备信任和凭据权限。
 */
export interface SampleWorkspaceWizardProps {
    workspaceId?: string;
    onWorkspaceCreated?: (id: string) => void;
    onComplete?: (result: { workspaceId: string; planId: string }) => void;
    onClose?: () => void;
}

type PublicForm = Omit<ImportOptions, "workspaceId">;
type TextField = Exclude<keyof PublicForm, "validationTimeout">;
const initialForm: PublicForm = {
    baseURL: "http://127.0.0.1:8090",
    apiBaseURL: "http://127.0.0.1:8090",
    fixtureBaseURL: "http://127.0.0.1:8090",
    buildSha: "development",
    locale: "en-US",
    timezone: "UTC",
    roleKey: "editor",
    businessIdentity: "editor",
    fixtureIdentity: "fixture-service",
    businessRef: "demo_business",
    fixtureRef: "demo_fixture",
    runtimeId: "",
    validationTimeout: 300,
};
const noSecrets: ImportSecrets = {
    businessToken: "",
    fixtureToken: "",
    businessVersion: "",
    fixtureVersion: "",
    adapterVersion: "",
};

/** 真实示例向导从已安装包API读取DSL，通过当前员工Cookie/CSRF传输依次创建草稿、等待编译、读取回执并发布，所有取消和失败保留已接受的远端事实，绝不在前端合成成功作业或静态报告。
 * token只存在短命表单和当前请求闭包，不进入Query缓存或恢复文件。
 * 账号或Workspace变化时终止旧请求并清空秘密，旧响应不能写入新空间。
 * 局部取消不等于远端Job取消，UI明确提示可按相同参数恢复。
 */
function SampleWorkspaceWizardSession({
    workspaceId,
    onWorkspaceCreated,
    onComplete,
    onClose,
}: SampleWorkspaceWizardProps) {
    const { user } = useContext(Auth);
    const { t } = useTranslation("examples", exampleTranslationOptions);
    const [sample, setSample] = useState<SamplePackage | null>(null);
    const [currentWorkspace, setCurrentWorkspace] = useState(workspaceId ?? "");
    const [workspaceKey, setWorkspaceKey] = useState("veriq-demo");
    const [workspaceName, setWorkspaceName] = useState("VeriQ employee example");
    const [form, setForm] = useState<PublicForm>(initialForm);
    const [secrets, setSecrets] = useState<ImportSecrets>(noSecrets);
    const [credentials, setCredentials] = useState<Schemas["CredentialDTO"][]>([]);
    const [adapters, setAdapters] = useState<Schemas["AuthAdapterDTO"][]>([]);
    const [runtimes, setRuntimes] = useState<Schemas["RuntimeDTO"][]>([]);
    const [events, setEvents] = useState<ImportEvent[]>([]);
    const [error, setError] = useState<{ key: string; code?: string; requestId?: string } | null>(
        null,
    );
    const [running, setRunning] = useState(false);
    const [stopped, setStopped] = useState(false);
    const [complete, setComplete] = useState(false);
    const [completedPlan, setCompletedPlan] = useState("");
    const [storageWarning, setStorageWarning] = useState(false);
    const [reload, setReload] = useState(0);
    const active = useRef<AbortController | null>(null);
    const memory = useRef<ImportProgress | null>(null);
    const storageKey =
        user && currentWorkspace ? `veriq:sample-import:${user.id}:${currentWorkspace}` : "";

    const reportError = (failure: unknown) => {
        if (failure instanceof SampleImportError) setError({ key: failure.message });
        else if (failure instanceof ApiError)
            setError({ key: "UNKNOWN", code: failure.code, requestId: failure.requestId });
        else setError({ key: "UNKNOWN" });
    };
    useEffect(() => {
        active.current?.abort();
        setCurrentWorkspace(workspaceId ?? "");
        setSecrets({ ...noSecrets });
        setEvents([]);
        setRunning(false);
        setComplete(false);
        memory.current = null;
        return () => {
            active.current?.abort();
        };
    }, [workspaceId, user?.id]);
    useEffect(() => {
        if (!user) return;
        const controller = new AbortController();
        void loadSamplePackage(controller.signal)
            .then((value) => {
                if (!controller.signal.aborted) setSample(value);
            })
            .catch((failure: unknown) => {
                if (!controller.signal.aborted) reportError(failure);
            });
        return () => controller.abort();
    }, [user?.id, reload]);
    useEffect(() => {
        if (!user || !currentWorkspace) return;
        const controller = new AbortController();
        const base = `/workspaces/${currentWorkspace}`;
        setCredentials([]);
        setAdapters([]);
        setRuntimes([]);
        void Promise.all([
            allItems<Schemas["CredentialDTO"]>(base + "/credentials", controller.signal),
            allItems<Schemas["AuthAdapterDTO"]>(base + "/auth-adapters", controller.signal),
            allItems<Schemas["RuntimeDTO"]>(base + "/runtimes", controller.signal),
        ])
            .then(([nextCredentials, nextAdapters, nextRuntimes]) => {
                if (controller.signal.aborted) return;
                setCredentials(nextCredentials);
                setAdapters(nextAdapters);
                setRuntimes(nextRuntimes);
            })
            .catch((failure: unknown) => {
                if (!controller.signal.aborted) reportError(failure);
            });
        return () => controller.abort();
    }, [currentWorkspace, user?.id, reload]);

    async function createWorkspace() {
        if (running) return;
        const controller = new AbortController();
        active.current = controller;
        setRunning(true);
        setError(null);
        try {
            const existing = (
                await allItems<Schemas["WorkspaceDTO"]>("/workspaces", controller.signal)
            ).find((item) => item.key === workspaceKey);
            const workspace =
                existing ??
                (await request<Schemas["WorkspaceDTO"]>(
                    "/workspaces",
                    "POST",
                    { key: workspaceKey, name: workspaceName },
                    controller.signal,
                ));
            controller.signal.throwIfAborted();
            setCurrentWorkspace(workspace.id);
            onWorkspaceCreated?.(workspace.id);
        } catch (failure) {
            if (!controller.signal.aborted) reportError(failure);
        } finally {
            if (active.current === controller) {
                active.current = null;
                setRunning(false);
            }
        }
    }
    async function start() {
        if (!sample || !user || running) return;
        const controller = new AbortController();
        active.current = controller;
        setRunning(true);
        setStopped(false);
        setComplete(false);
        setError(null);
        setStorageWarning(false);
        // 提交时立即清空页面令牌字段，异步请求仅保留本次所需的短命副本；恢复状态保存精确UUID和公开选择，明文不会因页面刷新、列表重取或错误通知被序列化。
        // 对于响应丢失的创建请求，不自动猜测密钥版本；用户可重新读取元数据并显式选择。
        // 已接受作业在本地停止后仍可能继续，重新进入会读取真实资源版本和相同校验键。
        // 配置指纹覆盖来源清单与环境，不能把旧回执套用到被修改的目标或角色。
        const shortLived = { ...secrets };
        setSecrets((value) => ({ ...value, businessToken: "", fixtureToken: "" }));
        try {
            if (!currentWorkspace) throw new SampleImportError("WORKSPACE_REQUIRED");
            if (shortLived.businessToken && shortLived.businessToken === shortLived.fixtureToken)
                throw new SampleImportError("CREDENTIAL_INPUT_INVALID");
            const options: ImportOptions = {
                ...form,
                workspaceId: currentWorkspace,
                baseURL: targetOrigin(form.baseURL),
                apiBaseURL: targetOrigin(form.apiBaseURL),
                fixtureBaseURL: targetOrigin(form.fixtureBaseURL),
            };
            if (
                !/^[A-Za-z_][A-Za-z0-9_.-]{0,79}$/.test(options.roleKey) ||
                ![options.businessRef, options.fixtureRef].every((value) =>
                    /^[A-Za-z_][A-Za-z0-9_-]{0,159}$/.test(value),
                ) ||
                options.businessRef === options.fixtureRef ||
                !options.businessIdentity ||
                !options.fixtureIdentity ||
                !options.buildSha ||
                !options.locale ||
                !options.timezone ||
                !Number.isInteger(options.validationTimeout) ||
                options.validationTimeout < 1 ||
                options.validationTimeout > 3600
            )
                throw new SampleImportError("CONFIG_INVALID");
            try {
                new Intl.DateTimeFormat(options.locale, { timeZone: options.timezone });
            } catch {
                throw new SampleImportError("CONFIG_INVALID");
            }
            let progress = memory.current;
            if (!progress) {
                try {
                    progress = readProgress(storageKey, currentWorkspace);
                } catch {
                    setStorageWarning(true);
                }
            }
            progress ??= {
                fingerprint: importFingerprint(options, sample),
                workspaceId: currentWorkspace,
                versions: {},
            };
            memory.current = progress;
            const result = await importSample(
                sample,
                options,
                shortLived,
                progress,
                controller.signal,
                (next) => {
                    memory.current = next;
                    try {
                        writeProgress(storageKey, next);
                    } catch {
                        setStorageWarning(true);
                    }
                },
                (event) => {
                    controller.signal.throwIfAborted();
                    setEvents((previous) => [
                        ...previous.filter(
                            (item) => item.asset !== event.asset || item.phase !== event.phase,
                        ),
                        event,
                    ]);
                },
            );
            controller.signal.throwIfAborted();
            setCompletedPlan(result.planId);
            setComplete(true);
            onComplete?.(result);
        } catch (failure) {
            if (controller.signal.aborted && active.current === controller) setStopped(true);
            else reportError(failure);
        } finally {
            shortLived.businessToken = "";
            shortLived.fixtureToken = "";
            if (active.current === controller) {
                active.current = null;
                setRunning(false);
            }
        }
    }
    const field = (name: TextField, label: string) => (
        <label>
            {t(label)}
            <input
                value={form[name]}
                onChange={(event) => setForm((value) => ({ ...value, [name]: event.target.value }))}
                required
            />
        </label>
    );
    const credentialSelector = (kind: "business" | "fixture") => {
        const version = kind === "business" ? "businessVersion" : "fixtureVersion";
        const reference = kind === "business" ? "businessRef" : "fixtureRef";
        const identity = kind === "business" ? form.businessIdentity : form.fixtureIdentity;
        return (
            <label>
                {t(version)}
                <select
                    value={secrets[version]}
                    onChange={(event) => {
                        const selected = credentials.find(
                            (item) => item.versionId === event.target.value,
                        );
                        setSecrets((value) => ({ ...value, [version]: event.target.value }));
                        if (selected)
                            setForm((value) => ({ ...value, [reference]: selected.secretRef }));
                    }}
                >
                    <option value="">{t("newCredential")}</option>
                    {credentials
                        .filter(
                            (item) => !item.revoked && item.allowedIdentityIds.includes(identity),
                        )
                        .map((item, index) => (
                            <option key={item.versionId} value={item.versionId}>
                                {item.secretRef} ({index + 1})
                            </option>
                        ))}
                </select>
            </label>
        );
    };
    if (!user) return null;
    return (
        <section aria-labelledby="sample-wizard-title" data-testid="sample-workspace-wizard">
            <h2 id="sample-wizard-title" tabIndex={-1}>
                {t("title")}
            </h2>
            <p>{t("summary")}</p>
            {!sample && <p role="status">{t("load")}</p>}
            {sample && (
                <p>
                    {t("source")}: {Object.keys(sample.sourceInventory).length}
                </p>
            )}
            {error && (
                <div role="alert">
                    <p>{t("error")}</p>
                    <p>{t(`errors.${error.key}`, { defaultValue: t("errors.UNKNOWN") })}</p>
                    {error.code && <code>{error.code}</code>}
                    {error.requestId && <code>{error.requestId}</code>}
                </div>
            )}
            {storageWarning && <p role="status">{t("errors.STORAGE_UNAVAILABLE")}</p>}
            <button
                type="button"
                disabled={running}
                onClick={() => {
                    setError(null);
                    setReload((value) => value + 1);
                }}
            >
                {t("reloadMetadata")}
            </button>
            <fieldset disabled={running}>
                <legend>{t("workspace")}</legend>
                {currentWorkspace ? (
                    <p>
                        <code>{currentWorkspace}</code>
                    </p>
                ) : (
                    <>
                        <label>
                            {t("workspaceKey")}
                            <input
                                value={workspaceKey}
                                onChange={(event) => setWorkspaceKey(event.target.value)}
                            />
                        </label>
                        <label>
                            {t("workspaceName")}
                            <input
                                value={workspaceName}
                                onChange={(event) => setWorkspaceName(event.target.value)}
                            />
                        </label>
                        <button type="button" onClick={() => void createWorkspace()}>
                            {t("createWorkspace")}
                        </button>
                    </>
                )}
            </fieldset>
            <form
                onSubmit={(event) => {
                    event.preventDefault();
                    void start();
                }}
                autoComplete="off"
            >
                <fieldset disabled={running}>
                    <legend>{t("target")}</legend>
                    {field("baseURL", "baseURL")}
                    {field("apiBaseURL", "apiURL")}
                    {field("fixtureBaseURL", "fixtureURL")}
                    {field("buildSha", "build")}
                    {field("locale", "locale")}
                    {field("timezone", "timezone")}
                    {field("roleKey", "role")}
                    {field("businessIdentity", "businessIdentity")}
                    {field("fixtureIdentity", "fixtureIdentity")}
                </fieldset>
                <fieldset disabled={running || !currentWorkspace}>
                    <legend>{t("credentials")}</legend>
                    <p>{t("tokenHelp")}</p>
                    <label>
                        {t("adapter")}
                        <select
                            value={secrets.adapterVersion}
                            onChange={(event) =>
                                setSecrets((value) => ({
                                    ...value,
                                    adapterVersion: event.target.value,
                                }))
                            }
                        >
                            <option value="">{t("newAdapter")}</option>
                            {adapters
                                .filter(
                                    (item) =>
                                        !item.revoked && item.configuration.kind === "HTTP_BEARER",
                                )
                                .map((item, index) => (
                                    <option key={item.versionId} value={item.versionId}>
                                        HTTP_BEARER ({index + 1})
                                    </option>
                                ))}
                        </select>
                    </label>
                    {field("businessRef", "businessRef")}
                    {credentialSelector("business")}
                    <label>
                        {t("businessToken")}
                        <input
                            type="password"
                            value={secrets.businessToken}
                            autoComplete="new-password"
                            onChange={(event) =>
                                setSecrets((value) => ({
                                    ...value,
                                    businessToken: event.target.value,
                                }))
                            }
                        />
                    </label>
                    {field("fixtureRef", "fixtureRef")}
                    {credentialSelector("fixture")}
                    <label>
                        {t("fixtureToken")}
                        <input
                            type="password"
                            value={secrets.fixtureToken}
                            autoComplete="new-password"
                            onChange={(event) =>
                                setSecrets((value) => ({
                                    ...value,
                                    fixtureToken: event.target.value,
                                }))
                            }
                        />
                    </label>
                    <label>
                        {t("runtime")}
                        <select
                            required
                            value={form.runtimeId}
                            onChange={(event) =>
                                setForm((value) => ({ ...value, runtimeId: event.target.value }))
                            }
                        >
                            <option value="">{t("selectRuntime")}</option>
                            {runtimes.map((item) => (
                                <option
                                    key={item.id}
                                    value={item.id}
                                    disabled={
                                        item.status !== "ONLINE" ||
                                        item.trustStatus !== "MANAGED" ||
                                        !item.allowCredentialDelivery
                                    }
                                >
                                    {item.name} / {item.status} / {item.trustStatus}
                                </option>
                            ))}
                        </select>
                    </label>
                    <p>{t("runtimeHelp")}</p>
                    <label>
                        {t("timeout")}
                        <input
                            type="number"
                            min={1}
                            max={3600}
                            value={form.validationTimeout}
                            onChange={(event) =>
                                setForm((value) => ({
                                    ...value,
                                    validationTimeout: Number(event.target.value),
                                }))
                            }
                        />
                    </label>
                </fieldset>
                <button
                    type="submit"
                    disabled={running || !sample || !currentWorkspace}
                    data-testid="sample-import-start"
                >
                    {t("start")}
                </button>
            </form>
            {running && (
                <button
                    type="button"
                    data-testid="sample-import-stop"
                    onClick={() => active.current?.abort()}
                >
                    {t("stop")}
                </button>
            )}
            {stopped && <p role="status">{t("stopped")}</p>}
            <ol aria-label={t("progress")} aria-live="polite">
                {events.map((event) => (
                    <li key={`${event.phase}:${event.asset ?? ""}`}>
                        {t(event.phase === "plan" ? "planPhase" : event.phase)} {event.asset ?? ""}{" "}
                        {event.state ?? ""} {event.waitReason ?? ""}{" "}
                        {event.jobId && <code>{event.jobId}</code>}
                    </li>
                ))}
            </ol>
            {complete && (
                <p role="status">
                    {t("finished")}{" "}
                    <Link
                        to={`/execution-plans?workspaceId=${encodeURIComponent(currentWorkspace)}&planId=${encodeURIComponent(completedPlan)}`}
                    >
                        {t("plan")}
                    </Link>
                </p>
            )}
            <button
                type="button"
                disabled={running}
                onClick={() => {
                    memory.current = null;
                    try {
                        sessionStorage.removeItem(storageKey);
                    } catch {
                        setStorageWarning(true);
                    }
                    setEvents([]);
                    setComplete(false);
                }}
            >
                {t("clear")}
            </button>
            <p>{t("resetHelp")}</p>
            {onClose && (
                <button
                    type="button"
                    onClick={() => {
                        active.current?.abort();
                        setSecrets({ ...noSecrets });
                        onClose();
                    }}
                >
                    {t("close")}
                </button>
            )}
        </section>
    );
}

/** 员工身份和当前Workspace共同作为向导实例键，宿主即使没有显式key也会在作用域变化时卸载所有秘密字段和请求控制器，旧异步完成不能污染新员工或新空间的进度与错误提示。
 */
export function SampleWorkspaceWizard(props: SampleWorkspaceWizardProps) {
    const { user } = useContext(Auth);
    if (!user) return null;
    return (
        <SampleWorkspaceWizardSession key={`${user.id}:${props.workspaceId ?? ""}`} {...props} />
    );
}
