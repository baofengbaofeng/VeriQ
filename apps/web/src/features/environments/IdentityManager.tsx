/**
 * 工作区认证与凭证面板展示固定版本；允许写入时提供创建和轮换，密钥通过适配器提交，查询缓存只保留版本摘要。
 * 两类版本通过页内标签分别展示，工作区、外层设置页签或写入权限边界变化时销毁本地表单草稿。
 */

import { tx, useAppLocale } from "../../locale";
import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Controller, useController, useForm } from "react-hook-form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import {
    validateSchema,
    type JsonObject,
    type AuthAdapterConfigV1,
    type BrowserSsoAuthConfigV1,
} from "@veriq/contracts";
import { Button, Section } from "@veriq/ui";
import { Field, Select, SelectItem } from "../../components";
import { ApiError, type Workspace } from "../../api";
import { useOperationFeedback } from "../../operation-feedback";
import { useRequestLifetime } from "../../request-lifetime";
import { DataTable, useTableView } from "../../table-view";
import {
    CloudIdentityAdapter,
    listAllAdapters,
    listAllCredentials,
    type AdapterSummary,
    type CredentialSummary,
    type IdentityAdapter,
} from "./identity-adapter";
import { ErrorState } from "../resources/ResourcePage";
import { SettingsPanel, SettingsTabList } from "../workspaces/SettingsTabs";
import "./identity-manager.css";

const noVersions: readonly never[] = [];

type CredentialForm = {
    secretRef: string;
    identities: string;
    mode: "create" | "rotate";
    kind: string;
    token: string;
    username: string;
    password: string;
};
type AdapterForm = Omit<BrowserSsoAuthConfigV1, "kind"> & {
    kind: AuthAdapterConfigV1["kind"];
    loginPath: string;
};
/**
 * 浏览器登录的路径及表单可访问名称既用于创建适配器，也用于版本摘要；账号和密码仍由凭证表单单独写入。
 */
const browserSsoFields = [
    { name: "entryPath", label: "Protected entry path" },
    { name: "idpOrigin", label: "IdP origin" },
    { name: "idpLoginPath", label: "IdP sign-in page path" },
    { name: "idpSubmitPath", label: "IdP form submission path" },
    { name: "callbackPath", label: "Application callback path" },
    { name: "usernameLabel", label: "Username field label" },
    { name: "passwordLabel", label: "Password field label" },
    { name: "submitName", label: "Submit button name" },
] as const;

/**
 * 版本详情只读展示所属行的固定版本，沿用对话框的焦点限制和关闭后焦点恢复，避免与同一行的撤销操作混淆。
 */
function VersionDetailsDialog({
    title,
    triggerLabel,
    children,
}: {
    title: string;
    triggerLabel: string;
    children: ReactNode;
}) {
    return (
        <Dialog.Root>
            <Dialog.Trigger asChild>
                <Button tone="secondary" aria-label={triggerLabel}>
                    {tx("Details")}
                </Button>
            </Dialog.Trigger>
            <Dialog.Portal>
                <Dialog.Overlay className="vq-overlay vq-workspace-overlay" />
                <Dialog.Content
                    className="vq-dialog vq-workspace-dialog vq-identity-details-dialog"
                    aria-describedby={undefined}
                >
                    <div className="vq-card-heading">
                        <Dialog.Title>{title}</Dialog.Title>
                    </div>
                    <dl className="vq-identity-details">{children}</dl>
                    <div className="vq-workspace-form-actions">
                        <Dialog.Close asChild>
                            <Button tone="secondary">{tx("Close")}</Button>
                        </Dialog.Close>
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}

/**
 * 详情包含适配器实际生效的协议字段，令牌模式的配置已全部列在表格中，登录接口和浏览器模式另行展示字段。
 */
function AdapterDetails({ configuration, versionId }: Pick<AdapterSummary, "configuration" | "versionId">) {
    if (configuration.kind === "HTTP_BEARER") return null;
    return (
        <VersionDetailsDialog
            title={tx("Authentication adapter details")}
            triggerLabel={tx("Adapter details for {{value0}}", { value0: versionId })}
        >
            <dt>{tx("类型 / Type")}</dt>
            <dd>{configuration.kind}</dd>
            <dt>{tx("Version ID")}</dt>
            <dd>
                <code className="vq-identity-version">{versionId}</code>
            </dd>
            <dt>{tx("身份路径 / Identity path")}</dt>
            <dd>
                <code>{configuration.identityPath}</code>
            </dd>
            <dt>{tx("Identity field path")}</dt>
            <dd>
                <code>{configuration.identityPointer}</code>
            </dd>
            {configuration.kind === "HTTP_SESSION" ? (
                <>
                    <dt>{tx("登录路径 / Login path")}</dt>
                    <dd>
                        <code>{configuration.loginPath}</code>
                    </dd>
                </>
            ) : (
                browserSsoFields.map(({ name, label }) => (
                    <Fragment key={name}>
                        <dt>{tx(label)}</dt>
                        <dd>
                            <code>{configuration[name]}</code>
                        </dd>
                    </Fragment>
                ))
            )}
        </VersionDetailsDialog>
    );
}

/**
 * 凭证详情使用已授权列表提供的版本摘要，不读取表单或凭证原文；状态随列表刷新，撤销后的历史版本仍可查看。
 */
function CredentialDetails({
    version: { secretRef, versionId, allowedIdentityIds, revoked, createdAt },
    dateFormat,
}: {
    version: CredentialSummary;
    dateFormat: Intl.DateTimeFormat;
}) {
    const status = revoked ? "REVOKED" : "ACTIVE";
    return (
        <VersionDetailsDialog
            title={tx("Credential version details")}
            triggerLabel={tx("Credential details for {{value0}}", { value0: versionId })}
        >
            <dt>{tx("引用 key / Secret ref")}</dt>
            <dd>
                <code>{secretRef}</code>
            </dd>
            <dt>{tx("Version ID")}</dt>
            <dd>
                <code className="vq-identity-version">{versionId}</code>
            </dd>
            <dt>{tx("Allowed identities")}</dt>
            <dd>{allowedIdentityIds.join(", ")}</dd>
            <dt>{tx("Status")}</dt>
            <dd>
                <span className="vq-state" data-status={status}>
                    {status}
                </span>
            </dd>
            <dt>{tx("Created")}</dt>
            <dd>
                <time dateTime={createdAt}>{dateFormat.format(new Date(createdAt))}</time>
            </dd>
        </VersionDetailsDialog>
    );
}

/**
 * 确认框只提交触发它的固定版本，等待真实响应期间禁止重复提交；切换工作区后不再发布迟到的结果或更新弹窗。
 */
function RevokeVersionButton({
    versionId,
    secretRef,
    busy,
    revoked,
    scope,
    revoke,
    refresh,
}: {
    versionId: string;
    secretRef?: string;
    busy: boolean;
    revoked: boolean;
    scope: AbortSignal;
    revoke: () => Promise<void>;
    refresh: () => Promise<void>;
}) {
    const [revokeOpen, setRevokeOpen] = useState(false);
    const [pending, setPending] = useState(false);
    const { showSuccess, showFailure } = useOperationFeedback();
    const trigger = useRef<HTMLButtonElement>(null);
    const completed = useRef(false);
    const credential = secretRef !== undefined;

    async function confirmRevoke() {
        if (pending || revoked || scope.aborted) return;
        setPending(true);
        try {
            await revoke();
            if (!scope.aborted) {
                completed.current = true;
                setRevokeOpen(false);
            }
        } catch (cause) {
            if (!scope.aborted) {
                const fallback = credential
                    ? "Could not revoke credential version."
                    : "Could not revoke adapter version.";
                showFailure(cause instanceof ApiError ? cause.message : fallback);
            }
        } finally {
            if (!scope.aborted) setPending(false);
        }
    }

    return (
        <Dialog.Root
            open={revokeOpen}
            onOpenChange={(open) => {
                if (pending) return;
                completed.current = false;
                setRevokeOpen(open);
            }}
        >
            <Dialog.Trigger asChild>
                <Button ref={trigger} tone="danger" disabled={busy || revoked}>
                    {tx("撤销 / Revoke")}
                </Button>
            </Dialog.Trigger>
            <Dialog.Portal>
                <Dialog.Overlay className="vq-overlay vq-workspace-overlay" />
                <Dialog.Content
                    className={`vq-dialog vq-workspace-dialog${credential ? " vq-credential-revoke-dialog" : ""}`}
                    onCloseAutoFocus={(event) => {
                        if (completed.current || trigger.current?.disabled) {
                            event.preventDefault();
                            trigger.current?.closest("tr")?.focus();
                        }
                        // 撤销成功由 completed 确认后先发布反馈，再刷新列表，避免筛选隐藏行后丢失结果。
                        if (completed.current && !scope.aborted) {
                            showSuccess(credential ? "Credential version revoked." : "Adapter version revoked.");
                            void refresh();
                        }
                    }}
                >
                    <div className="vq-card-heading">
                        <Dialog.Title>
                            {tx(credential ? "Revoke credential version" : "Revoke adapter version")}
                        </Dialog.Title>
                    </div>
                    <Dialog.Description className="vq-workspace-key-hint">
                        {tx(
                            credential
                                ? "After revocation, the Runtime can no longer use this version."
                                : "Execution environments cannot use this version after revocation.",
                        )}
                    </Dialog.Description>
                    {credential ? (
                        <dl className="vq-workspace-meta vq-revocation-target">
                            <dt>{tx("引用 key / Secret ref")}</dt>
                            <dd>
                                <code>{secretRef}</code>
                            </dd>
                            <dt>{tx("Version ID")}</dt>
                            <dd>
                                <code className="vq-identity-version">{versionId}</code>
                            </dd>
                        </dl>
                    ) : (
                        <p>
                            <code>{versionId}</code>
                        </p>
                    )}
                    <div className="vq-workspace-form-actions">
                        <Dialog.Close asChild>
                            <Button tone="secondary" disabled={pending}>
                                {tx("Cancel")}
                            </Button>
                        </Dialog.Close>
                        <button
                            type="button"
                            className="vq-btn-danger"
                            disabled={pending || revoked}
                            onClick={() => void confirmRevoke()}
                        >
                            {tx(pending ? "Revoking…" : "撤销 / Revoke")}
                        </button>
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}

/**
 * 适配器主行将固定配置和状态留在表格内，详情与撤销使用独立入口；完成撤销后该行仍可接受键盘焦点并查看详情。
 */
function AdapterVersionRow({
    version: { configuration, versionId, revoked },
    busy,
    scope,
    revoke,
    refresh,
}: {
    version: AdapterSummary;
    busy: boolean;
    scope: AbortSignal;
    revoke?: () => Promise<void>;
    refresh: () => Promise<void>;
}) {
    const status = revoked ? "REVOKED" : "ACTIVE";
    return (
        <tr tabIndex={-1}>
            <td>{configuration.kind}</td>
            <td>
                <code>{configuration.identityPath}</code>
            </td>
            <td>
                <code>{configuration.identityPointer}</code>
            </td>
            <td>
                <code className="vq-user-id">{versionId}</code>
            </td>
            <td>
                <span className="vq-state" data-status={status}>
                    {status}
                </span>
            </td>
            <td>
                <div className="vq-identity-actions">
                    <AdapterDetails configuration={configuration} versionId={versionId} />
                    {revoke && (
                        <RevokeVersionButton
                            versionId={versionId}
                            busy={busy}
                            revoked={revoked}
                            scope={scope}
                            revoke={revoke}
                            refresh={refresh}
                        />
                    )}
                </div>
            </td>
        </tr>
    );
}

/**
 * 模式切换保留当前页签内的输入，保存时只投影所选协议接受的字段，避免其他模式的路径随版本提交。
 */
function adapterConfiguration({
    kind,
    identityPath,
    identityPointer,
    loginPath,
    ...browserSso
}: AdapterForm): AuthAdapterConfigV1 {
    if (kind === "HTTP_SESSION") return { kind, identityPath, identityPointer, loginPath };
    if (kind === "BROWSER_SSO") return { kind, identityPath, identityPointer, ...browserSso };
    return { kind, identityPath, identityPointer };
}

/**
 * 二级标签标识只在认证管理面板实例中使用，适配器作为默认入口，摘要与所属表单共享同一个可访问名称。
 */
const identityTabs = [
    { id: "adapters", label: "认证适配器 / Authentication adapters" },
    { id: "credentials", label: "凭证固定版本 / Credential versions" },
] as const;

/**
 * 每次实际挂载效果都取得独立存活信号，在当前工作区的信号就绪后才创建身份表单和查询，重放时不能复用已中止的控制器。
 */
export function WorkspaceIdentityManager({ workspace, signal }: { workspace: Workspace; signal?: AbortSignal }) {
    const adapter = useMemo(() => new CloudIdentityAdapter(workspace.id), [workspace.id]);
    if (!["OWNER", "ADMIN"].includes(workspace.role)) {
        return <p>{tx("Only Workspace owners and administrators can manage credentials.")}</p>;
    }
    return (
        <IdentityManager
            key={`${workspace.id}:${workspace.archived}`}
            adapter={adapter}
            workspaceId={workspace.id}
            signal={signal}
            readOnly={workspace.archived}
        />
    );
}

export function IdentityManager({
    adapter,
    workspaceId,
    signal,
    readOnly = false,
}: {
    adapter: IdentityAdapter;
    workspaceId: string;
    signal?: AbortSignal;
    readOnly?: boolean;
}) {
    const lifetime = useRequestLifetime(signal);
    return lifetime ? (
        <IdentityForms
            key={`${workspaceId}:${lifetime.generation}`}
            adapter={adapter}
            workspaceId={workspaceId}
            scope={lifetime.signal}
            readOnly={readOnly}
        />
    ) : (
        <p role="status">{tx("正在加载 / Loading…")}</p>
    );
}

/**
 * 身份表单只保留当前工作区的未提交内容，卸载时清除两份表单，保存后刷新固定版本摘要且不回显提交的密钥。
 */
function IdentityForms({
    adapter,
    workspaceId,
    scope,
    readOnly,
}: {
    adapter: IdentityAdapter;
    workspaceId: string;
    scope: AbortSignal;
    readOnly: boolean;
}) {
    const { language } = useAppLocale();
    const credentialDateFormat = useMemo(
        () =>
            new Intl.DateTimeFormat(language, {
                dateStyle: "medium",
                timeStyle: "medium",
                timeZone: "Asia/Shanghai",
            }),
        [language],
    );
    const tabPrefix = useId();
    const [tab, setTab] = useState<(typeof identityTabs)[number]["id"]>("adapters");
    const authTypeId = useId();
    const credentialOperationId = useId();
    const credentialRefId = useId();
    const credentialRefHint = `${credentialRefId}-hint`;
    const credentialRefStatus = `${credentialRefId}-status`;
    const credentialKindId = useId();
    const [rotationDraft, setRotationDraft] = useState("");
    const credential = useForm<CredentialForm>({
        defaultValues: {
            secretRef: "",
            identities: "",
            mode: "create",
            kind: "HTTP_BEARER",
            token: "",
            username: "",
            password: "",
        },
        shouldUnregister: true,
    });
    const rotating = credential.watch("mode") === "rotate";
    // 新建键由表单控制器持有而不依赖输入节点是否显示，切换模式时保留草稿，但轮换绝不会使用这个字符串。
    const { field: newRef } = useController({
        control: credential.control,
        name: "secretRef",
        rules: {
            validate: (value) =>
                credential.getValues("mode") === "rotate" || /^[A-Za-z_][A-Za-z0-9_-]{0,159}$/.test(value),
        },
    });
    const auth = useForm<AdapterForm>({
        defaultValues: {
            kind: "HTTP_BEARER",
            identityPath: "/identity",
            identityPointer: "/id",
            loginPath: "/login",
            entryPath: "",
            idpOrigin: "",
            idpLoginPath: "",
            idpSubmitPath: "",
            callbackPath: "",
            usernameLabel: "",
            passwordLabel: "",
            submitName: "",
        },
    });
    // 表单卸载时由各自控制器清除数据，查询取消则归外层挂载效果管理，普通菜单切换不会中止仍属于当前空间的请求。
    const { reset: resetCredential } = credential;
    const { reset: resetAuth } = auth;
    const [busy, setBusy] = useState(false);
    const [validation, setValidation] = useState<Error | null>(null);
    const authSubmit = useRef<HTMLButtonElement>(null);
    const credentialSubmit = useRef<HTMLButtonElement>(null);
    const saving = useRef(false);
    const { showPending } = useOperationFeedback();
    const client = useQueryClient();
    useEffect(
        () => () => {
            resetCredential();
            resetAuth();
        },
        [resetCredential, resetAuth],
    );
    const credentials = useQuery({
        queryKey: ["workspace", workspaceId, "credential-summaries", "all"],
        queryFn: ({ signal: qs }) => listAllCredentials(adapter, AbortSignal.any([scope, qs])),
    });
    const refsLoading = credentials.isPending || credentials.isFetching;
    const references = useMemo(
        () => [...new Set(credentials.data?.map((version) => version.secretRef))].sort(),
        [credentials.data],
    );
    const referenceOptions = credentials.isSuccess && !refsLoading ? references : [];
    const selectedRef = referenceOptions.includes(rotationDraft) ? rotationDraft : "";
    const adapters = useQuery({
        queryKey: ["workspace", workspaceId, "auth-adapters", "all"],
        queryFn: ({ signal: qs }) => listAllAdapters(adapter, AbortSignal.any([scope, qs])),
    });
    // 两张表在当前工作区各自维护页码和搜索词，版本列表改变不影响轮换表单读取全部已授权的引用选项。
    const adapterTable = useTableView(adapters.data ?? noVersions, {
        matches: ({ configuration, versionId, revoked }, term) =>
            [
                configuration.kind,
                configuration.identityPath,
                configuration.identityPointer,
                versionId,
                revoked ? "REVOKED" : "ACTIVE",
            ].some((value) => value.toLowerCase().includes(term)),
    });
    const credentialTable = useTableView(credentials.data ?? noVersions, {
        matches: ({ secretRef, versionId, allowedIdentityIds, revoked }, term) =>
            [secretRef, versionId, ...allowedIdentityIds, revoked ? "REVOKED" : "ACTIVE"].some((value) =>
                value.toLowerCase().includes(term),
            ),
    });
    // 等待框和终态共用同一个条目；工作区失效时立即关闭等待框，过期响应不再更新用户当前看到的页面。
    const run = (trigger: HTMLButtonElement | null, message: string, fn: () => Promise<string>) => {
        if (!trigger || saving.current || scope.aborted) return;
        const pending = showPending(message, { trigger, onClose() {} });
        scope.addEventListener("abort", pending.dismiss, { once: true });
        saving.current = true;
        setBusy(true);
        setValidation(null);
        void fn()
            .then((result) => {
                if (!scope.aborted) pending.complete("success", result);
            })
            .catch((e) => {
                if (!scope.aborted)
                    pending.complete(
                        "failure",
                        e instanceof ApiError ? e.message : "Unable to reach VeriQ. Please try again.",
                    );
            })
            .finally(() => {
                scope.removeEventListener("abort", pending.dismiss);
                saving.current = false;
                if (!scope.aborted) setBusy(false);
            });
    };
    const refresh = () => client.invalidateQueries({ queryKey: ["workspace", workspaceId] });
    const clearSecret = () => {
        credential.setValue("token", "");
        credential.setValue("username", "");
        credential.setValue("password", "");
    };
    const kind = credential.watch("kind"),
        authKind = auth.watch("kind");
    return (
        <section className="vq-identity-manager">
            <p>
                {readOnly
                    ? tx("Archived Workspaces are read-only.")
                    : tx(
                          "创建新的固定版本；原文不会回显。修改环境引用后需重新校验发布 / Create immuta" +
                              "ble versions; values are never returned. Republis" +
                              "h environments after changing references.",
                      )}
            </p>
            {validation && <ErrorState error={validation} />}
            <SettingsTabList
                tabs={identityTabs.map((section) => ({ ...section, label: tx(section.label) }))}
                selected={tab}
                prefix={tabPrefix}
                activate={setTab}
                label={tx("Authentication and credentials sections")}
                className="vq-vertical-tabs"
                orientation="vertical"
            />
            <SettingsPanel tab="adapters" prefix={tabPrefix} selected={tab}>
                <Section title={tx(identityTabs[0].label)}>
                    {!readOnly && (
                        <form
                            className="vq-identity-form vq-auth-adapter-form"
                            onSubmit={auth.handleSubmit((data) => {
                                const configuration = adapterConfiguration(data);
                                const issues = validateSchema("AuthAdapterConfigV1", configuration);
                                if (issues.length) {
                                    setValidation(new Error(issues.map((i) => i.path + ": " + i.message).join("\n")));
                                    return;
                                }
                                run(authSubmit.current, tx("Create adapter version"), async () => {
                                    const saved = await adapter.createAdapter(configuration, scope);
                                    scope.throwIfAborted();
                                    await refresh();
                                    return tx("Adapter created: {{versionId}}", { versionId: saved.versionId });
                                });
                            })}
                        >
                            <Controller
                                name="kind"
                                control={auth.control}
                                render={({ field }) => (
                                    <Field
                                        label={tx("类型 / Type")}
                                        htmlFor={authTypeId}
                                        hint={tx("Authentication adapter type hint")}
                                        required
                                    >
                                        <Select
                                            id={authTypeId}
                                            required
                                            appearance="default-dropdown"
                                            value={field.value}
                                            onValueChange={field.onChange}
                                        >
                                            <SelectItem value="HTTP_BEARER">HTTP_BEARER</SelectItem>
                                            <SelectItem value="HTTP_SESSION">HTTP_SESSION</SelectItem>
                                            <SelectItem value="BROWSER_SSO">BROWSER_SSO</SelectItem>
                                        </Select>
                                    </Field>
                                )}
                            />
                            <Field label={tx("身份路径 / Identity path")} hint={tx("Identity path hint")} required>
                                <input aria-required="true" {...auth.register("identityPath", { required: true })} />
                            </Field>
                            <Field label={tx("Identity field path")} hint={tx("Identity field path example")} required>
                                <input aria-required="true" {...auth.register("identityPointer", { required: true })} />
                            </Field>
                            {authKind === "HTTP_SESSION" && (
                                <Field label={tx("登录路径 / Login path")} hint={tx("Login path hint")} required>
                                    <input aria-required="true" {...auth.register("loginPath", { required: true })} />
                                </Field>
                            )}
                            {authKind === "BROWSER_SSO" && (
                                <>
                                    <p>{tx("Browser SSO setup hint")}</p>
                                    {browserSsoFields.map(({ name, label }) => (
                                        <Field key={name} label={tx(label)} hint={tx(`${label} hint`)} required>
                                            <input autoComplete="off" required {...auth.register(name)} />
                                        </Field>
                                    ))}
                                </>
                            )}
                            <div className="vq-identity-form-actions">
                                <Button ref={authSubmit} type="submit" disabled={busy}>
                                    {tx("创建适配器版本 / Create adapter version")}
                                </Button>
                            </div>
                        </form>
                    )}
                    {adapters.isPending && <p role="status">{tx("正在加载 / Loading…")}</p>}
                    {adapters.error && <ErrorState error={adapters.error} retry={() => void adapters.refetch()} />}
                    {adapters.data && (
                        <DataTable
                            label={tx("Authentication adapter versions")}
                            view={adapterTable}
                            searchLabel={tx("Search adapter versions")}
                            paginationLabel={tx("Adapter table pagination")}
                            busy={busy || adapters.isFetching || adapters.isError}
                            exportColumns={[
                                { label: tx("类型 / Type"), value: ({ configuration }) => configuration.kind },
                                {
                                    label: tx("身份路径 / Identity path"),
                                    value: ({ configuration }) => configuration.identityPath,
                                },
                                {
                                    label: tx("Identity field path"),
                                    value: ({ configuration }) => configuration.identityPointer,
                                },
                                { label: tx("Version ID"), value: ({ versionId }) => versionId },
                                { label: tx("Status"), value: ({ revoked }) => (revoked ? "REVOKED" : "ACTIVE") },
                            ]}
                        >
                            <div className="table-scroll">
                                <table
                                    className="vq-user-table vq-identity-table"
                                    aria-label={tx("Authentication adapter versions")}
                                >
                                    <thead>
                                        <tr>
                                            <th scope="col">{tx("类型 / Type")}</th>
                                            <th scope="col">{tx("身份路径 / Identity path")}</th>
                                            <th scope="col">{tx("Identity field path")}</th>
                                            <th scope="col">{tx("Version ID")}</th>
                                            <th scope="col">{tx("Status")}</th>
                                            <th scope="col">{tx("Actions")}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {adapterTable.filteredCount === 0 && (
                                            <tr>
                                                <td className="vq-table-empty" colSpan={6}>
                                                    {tx(
                                                        adapters.data.length
                                                            ? "No matching adapter versions."
                                                            : "尚无适配器 / No adapters.",
                                                    )}
                                                </td>
                                            </tr>
                                        )}
                                        {adapterTable.rows.map((version) => (
                                            <AdapterVersionRow
                                                key={version.versionId}
                                                version={version}
                                                busy={busy}
                                                scope={scope}
                                                revoke={
                                                    readOnly
                                                        ? undefined
                                                        : async () => {
                                                              await adapter.revokeAdapter(version.versionId, scope);
                                                          }
                                                }
                                                refresh={refresh}
                                            />
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </DataTable>
                    )}
                </Section>
            </SettingsPanel>
            <SettingsPanel tab="credentials" prefix={tabPrefix} selected={tab}>
                <Section title={tx(identityTabs[1].label)}>
                    {!readOnly && (
                        <form
                            className="vq-identity-form"
                            autoComplete="off"
                            onSubmit={credential.handleSubmit((data) => {
                                const rotate = data.mode === "rotate";
                                const targetRef = rotate ? selectedRef : data.secretRef;
                                const identities = data.identities
                                    .split(",")
                                    .map((s) => s.trim())
                                    .filter(Boolean);
                                if (!targetRef || !identities.length) {
                                    setValidation(
                                        new Error(
                                            targetRef
                                                ? "At least one allowed identity required"
                                                : "Select an existing credential reference.",
                                        ),
                                    );
                                    clearSecret();
                                    return;
                                }
                                run(
                                    credentialSubmit.current,
                                    tx("保存凭证新版本 / Save credential version"),
                                    async () => {
                                        try {
                                            const value: JsonObject =
                                                data.kind === "HTTP_BEARER"
                                                    ? { token: data.token }
                                                    : { username: data.username, password: data.password };
                                            const saved = await adapter.credential(
                                                targetRef,
                                                value,
                                                identities,
                                                rotate,
                                                scope,
                                            );
                                            scope.throwIfAborted();
                                            await refresh();
                                            return tx("Credential saved: {{versionId}}", {
                                                versionId: saved.versionId,
                                            });
                                        } finally {
                                            // 仅对活动表单调用 clearSecret；scope.aborted 时由生命周期清理秘密。
                                            if (!scope.aborted) clearSecret();
                                        }
                                    },
                                );
                            })}
                        >
                            <div className="vq-credential-targets">
                                <div className="vq-credential-target-field">
                                    <Controller
                                        name="mode"
                                        control={credential.control}
                                        render={({ field }) => (
                                            <Field
                                                htmlFor={credentialOperationId}
                                                label={tx("创建或轮换 / Operation")}
                                                hint={tx("Credential version operation hint")}
                                                required
                                            >
                                                <Select
                                                    id={credentialOperationId}
                                                    appearance="default-dropdown"
                                                    required
                                                    value={field.value}
                                                    onValueChange={(value) => {
                                                        field.onChange(value);
                                                        clearSecret();
                                                    }}
                                                >
                                                    <SelectItem value="create">
                                                        {tx("创建引用 / Create reference")}
                                                    </SelectItem>
                                                    <SelectItem value="rotate">{tx("新版本 / New version")}</SelectItem>
                                                </Select>
                                            </Field>
                                        )}
                                    />
                                </div>
                                {rotating ? (
                                    <div className="vq-credential-target-field">
                                        <Field htmlFor={credentialRefId} label={tx("引用 key / Secret ref")} required>
                                            <Select
                                                id={credentialRefId}
                                                aria-describedby={
                                                    referenceOptions.length
                                                        ? credentialRefHint
                                                        : `${credentialRefHint} ${credentialRefStatus}`
                                                }
                                                appearance="default-dropdown"
                                                required
                                                placeholder={tx("Select an existing reference")}
                                                value={selectedRef}
                                                onValueChange={(value) => {
                                                    if (!referenceOptions.includes(value)) return;
                                                    setRotationDraft(value);
                                                    clearSecret();
                                                }}
                                                disabled={busy || !referenceOptions.length}
                                            >
                                                {referenceOptions.map((ref) => (
                                                    <SelectItem key={ref} value={ref}>
                                                        {ref}
                                                    </SelectItem>
                                                ))}
                                            </Select>
                                        </Field>
                                        <small id={credentialRefHint} className="vq-field-hint">
                                            {tx("Existing credential reference hint")}
                                        </small>
                                        {refsLoading ? (
                                            <small id={credentialRefStatus} role="status">
                                                {tx("Loading credential references…")}
                                            </small>
                                        ) : credentials.error ? (
                                            <div id={credentialRefStatus}>
                                                <ErrorState
                                                    error={credentials.error}
                                                    retry={() => void credentials.refetch()}
                                                />
                                            </div>
                                        ) : (
                                            !referenceOptions.length && (
                                                <small id={credentialRefStatus}>
                                                    {tx("No existing credential references.")}
                                                </small>
                                            )
                                        )}
                                    </div>
                                ) : (
                                    <div className="vq-credential-target-field">
                                        <Field
                                            label={tx("引用 key / Secret ref")}
                                            hint={tx("New credential reference hint")}
                                            required
                                        >
                                            <input required {...newRef} />
                                        </Field>
                                    </div>
                                )}
                            </div>
                            <div className="vq-identity-wide">
                                <Field
                                    label={tx("Allowed identities")}
                                    hint={tx("Allowed credential identities hint")}
                                    required
                                >
                                    <input
                                        type="text"
                                        required
                                        {...credential.register("identities", { required: true })}
                                    />
                                </Field>
                            </div>
                            <div className="vq-credential-values">
                                <div className="vq-credential-target-field">
                                    <Controller
                                        name="kind"
                                        control={credential.control}
                                        render={({ field }) => (
                                            <Field
                                                label={tx("凭证类型 / Credential type")}
                                                htmlFor={credentialKindId}
                                                hint={tx("Credential type hint")}
                                                required
                                            >
                                                <Select
                                                    id={credentialKindId}
                                                    required
                                                    appearance="default-dropdown"
                                                    value={field.value}
                                                    onValueChange={(value) => {
                                                        clearSecret();
                                                        field.onChange(value);
                                                    }}
                                                >
                                                    <SelectItem value="HTTP_BEARER">HTTP_BEARER</SelectItem>
                                                    <SelectItem value="HTTP_SESSION">HTTP_SESSION</SelectItem>
                                                </Select>
                                            </Field>
                                        )}
                                    />
                                </div>
                                {kind === "HTTP_BEARER" ? (
                                    <div className="vq-credential-target-field vq-credential-token-field">
                                        <Field
                                            label={tx("Bearer token")}
                                            hint={tx("Bearer credential token hint")}
                                            required
                                        >
                                            <input
                                                type="password"
                                                autoComplete="new-password"
                                                required
                                                {...credential.register("token", {
                                                    required: kind === "HTTP_BEARER",
                                                })}
                                            />
                                        </Field>
                                    </div>
                                ) : (
                                    <>
                                        <div className="vq-credential-target-field">
                                            <Field
                                                label={tx("用户名 / Username")}
                                                hint={tx("Session credential username hint")}
                                                required={kind === "HTTP_SESSION"}
                                            >
                                                <input
                                                    autoComplete="off"
                                                    aria-required={kind === "HTTP_SESSION"}
                                                    {...credential.register("username", {
                                                        required: kind === "HTTP_SESSION",
                                                    })}
                                                />
                                            </Field>
                                        </div>
                                        <div className="vq-credential-target-field">
                                            <Field
                                                label={tx("密码 / Password")}
                                                hint={tx("Session credential password hint")}
                                                required={kind === "HTTP_SESSION"}
                                            >
                                                <input
                                                    type="password"
                                                    autoComplete="new-password"
                                                    required={kind === "HTTP_SESSION"}
                                                    {...credential.register("password", {
                                                        required: kind === "HTTP_SESSION",
                                                    })}
                                                />
                                            </Field>
                                        </div>
                                    </>
                                )}
                            </div>
                            <div className="vq-identity-form-actions">
                                <Button
                                    ref={credentialSubmit}
                                    type="submit"
                                    disabled={busy || (rotating && !selectedRef)}
                                >
                                    {tx("保存凭证新版本 / Save credential version")}
                                </Button>
                            </div>
                        </form>
                    )}
                    {!rotating && credentials.isPending && <p role="status">{tx("正在加载 / Loading…")}</p>}
                    {!rotating && credentials.error && (
                        <ErrorState error={credentials.error} retry={() => void credentials.refetch()} />
                    )}
                    {credentials.data && (
                        <DataTable
                            label={tx("Credential version list")}
                            view={credentialTable}
                            searchLabel={tx("Search credential versions")}
                            paginationLabel={tx("Credential table pagination")}
                            busy={busy || credentials.isFetching || credentials.isError}
                            exportColumns={[
                                { label: tx("引用 key / Secret ref"), value: ({ secretRef }) => secretRef },
                                { label: tx("Version ID"), value: ({ versionId }) => versionId },
                                {
                                    label: tx("Allowed identities"),
                                    value: ({ allowedIdentityIds }) => allowedIdentityIds.join(", "),
                                },
                                { label: tx("Status"), value: ({ revoked }) => (revoked ? "REVOKED" : "ACTIVE") },
                            ]}
                        >
                            <div className="table-scroll">
                                <table
                                    className="vq-user-table vq-identity-table"
                                    aria-label={tx("Credential version list")}
                                >
                                    <thead>
                                        <tr>
                                            <th scope="col">{tx("引用 key / Secret ref")}</th>
                                            <th scope="col">{tx("Version ID")}</th>
                                            <th scope="col">{tx("Allowed identities")}</th>
                                            <th scope="col">{tx("Status")}</th>
                                            <th scope="col">{tx("Actions")}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {credentialTable.filteredCount === 0 && (
                                            <tr>
                                                <td className="vq-table-empty" colSpan={5}>
                                                    {tx(
                                                        credentials.data.length
                                                            ? "No matching credential versions."
                                                            : "尚无凭证 / No credentials.",
                                                    )}
                                                </td>
                                            </tr>
                                        )}
                                        {credentialTable.rows.map((version) => {
                                            const { secretRef, versionId, allowedIdentityIds, revoked } = version;
                                            const status = revoked ? "REVOKED" : "ACTIVE";
                                            return (
                                                <tr key={versionId} tabIndex={-1}>
                                                    <td>
                                                        <code>{secretRef}</code>
                                                    </td>
                                                    <td>
                                                        <code className="vq-user-id">{versionId}</code>
                                                    </td>
                                                    <td>{allowedIdentityIds.join(", ")}</td>
                                                    <td>
                                                        <span className="vq-state" data-status={status}>
                                                            {status}
                                                        </span>
                                                    </td>
                                                    <td>
                                                        <div className="vq-identity-actions">
                                                            <CredentialDetails
                                                                version={version}
                                                                dateFormat={credentialDateFormat}
                                                            />
                                                            {!readOnly && (
                                                                <RevokeVersionButton
                                                                    secretRef={secretRef}
                                                                    versionId={versionId}
                                                                    busy={busy}
                                                                    revoked={revoked}
                                                                    scope={scope}
                                                                    revoke={async () => {
                                                                        await adapter.revokeCredential(
                                                                            secretRef,
                                                                            versionId,
                                                                            scope,
                                                                        );
                                                                    }}
                                                                    refresh={refresh}
                                                                />
                                                            )}
                                                        </div>
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        </DataTable>
                    )}
                </Section>
            </SettingsPanel>
        </section>
    );
}
