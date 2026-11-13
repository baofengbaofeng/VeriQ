/** 执行计划页面在当前员工和空间的生命周期内管理已发布资产选择及受限自动化身份，切换身份或空间时卸载全部表单和一次性令牌，查询缓存只保存无秘密的计划与令牌元数据。 */
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PlatformComponents } from "@veriq/contracts";
import { Auth } from "../../auth-context";
import { api, request, runtimeApi, type Workspace } from "../../api";
import { Panel } from "../../ui";
import { useWorkspace } from "../workspaces/WorkspaceContext";
import { CloudResourceAdapter } from "../resources/adapters";
type S = PlatformComponents["schemas"];
type Plan = S["ExecutionPlanDTO"];
type Write = S["ExecutionPlanWrite"];
type Page<T> = { items: T[]; nextCursor: string | null };

/** 空间选择器只显示当前账户可见的真实空间并支持游标续页，页面内容以用户与空间共同作为键重新挂载，因此旧请求的表单结果和一次性令牌不会在切换后出现在另一个授权范围。 */
export function ExecutionPlansPage() {
    const { user } = useContext(Auth),
        { selected, select } = useWorkspace();
    const spaces = useInfiniteQuery({
        queryKey: ["workspaces", user?.id],
        queryFn: ({ pageParam, signal }) => api.workspaces(pageParam, signal),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (p) => p.nextCursor ?? undefined,
        enabled: !!user,
    });
    const items = spaces.data?.pages.flatMap((p) => p.items) ?? [];
    useEffect(() => {
        if (!selected && items.length) select(items[0]!.id);
    }, [selected, items[0]?.id]);
    if (!user) return <Navigate to="/login" />;
    const workspace = items.find((w) => w.id === selected);
    return (
        <Panel title="执行计划 / Execution plans">
            <label>
                空间 / Workspace
                <select
                    aria-label="Plan Workspace"
                    value={selected}
                    onChange={(e) => select(e.target.value)}
                >
                    {items.map((w) => (
                        <option key={w.id} value={w.id}>
                            {w.name}
                        </option>
                    ))}
                </select>
            </label>
            {spaces.error && <p role="alert">{spaces.error.message}</p>}
            {spaces.hasNextPage && (
                <button onClick={() => void spaces.fetchNextPage()}>
                    更多空间 / More Workspaces
                </button>
            )}
            {workspace && <PlanWorkspace key={user.id + selected} workspace={workspace} />}
        </Panel>
    );
}

/** 资源版本选择器分别分页读取资源和已发布版本，选中资源改变时立即清空版本，只有服务返回的不可变版本才能写入表单；编辑旧计划时保留明确版本标识而不自动替换为最新版本。 */
function VersionSelector({
    workspace,
    kind,
    value,
    onChange,
    signal,
}: {
    workspace: string;
    kind: "SUITE" | "ENVIRONMENT";
    value: string;
    onChange: (value: string) => void;
    signal: AbortSignal;
}) {
    const adapter = useMemo(() => new CloudResourceAdapter(workspace), [workspace]);
    const [resource, setResource] = useState("");
    const resources = useInfiniteQuery({
        queryKey: ["workspace", workspace, "plan-resources", kind],
        queryFn: ({ pageParam, signal: q }) =>
            adapter.list(kind, pageParam, AbortSignal.any([signal, q])),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (p) => p.nextCursor ?? undefined,
    });
    const versions = useInfiniteQuery({
        queryKey: ["workspace", workspace, "plan-versions", resource],
        queryFn: ({ pageParam, signal: q }) =>
            adapter.versions(resource, pageParam, AbortSignal.any([signal, q])),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (p) => p.nextCursor ?? undefined,
        enabled: !!resource,
    });
    const listed = versions.data?.pages.flatMap((p) => p.items) ?? [];
    return (
        <fieldset>
            <legend>{kind === "SUITE" ? "套件 / Suite" : "环境 / Environment"}</legend>
            <label>
                资源 / Resource
                <select
                    aria-label={kind + " resource"}
                    value={resource}
                    onChange={(e) => {
                        setResource(e.target.value);
                        onChange("");
                    }}
                >
                    <option value="">选择资源 / Select resource</option>
                    {resources.data?.pages
                        .flatMap((p) => p.items)
                        .filter((r) => r.status !== "ARCHIVED")
                        .map((r) => (
                            <option key={r.id} value={r.id}>
                                {r.name}
                            </option>
                        ))}
                </select>
            </label>
            {resources.hasNextPage && (
                <button type="button" onClick={() => void resources.fetchNextPage()}>
                    更多资源 / More resources
                </button>
            )}
            <label>
                版本 / Version
                <select
                    required
                    aria-label={kind + " version"}
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                >
                    <option value="">选择已发布版本 / Select published version</option>
                    {value && !listed.some((v) => v.id === value) && (
                        <option value={value}>{value}</option>
                    )}
                    {listed.map((v) => (
                        <option key={v.id} value={v.id}>
                            {v.versionNo} — {v.id}
                        </option>
                    ))}
                </select>
            </label>
            {versions.hasNextPage && (
                <button type="button" onClick={() => void versions.fetchNextPage()}>
                    更多版本 / More versions
                </button>
            )}
            {(resources.error || versions.error) && (
                <p role="alert">{resources.error?.message ?? versions.error?.message}</p>
            )}
        </fieldset>
    );
}

/** 计划管理表单只发送明确选择，运行触发保留一次操作的幂等键供网络重试；服务端冲突会原样显示并保留用户输入，查询和轮询在页面卸载时取消，旧空间结果不会更新新空间的状态。 */
function PlanWorkspace({ workspace }: { workspace: Workspace }) {
    const base = `/workspaces/${workspace.id}`,
        cache = useQueryClient();
    const controller = useMemo(() => new AbortController(), []);
    useEffect(() => () => controller.abort(), [controller]);
    const signal = controller.signal;
    const canEdit = !workspace.archived && ["OWNER", "ADMIN", "EDITOR"].includes(workspace.role);
    const canExecute = !workspace.archived && workspace.role !== "VIEWER";
    const [editing, setEditing] = useState<Plan | null>(null),
        [name, setName] = useState(""),
        [suite, setSuite] = useState(""),
        [environment, setEnvironment] = useState(""),
        [roles, setRoles] = useState("reader"),
        [variables, setVariables] = useState("{}"),
        [browsers, setBrowsers] = useState<string[]>(["chromium"]),
        [runtimeIds, setRuntimeIds] = useState<string[]>([]),
        [policy, setPolicy] = useState<Write["overlapPolicy"]>("QUEUE"),
        [retries, setRetries] = useState(0),
        [error, setError] = useState(""),
        [busy, setBusy] = useState(false),
        [receipt, setReceipt] = useState<S["TriggerReceipt"] | null>(null);
    const triggerKey = useRef<{ plan: string; key: string }>();
    const plans = useInfiniteQuery({
        queryKey: ["workspace", workspace.id, "plans"],
        queryFn: ({ pageParam, signal: q }) =>
            request<Page<Plan>>(
                base +
                    "/execution-plans" +
                    (pageParam ? "?cursor=" + encodeURIComponent(pageParam) : ""),
                "GET",
                undefined,
                AbortSignal.any([signal, q]),
            ),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (p) => p.nextCursor ?? undefined,
    });
    const runtimes = useInfiniteQuery({
        queryKey: ["workspace", workspace.id, "plan-runtimes"],
        queryFn: ({ pageParam, signal: q }) =>
            runtimeApi.list(workspace.id, pageParam, AbortSignal.any([signal, q])),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (p) => p.nextCursor ?? undefined,
    });
    const status = useQuery({
        queryKey: ["workspace", workspace.id, "plan-status", receipt?.runId],
        queryFn: ({ signal: q }) =>
            request<S["RunDTO"]>(
                base + "/runs/" + receipt!.runId,
                "GET",
                undefined,
                AbortSignal.any([signal, q]),
            ),
        enabled: !!receipt,
        refetchInterval: (query) => (query.state.data?.state === "FINISHED" ? false : 2000),
    });
    const rows = plans.data?.pages.flatMap((p) => p.items) ?? [];
    const act = async (work: () => Promise<void>) => {
        setBusy(true);
        setError("");
        try {
            await work();
        } catch (e) {
            if (!signal.aborted) setError((e as Error).message);
        } finally {
            if (!signal.aborted) setBusy(false);
        }
    };
    const refresh = () =>
        cache.invalidateQueries({ queryKey: ["workspace", workspace.id, "plans"] });
    const edit = (p: Plan | null) => {
        setEditing(p);
        setName(p?.name ?? "");
        setSuite(p?.suiteVersionId ?? "");
        setEnvironment(p?.environmentVersionId ?? "");
        setRoles(p?.roleKeys.join(", ") ?? "reader");
        setVariables(JSON.stringify(p?.variables ?? {}, null, 4));
        setBrowsers(p?.browsers ?? ["chromium"]);
        setRuntimeIds(p?.runtimeIds ?? []);
        setPolicy(p?.overlapPolicy ?? "QUEUE");
        setRetries(p?.maxCaseRetries ?? 0);
    };
    return (
        <>
            <p>计划只保存执行选择；定时由外部调度器调用 HTTP。 / Scheduling is external.</p>
            <Link to="/runtimes">
                设备登记、共享与凭证投递 / Runtime enrollment and permissions
            </Link>
            {(error || plans.error || runtimes.error || status.error) && (
                <p role="alert">
                    {error ||
                        plans.error?.message ||
                        runtimes.error?.message ||
                        status.error?.message}
                </p>
            )}
            {plans.isPending && <p role="status">加载计划 / Loading plans…</p>}
            {rows.map((p) => (
                <section key={p.id} aria-label={p.name}>
                    <h2>{p.name}</h2>
                    <p>
                        {p.overlapPolicy} · revision {p.revision} {p.archived && "归档 / Archived"}
                    </p>
                    {canEdit && !p.archived && (
                        <>
                            <button disabled={busy} onClick={() => edit(p)}>
                                编辑 / Edit
                            </button>
                            <button
                                disabled={busy}
                                onClick={() =>
                                    void act(async () => {
                                        await request(
                                            base + "/execution-plans/" + p.id,
                                            "DELETE",
                                            { revision: p.revision },
                                            signal,
                                        );
                                        await refresh();
                                    })
                                }
                            >
                                归档 / Archive
                            </button>
                        </>
                    )}
                    {canExecute && !p.archived && (
                        <button
                            disabled={busy}
                            onClick={() =>
                                void act(async () => {
                                    if (triggerKey.current?.plan !== p.id)
                                        triggerKey.current = {
                                            plan: p.id,
                                            key: crypto.randomUUID(),
                                        };
                                    const result = await request<S["TriggerReceipt"]>(
                                        base + "/execution-plans/" + p.id + "/trigger",
                                        "POST",
                                        {},
                                        signal,
                                        { "Idempotency-Key": triggerKey.current.key },
                                    );
                                    if (!signal.aborted) {
                                        setReceipt(result);
                                        triggerKey.current = undefined;
                                    }
                                })
                            }
                        >
                            触发 / Trigger
                        </button>
                    )}
                </section>
            ))}
            {plans.hasNextPage && (
                <button onClick={() => void plans.fetchNextPage()}>更多计划 / More plans</button>
            )}
            {receipt && (
                <section aria-label="Trigger status">
                    <p>
                        {receipt.decision} · {status.data?.state} · {status.data?.outcome} ·{" "}
                        {status.data?.reasonCode}
                    </p>
                    <Link to={`/reports?runId=${receipt.runId}&workspaceId=${workspace.id}`}>
                        运行报告 / Run report
                    </Link>
                    {canExecute && status.data?.state !== "FINISHED" && (
                        <button
                            disabled={busy}
                            onClick={() =>
                                void act(async () => {
                                    await request(
                                        base + "/runs/" + receipt.runId + "/cancel",
                                        "POST",
                                        { reason: "Cancelled from execution plans" },
                                        signal,
                                    );
                                    await status.refetch();
                                })
                            }
                        >
                            取消运行 / Cancel Run
                        </button>
                    )}
                </section>
            )}
            {canEdit && (
                <form
                    aria-label="Execution plan form"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void act(async () => {
                            const body: Write = {
                                name,
                                suiteVersionId: suite,
                                environmentVersionId: environment,
                                roleKeys: roles
                                    .split(",")
                                    .map((r) => r.trim())
                                    .filter(Boolean),
                                browsers: browsers as Write["browsers"],
                                runtimeIds,
                                overlapPolicy: policy,
                                maxCaseRetries: retries,
                                variables: JSON.parse(variables),
                                ...(editing ? { revision: editing.revision } : {}),
                            };
                            await request(
                                base + "/execution-plans" + (editing ? "/" + editing.id : ""),
                                editing ? "PUT" : "POST",
                                body,
                                signal,
                            );
                            if (!signal.aborted) edit(null);
                            await refresh();
                        });
                    }}
                >
                    <h2>{editing ? "编辑计划 / Edit plan" : "创建计划 / Create plan"}</h2>
                    <label>
                        名称 / Name
                        <input
                            aria-label="Plan name"
                            required
                            maxLength={160}
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                        />
                    </label>
                    <VersionSelector
                        workspace={workspace.id}
                        kind="SUITE"
                        value={suite}
                        onChange={setSuite}
                        signal={signal}
                    />
                    <VersionSelector
                        workspace={workspace.id}
                        kind="ENVIRONMENT"
                        value={environment}
                        onChange={setEnvironment}
                        signal={signal}
                    />
                    <label>
                        角色（逗号分隔） / Role keys
                        <input
                            aria-label="Plan roles"
                            required
                            value={roles}
                            onChange={(e) => setRoles(e.target.value)}
                        />
                    </label>
                    <label>
                        初始变量 / Initial variables
                        <textarea
                            aria-label="Plan variables"
                            value={variables}
                            onChange={(e) => setVariables(e.target.value)}
                        />
                    </label>
                    <fieldset>
                        <legend>浏览器 / Browsers</legend>
                        {["chromium", "firefox", "webkit"].map((b) => (
                            <label key={b}>
                                <input
                                    type="checkbox"
                                    checked={browsers.includes(b)}
                                    onChange={(e) =>
                                        setBrowsers(
                                            e.target.checked
                                                ? [...browsers, b]
                                                : browsers.filter((v) => v !== b),
                                        )
                                    }
                                />
                                {b}
                            </label>
                        ))}
                    </fieldset>
                    <fieldset>
                        <legend>执行设备 / Runtimes</legend>
                        {runtimes.data?.pages
                            .flatMap((p) => p.items)
                            .map((r) => (
                                <label key={r.id}>
                                    <input
                                        type="checkbox"
                                        checked={runtimeIds.includes(r.id)}
                                        onChange={(e) =>
                                            setRuntimeIds(
                                                e.target.checked
                                                    ? [...runtimeIds, r.id]
                                                    : runtimeIds.filter((v) => v !== r.id),
                                            )
                                        }
                                    />
                                    {r.name} · {r.trustStatus}
                                </label>
                            ))}
                        {runtimeIds
                            .filter(
                                (id) =>
                                    !runtimes.data?.pages.some((p) =>
                                        p.items.some((r) => r.id === id),
                                    ),
                            )
                            .map((id) => (
                                <label key={id}>
                                    <input
                                        type="checkbox"
                                        checked
                                        onChange={() =>
                                            setRuntimeIds(runtimeIds.filter((v) => v !== id))
                                        }
                                    />
                                    {id}
                                </label>
                            ))}
                        {runtimes.hasNextPage && (
                            <button type="button" onClick={() => void runtimes.fetchNextPage()}>
                                更多设备 / More Runtimes
                            </button>
                        )}
                    </fieldset>
                    <label>
                        重叠策略 / Overlap
                        <select
                            aria-label="Overlap policy"
                            value={policy}
                            onChange={(e) => setPolicy(e.target.value as Write["overlapPolicy"])}
                        >
                            <option>QUEUE</option>
                            <option>SKIP</option>
                            <option>REJECT</option>
                        </select>
                    </label>
                    <label>
                        整用例重试 / Case retries
                        <select
                            value={retries}
                            onChange={(e) => setRetries(Number(e.target.value))}
                        >
                            <option value={0}>0</option>
                            <option value={1}>1</option>
                        </select>
                    </label>
                    <button
                        disabled={
                            busy || !suite || !environment || !runtimeIds.length || !browsers.length
                        }
                    >
                        保存计划 / Save plan
                    </button>
                    {editing && (
                        <button type="button" onClick={() => edit(null)}>
                            新建 / New plan
                        </button>
                    )}
                </form>
            )}
            {["OWNER", "ADMIN"].includes(workspace.role) && !workspace.archived && (
                <ServiceAccounts
                    workspace={workspace.id}
                    plans={rows.filter((p) => !p.archived)}
                    signal={signal}
                />
            )}
        </>
    );
}

/** 服务身份管理仅把一次性签发值留在本组件内存，关闭显示、切换账号或卸载即清除，分页缓存只保存账号和令牌元数据；签发用途分别限定维护操作、执行计划或短期设备登记，避免用途混用。 */
function ServiceAccounts({
    workspace,
    plans,
    signal,
}: {
    workspace: string;
    plans: Plan[];
    signal: AbortSignal;
}) {
    const base = `/workspaces/${workspace}/service-accounts`,
        cache = useQueryClient();
    const [account, setAccount] = useState(""),
        [name, setName] = useState(""),
        [secret, setSecret] = useState(""),
        [error, setError] = useState(""),
        [busy, setBusy] = useState(false),
        [purpose, setPurpose] = useState("EXECUTION"),
        [scopes, setScopes] = useState<string[]>(["trigger", "read", "cancel"]),
        [planIds, setPlanIds] = useState<string[]>([]);
    const accounts = useInfiniteQuery({
        queryKey: ["workspace", workspace, "service-accounts"],
        queryFn: ({ pageParam, signal: q }) =>
            request<Page<S["ServiceAccountDTO"]>>(
                base + (pageParam ? "?cursor=" + encodeURIComponent(pageParam) : ""),
                "GET",
                undefined,
                AbortSignal.any([signal, q]),
            ),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (p) => p.nextCursor ?? undefined,
    });
    const tokens = useInfiniteQuery({
        queryKey: ["workspace", workspace, "service-tokens", account],
        queryFn: ({ pageParam, signal: q }) =>
            request<S["ServiceTokenPage"]>(
                base +
                    "/" +
                    account +
                    "/tokens" +
                    (pageParam ? "?cursor=" + encodeURIComponent(pageParam) : ""),
                "GET",
                undefined,
                AbortSignal.any([signal, q]),
            ),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (p) => p.nextCursor ?? undefined,
        enabled: !!account,
    });
    const act = async (action: () => Promise<void>) => {
        setBusy(true);
        setError("");
        setSecret("");
        try {
            await action();
        } catch (e) {
            if (!signal.aborted) setError((e as Error).message);
        } finally {
            if (!signal.aborted) setBusy(false);
        }
    };
    const choices =
        purpose === "EXECUTION"
            ? ["trigger", "read", "cancel"]
            : [
                  "expired-leases/reap",
                  "fixture-cleanups/reconcile",
                  "capacity/reconcile",
                  "artifacts/expire",
              ];
    return (
        <section aria-label="Service accounts">
            <h2>服务账号与受限令牌 / Service accounts</h2>
            {(error || accounts.error || tokens.error) && (
                <p role="alert">{error || accounts.error?.message || tokens.error?.message}</p>
            )}
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    void act(async () => {
                        const created = await request<S["ServiceAccountDTO"]>(
                            base,
                            "POST",
                            { name },
                            signal,
                        );
                        if (!signal.aborted) {
                            setAccount(created.id);
                            setName("");
                        }
                        await cache.invalidateQueries({
                            queryKey: ["workspace", workspace, "service-accounts"],
                        });
                    });
                }}
            >
                <label>
                    账号名称 / Account name
                    <input
                        aria-label="Service account name"
                        required
                        maxLength={160}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                    />
                </label>
                <button disabled={busy}>创建账号 / Create account</button>
            </form>
            <select
                disabled={busy}
                aria-label="Service account"
                value={account}
                onChange={(e) => {
                    setAccount(e.target.value);
                    setSecret("");
                }}
            >
                <option value="">选择账号 / Select account</option>
                {accounts.data?.pages
                    .flatMap((p) => p.items)
                    .map((a) => (
                        <option key={a.id} value={a.id} disabled={a.disabled}>
                            {a.name}
                            {a.disabled ? " (disabled)" : ""}
                        </option>
                    ))}
            </select>
            {accounts.hasNextPage && (
                <button onClick={() => void accounts.fetchNextPage()}>
                    更多账号 / More accounts
                </button>
            )}
            {account && (
                <>
                    <button
                        disabled={busy}
                        onClick={() =>
                            void act(async () => {
                                await request(
                                    base + "/" + account + "/disable",
                                    "POST",
                                    {},
                                    signal,
                                );
                                if (!signal.aborted) setAccount("");
                                await accounts.refetch();
                            })
                        }
                    >
                        禁用账号 / Disable account
                    </button>
                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            void act(async () => {
                                const result = await request<{ token: string }>(
                                    base + "/" + account + "/tokens",
                                    "POST",
                                    {
                                        purpose,
                                        ...(purpose !== "RUNTIME_ENROLLMENT"
                                            ? { operations: scopes }
                                            : {}),
                                        ...(purpose === "EXECUTION" ? { planIds } : {}),
                                    },
                                    signal,
                                );
                                if (!signal.aborted) setSecret(result.token);
                                await tokens.refetch();
                            });
                        }}
                    >
                        <label>
                            用途 / Purpose
                            <select
                                aria-label="Token purpose"
                                value={purpose}
                                onChange={(e) => {
                                    setPurpose(e.target.value);
                                    setScopes([]);
                                    setSecret("");
                                }}
                            >
                                <option>EXECUTION</option>
                                <option>MAINTENANCE</option>
                                <option>RUNTIME_ENROLLMENT</option>
                            </select>
                        </label>
                        <p>
                            {purpose === "RUNTIME_ENROLLMENT"
                                ? "10 分钟内一次登记 / One enrollment within 10 minutes"
                                : "有效期 24 小时，可立即吊销 / Expires in 24 hours; revocable"}
                        </p>
                        {purpose !== "RUNTIME_ENROLLMENT" && (
                            <fieldset>
                                <legend>操作 / Operations</legend>
                                {choices.map((operation) => (
                                    <label key={operation}>
                                        <input
                                            type="checkbox"
                                            checked={scopes.includes(operation)}
                                            onChange={(e) =>
                                                setScopes(
                                                    e.target.checked
                                                        ? [...scopes, operation]
                                                        : scopes.filter((s) => s !== operation),
                                                )
                                            }
                                        />
                                        {operation}
                                    </label>
                                ))}
                            </fieldset>
                        )}
                        {purpose === "EXECUTION" && (
                            <fieldset>
                                <legend>授权计划 / Allowed plans</legend>
                                {plans.map((p) => (
                                    <label key={p.id}>
                                        <input
                                            type="checkbox"
                                            checked={planIds.includes(p.id)}
                                            onChange={(e) =>
                                                setPlanIds(
                                                    e.target.checked
                                                        ? [...planIds, p.id]
                                                        : planIds.filter((id) => id !== p.id),
                                                )
                                            }
                                        />
                                        {p.name}
                                    </label>
                                ))}
                                <p>
                                    服务仅能使用自己拥有或所有者共享到空间的设备。 / Service-owned
                                    or explicitly Workspace-shared Runtimes only.
                                </p>
                            </fieldset>
                        )}
                        <button
                            disabled={
                                busy ||
                                (purpose !== "RUNTIME_ENROLLMENT" && !scopes.length) ||
                                (purpose === "EXECUTION" && !planIds.length)
                            }
                        >
                            签发令牌 / Issue token
                        </button>
                    </form>
                    {secret && (
                        <section aria-label="One-time token">
                            <p>
                                仅显示一次，请保存到 CI 秘密变量。 / Shown once; save in CI secrets.
                            </p>
                            <output>{secret}</output>
                            <button onClick={() => setSecret("")}>关闭令牌 / Dismiss token</button>
                        </section>
                    )}
                    {tokens.data?.pages
                        .flatMap((p) => p.items)
                        .map((t) => (
                            <article key={t.id}>
                                <p>
                                    {t.id} · {t.purpose} · {t.expiresAt} · {t.operations.join(", ")}{" "}
                                    · {t.planIds.join(", ")}
                                    {t.revoked && " · revoked"}
                                    {t.consumed && " · consumed"}
                                </p>
                                {!t.revoked && (
                                    <button
                                        disabled={busy}
                                        onClick={() =>
                                            void act(async () => {
                                                await request(
                                                    base +
                                                        "/" +
                                                        account +
                                                        "/tokens/" +
                                                        t.id +
                                                        "/revoke",
                                                    "POST",
                                                    {},
                                                    signal,
                                                );
                                                await tokens.refetch();
                                            })
                                        }
                                    >
                                        吊销 / Revoke
                                    </button>
                                )}
                            </article>
                        ))}
                    {tokens.hasNextPage && (
                        <button onClick={() => void tokens.fetchNextPage()}>
                            更多令牌 / More tokens
                        </button>
                    )}
                </>
            )}
        </section>
    );
}
