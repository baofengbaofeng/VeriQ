/**
 * 离线包页：按 Workspace 选择资源版本导出 Bundle，并下载已签发包（大小上限校验在适配器）。导出选择不可跨空间混合版本。
 * 使用 CloudBundleAdapter(selected)；未登录 Navigate 到 /login。
 */

import { tx, useAppLocale } from "../../locale";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { Navigate } from "react-router-dom";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Auth } from "../../auth-context";
import { api } from "../../api";
import { Panel } from "../../ui";
import { useWorkspace } from "../workspaces/WorkspaceContext";
import { CloudResourceAdapter, type Resource, type Version } from "../resources/adapters";
import { CloudBundleAdapter, type BundleAdapter } from "./adapters";
/**
 * 拉取工作区列表并默认选中首项，再把 selected 与 adapter 交给 BundleWorkspaceView。自身不持有导出表单状态，避免与空间
 * 切换竞态。
 */
export function BundlePage() {
    useAppLocale();
    const { user } = useContext(Auth),
        { selected, select, signal } = useWorkspace();
    const workspaces = useInfiniteQuery({
        queryKey: ["workspaces", user?.id],
        queryFn: ({ pageParam, signal }) => api.workspaces(pageParam, signal),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (p) => p.nextCursor ?? undefined,
        enabled: !!user,
    });
    const items = workspaces.data?.pages.flatMap((p) => p.items) ?? [];
    // 离线包入口只在空间尚未选定时采用首项，列表引用更新不改变手动选择；适配器仍按空间标识缓存，使同空间的版本篮子与环
    // 境选择继续由原有子组件持有。
    const firstWorkspaceId = items[0]?.id;
    useEffect(() => {
        if (!selected && firstWorkspaceId) select(firstWorkspaceId);
    }, [firstWorkspaceId, selected, select]);
    const adapter = useMemo(() => new CloudBundleAdapter(selected), [selected]);
    if (!user) return <Navigate to="/login" />;
    const workspace = items.find((w) => w.id === selected);
    return (
        <Panel title={tx("离线包 / Offline bundles")}>
            <label>
                {tx("空间 / Workspace")}
                <select aria-label={tx("Bundle Workspace")} value={selected} onChange={(e) => select(e.target.value)}>
                    {items.map((w) => (
                        <option key={w.id} value={w.id}>
                            {w.name}
                        </option>
                    ))}
                </select>
            </label>
            {workspaces.error && <p role="alert">{workspaces.error.message}</p>}
            {workspaces.hasNextPage && (
                <button type="button" onClick={() => void workspaces.fetchNextPage()}>
                    {tx("更多空间 / More Workspaces")}
                </button>
            )}
            {workspace && (
                <BundleWorkspaceView
                    key={user.id + selected}
                    workspaceId={selected}
                    adapter={adapter}
                    signal={signal}
                    canDownload={workspace.role !== "VIEWER"}
                    canEdit={["OWNER", "ADMIN", "EDITOR"].includes(workspace.role)}
                />
            )}
        </Panel>
    );
}
/**
 * 拥有资源/版本多选与导出进度 UI；export 带 Idempotency-Key，download 触发浏览器保存。只读依赖 CloudResourceAdapter 列
 * 出版本；写路径仅
 * BundleAdapter.export/download。
 */
export function BundleWorkspaceView({
    workspaceId,
    adapter,
    signal,
    canDownload,
    canEdit,
}: {
    workspaceId: string;
    adapter: BundleAdapter;
    signal: AbortSignal | undefined;
    canDownload: boolean;
    canEdit: boolean;
}) {
    useAppLocale();
    const resources = useMemo(() => new CloudResourceAdapter(workspaceId), [workspaceId]);
    const [kind, setKind] = useState<"CASE" | "SUITE" | "DRAFT">("CASE"),
        [resource, setResource] = useState(""),
        [version, setVersion] = useState(""),
        [basket, setBasket] = useState<{ resource: Resource; version: Version }[]>([]),
        [environment, setEnvironment] = useState(""),
        [environmentVersion, setEnvironmentVersion] = useState(""),
        [error, setError] = useState(""),
        [busy, setBusy] = useState(false),
        [status, setStatus] = useState("");
    const retry = useRef<{ body: string; key: string }>();
    const controller = useMemo(() => new AbortController(), []);
    useEffect(() => () => controller.abort(), [controller]);
    const combined = useMemo(
        () => AbortSignal.any([...(signal ? [signal] : []), controller.signal]),
        [signal, controller],
    );
    const list = useInfiniteQuery({
        queryKey: ["workspace", "bundle-resources", workspaceId],
        queryFn: ({ pageParam, signal: querySignal }) =>
            resources.list(undefined, pageParam, AbortSignal.any([combined, querySignal])),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (p) => p.nextCursor ?? undefined,
    });
    const versions = useInfiniteQuery({
        queryKey: ["workspace", "bundle-versions", workspaceId, resource],
        queryFn: ({ pageParam, signal: q }) => resources.versions(resource, pageParam, AbortSignal.any([combined, q])),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (p) => p.nextCursor ?? undefined,
        enabled: !!resource && kind !== "DRAFT",
    });
    const environments = useInfiniteQuery({
        queryKey: ["workspace", "bundle-environment", workspaceId, environment],
        queryFn: ({ pageParam, signal: q }) =>
            resources.versions(environment, pageParam, AbortSignal.any([combined, q])),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (p) => p.nextCursor ?? undefined,
        enabled: !!environment,
    });
    const bundles = useInfiniteQuery({
        queryKey: ["workspace", "bundles", workspaceId, adapter],
        queryFn: ({ pageParam, signal: q }) => adapter.list(pageParam, AbortSignal.any([combined, q])),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (p) => p.nextCursor ?? undefined,
        enabled: canDownload,
    });
    const items = list.data?.pages.flatMap((p) => p.items) ?? [];
    const operation = async (run: () => Promise<void>) => {
        setBusy(true);
        setError("");
        setStatus("");
        try {
            await run();
        } catch (e) {
            if (!combined.aborted) setError(e instanceof Error ? e.message : "Export failed");
        } finally {
            if (!combined.aborted) setBusy(false);
        }
    };
    const exportBundle = () =>
        operation(async () => {
            let selection: Parameters<BundleAdapter["export"]>[0];
            if (kind === "DRAFT") {
                const preview = await resources.preview(resource, combined);
                const job = await resources.validate(
                    resource,
                    { revision: preview.revision, sourceHash: preview.sourceHash },
                    combined,
                );
                selection = {
                    draftValidationJobId: job.id,
                    environmentVersionId: environmentVersion,
                    validationStatus: "UNVALIDATED_DEBUG",
                };
            } else
                selection = {
                    ...(kind === "CASE"
                        ? { caseVersionIds: basket.map((item) => item.version.id) }
                        : { suiteVersionId: version }),
                    environmentVersionId: environmentVersion,
                    validationStatus: "VALIDATED",
                };
            const body = JSON.stringify(selection);
            if (retry.current?.body !== body) retry.current = { body, key: crypto.randomUUID() };
            await adapter.export(selection, retry.current.key, combined);
            if (!combined.aborted) {
                setStatus("已导出 / Exported");
                await bundles.refetch();
            }
        });
    const download = (id: string) =>
        operation(async () => {
            if (adapter.install) {
                await adapter.install(id, combined);
                setStatus("已下载并验签 / Downloaded and verified");
                return;
            }
            const blob = await adapter.download(id, combined);
            combined.throwIfAborted();
            const url = URL.createObjectURL(blob),
                a = document.createElement("a");
            try {
                a.href = url;
                a.download = `veriq-${id}.zip`;
                a.click();
            } finally {
                URL.revokeObjectURL(url);
            }
        });
    const resourceOptions = (rows: Resource[]) =>
        rows.map((r) => (
            <option key={r.id} value={r.id}>
                {r.name}
            </option>
        ));
    const versionOptions = (rows: Version[]) =>
        rows.map((v) => (
            <option key={v.id} value={v.id}>
                v{v.versionNo} · {v.id}
            </option>
        ));
    return (
        <section>
            <p>
                {tx(
                    "签名用于来源与完整性校验。本地运行使用本机凭证，离线撤销状态未知。 / Signatu" +
                        "res verify source and integrity. Local runs use loca" +
                        "l credentials; offline revocation status is unknown.",
                )}
            </p>
            {!canDownload ? (
                <p role="status">{tx("需要下载权限 / Download permission required")}</p>
            ) : (
                <>
                    <label>
                        {tx("选择类型 / Selection")}
                        <select
                            value={kind}
                            onChange={(e) => {
                                setKind(e.target.value as typeof kind);
                                setResource("");
                                setVersion("");
                            }}
                        >
                            <option value="CASE">{tx("用例 / Case")}</option>
                            <option value="SUITE">{tx("套件 / Suite")}</option>
                            {canEdit && <option value="DRAFT">{tx("草稿调试 / Draft DEBUG")}</option>}
                        </select>
                    </label>
                    <label>
                        {tx("资源 / Resource")}
                        <select
                            value={resource}
                            onChange={(e) => {
                                setResource(e.target.value);
                                setVersion("");
                            }}
                        >
                            <option value="">{tx("请选择 / Select")}</option>
                            {resourceOptions(
                                items.filter((r) =>
                                    kind === "DRAFT" ? ["CASE", "SUITE"].includes(r.kind) : r.kind === kind,
                                ),
                            )}
                        </select>
                    </label>
                    {kind !== "DRAFT" && (
                        <label>
                            {tx("不可变版本 / Published version")}
                            <select
                                multiple={kind === "CASE"}
                                value={kind === "CASE" ? (version ? version.split(",") : []) : version}
                                onChange={(e) =>
                                    setVersion(
                                        kind === "CASE"
                                            ? Array.from(e.target.selectedOptions)
                                                  .map((o) => o.value)
                                                  .filter(Boolean)
                                                  .join(",")
                                            : e.target.value,
                                    )
                                }
                            >
                                <option value="">{tx("请选择 / Select")}</option>
                                {versionOptions(versions.data?.pages.flatMap((p) => p.items) ?? [])}
                            </select>
                        </label>
                    )}
                    {kind !== "DRAFT" && versions.hasNextPage && (
                        <button
                            type="button"
                            disabled={versions.isFetchingNextPage}
                            onClick={() => void versions.fetchNextPage()}
                        >
                            {tx("更多版本 / More versions")}
                        </button>
                    )}
                    {kind === "CASE" && (
                        <>
                            <button
                                type="button"
                                disabled={!version || basket.length >= 100}
                                onClick={() => {
                                    const selectedResource = items.find((r) => r.id === resource);
                                    if (!selectedResource) return;
                                    const selectedVersions =
                                        versions.data?.pages
                                            .flatMap((p) => p.items)
                                            .filter((v) => version.split(",").includes(v.id)) ?? [];
                                    const additions = selectedVersions.filter(
                                        (v) => !basket.some((item) => item.version.id === v.id),
                                    );
                                    if (basket.length + additions.length > 100) {
                                        setError("最多100个用例版本 / At most 100 case versions");
                                        return;
                                    }
                                    setBasket((current) => [
                                        ...current,
                                        ...additions.map((v) => ({
                                            resource: selectedResource,
                                            version: v,
                                        })),
                                    ]);
                                    setVersion("");
                                }}
                            >
                                {tx("添加用例 / Add case versions")}
                            </button>
                            <ul aria-label={tx("Selected case versions")}>
                                {basket.map((item) => (
                                    <li key={item.version.id}>
                                        {item.resource.name} · v{item.version.versionNo} · {item.version.id}
                                        <button
                                            type="button"
                                            aria-label={tx("Remove {{value0}} v{{value1}}", {
                                                value0: item.resource.name,
                                                value1: item.version.versionNo,
                                            })}
                                            onClick={() =>
                                                setBasket((current) =>
                                                    current.filter((v) => v.version.id !== item.version.id),
                                                )
                                            }
                                        >
                                            {tx("移除 / Remove")}
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </>
                    )}
                    <label>
                        {tx("环境 / Environment")}
                        <select
                            value={environment}
                            onChange={(e) => {
                                setEnvironment(e.target.value);
                                setEnvironmentVersion("");
                            }}
                        >
                            <option value="">{tx("请选择 / Select")}</option>
                            {resourceOptions(items.filter((r) => r.kind === "ENVIRONMENT"))}
                        </select>
                    </label>
                    <label>
                        {tx("环境版本 / Environment version")}
                        <select value={environmentVersion} onChange={(e) => setEnvironmentVersion(e.target.value)}>
                            <option value="">{tx("请选择 / Select")}</option>
                            {versionOptions(environments.data?.pages.flatMap((p) => p.items) ?? [])}
                        </select>
                    </label>
                    {environments.hasNextPage && (
                        <button
                            type="button"
                            disabled={environments.isFetchingNextPage}
                            onClick={() => void environments.fetchNextPage()}
                        >
                            {tx("更多环境版本 / More environment versions")}
                        </button>
                    )}
                    {kind === "DRAFT" && (
                        <p>
                            {tx(
                                "未验证 DSL 快照；本地必须先编译，不用于正式门禁。 / Unvalidated DSL snapsh" +
                                    "ot; local compilation required," +
                                    " excluded from formal gates.",
                            )}
                        </p>
                    )}
                    <button
                        type="button"
                        disabled={
                            busy ||
                            !environmentVersion ||
                            (kind === "CASE" ? !basket.length : !resource || (kind === "SUITE" && !version))
                        }
                        onClick={() => void exportBundle()}
                    >
                        {tx("导出签名包 / Export signed bundle")}
                    </button>
                    {list.hasNextPage && (
                        <button type="button" onClick={() => void list.fetchNextPage()}>
                            {tx("更多资源 / More resources")}
                        </button>
                    )}
                    <h2>{tx("已导出 / Exports")}</h2>
                    {(bundles.data?.pages.flatMap((p) => p.items) ?? []).map((b) => (
                        <article key={b.id}>
                            <p>
                                {b.id} · {b.validationStatus} · {b.createdAt}
                            </p>
                            <button type="button" disabled={busy} onClick={() => void download(b.id)}>
                                {tx("下载 / Download")}
                            </button>
                        </article>
                    ))}
                    {bundles.data && !bundles.data.pages.some((p) => p.items.length) && (
                        <p>{tx("暂无离线包 / No bundles")}</p>
                    )}
                    {bundles.hasNextPage && (
                        <button type="button" onClick={() => void bundles.fetchNextPage()}>
                            {tx("更多离线包 / More bundles")}
                        </button>
                    )}
                </>
            )}
            {(error || list.error || versions.error || environments.error || bundles.error) && (
                <p role="alert">
                    {error ||
                        list.error?.message ||
                        versions.error?.message ||
                        environments.error?.message ||
                        bundles.error?.message}
                </p>
            )}
            {busy && <p role="status">{tx("处理中 / Working…")}</p>}
            {status && <p role="status">{status}</p>}
        </section>
    );
}
