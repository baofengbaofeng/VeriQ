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
 * 公开符号 BundlePage（function）定义 apps/web/src/features/bundles/BundlePage.tsx 对外可复用的界面或工具接口
 * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
 * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
 */
export function BundlePage() {
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
    useEffect(() => {
        if (!selected && items.length) select(items[0]!.id);
    }, [selected, items[0]?.id]);
    const adapter = useMemo(() => new CloudBundleAdapter(selected), [selected]);
    if (!user) return <Navigate to="/login" />;
    const workspace = items.find((w) => w.id === selected);
    return (
        <Panel title="离线包 / Offline bundles">
            <label>
                空间 / Workspace
                <select
                    aria-label="Bundle Workspace"
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
            {workspaces.error && <p role="alert">{workspaces.error.message}</p>}
            {workspaces.hasNextPage && (
                <button onClick={() => void workspaces.fetchNextPage()}>
                    更多空间 / More Workspaces
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
 * 公开符号 BundleWorkspaceView（function）定义 apps/web/src/features/bundles/BundlePage.tsx 对外可复用的界面或工具接口
 * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
 * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
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
        queryFn: ({ pageParam, signal: q }) =>
            resources.versions(resource, pageParam, AbortSignal.any([combined, q])),
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
        queryFn: ({ pageParam, signal: q }) =>
            adapter.list(pageParam, AbortSignal.any([combined, q])),
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
        <section data-testid="bundle-workspace">
            <p>
                签名用于来源与完整性校验。本地运行使用本机凭证，离线撤销状态未知。 / Signatures
                verify source and integrity. Local runs use local credentials; offline revocation
                status is unknown.
            </p>
            {!canDownload ? (
                <p role="status">需要下载权限 / Download permission required</p>
            ) : (
                <>
                    <label>
                        选择类型 / Selection
                        <select
                            data-testid="bundle-kind"
                            value={kind}
                            onChange={(e) => {
                                setKind(e.target.value as typeof kind);
                                setResource("");
                                setVersion("");
                            }}
                        >
                            <option value="CASE">用例 / Case</option>
                            <option value="SUITE">套件 / Suite</option>
                            {canEdit && <option value="DRAFT">草稿调试 / Draft DEBUG</option>}
                        </select>
                    </label>
                    <label>
                        资源 / Resource
                        <select
                            data-testid="bundle-resource"
                            value={resource}
                            onChange={(e) => {
                                setResource(e.target.value);
                                setVersion("");
                            }}
                        >
                            <option value="">请选择 / Select</option>
                            {resourceOptions(
                                items.filter((r) =>
                                    kind === "DRAFT"
                                        ? ["CASE", "SUITE"].includes(r.kind)
                                        : r.kind === kind,
                                ),
                            )}
                        </select>
                    </label>
                    {kind !== "DRAFT" && (
                        <label>
                            不可变版本 / Published version
                            <select
                                data-testid="bundle-version"
                                multiple={kind === "CASE"}
                                value={
                                    kind === "CASE" ? (version ? version.split(",") : []) : version
                                }
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
                                <option value="">请选择 / Select</option>
                                {versionOptions(versions.data?.pages.flatMap((p) => p.items) ?? [])}
                            </select>
                        </label>
                    )}
                    {kind !== "DRAFT" && versions.hasNextPage && (
                        <button
                            data-testid="bundle-more-versions"
                            disabled={versions.isFetchingNextPage}
                            onClick={() => void versions.fetchNextPage()}
                        >
                            更多版本 / More versions
                        </button>
                    )}
                    {kind === "CASE" && (
                        <>
                            <button
                                data-testid="bundle-add-case"
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
                                添加用例 / Add case versions
                            </button>
                            <ul aria-label="Selected case versions">
                                {basket.map((item) => (
                                    <li key={item.version.id} data-testid="bundle-selected-case">
                                        {item.resource.name} · v{item.version.versionNo} ·{" "}
                                        {item.version.id}
                                        <button
                                            aria-label={`Remove ${item.resource.name} v${item.version.versionNo}`}
                                            onClick={() =>
                                                setBasket((current) =>
                                                    current.filter(
                                                        (v) => v.version.id !== item.version.id,
                                                    ),
                                                )
                                            }
                                        >
                                            移除 / Remove
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </>
                    )}
                    <label>
                        环境 / Environment
                        <select
                            data-testid="bundle-environment"
                            value={environment}
                            onChange={(e) => {
                                setEnvironment(e.target.value);
                                setEnvironmentVersion("");
                            }}
                        >
                            <option value="">请选择 / Select</option>
                            {resourceOptions(items.filter((r) => r.kind === "ENVIRONMENT"))}
                        </select>
                    </label>
                    <label>
                        环境版本 / Environment version
                        <select
                            data-testid="bundle-environment-version"
                            value={environmentVersion}
                            onChange={(e) => setEnvironmentVersion(e.target.value)}
                        >
                            <option value="">请选择 / Select</option>
                            {versionOptions(environments.data?.pages.flatMap((p) => p.items) ?? [])}
                        </select>
                    </label>
                    {environments.hasNextPage && (
                        <button
                            data-testid="bundle-more-environments"
                            disabled={environments.isFetchingNextPage}
                            onClick={() => void environments.fetchNextPage()}
                        >
                            更多环境版本 / More environment versions
                        </button>
                    )}
                    {kind === "DRAFT" && (
                        <p>
                            未验证 DSL 快照；本地必须先编译，不用于正式门禁。 / Unvalidated DSL
                            snapshot; local compilation required, excluded from formal gates.
                        </p>
                    )}
                    <button
                        data-testid="bundle-export"
                        disabled={
                            busy ||
                            !environmentVersion ||
                            (kind === "CASE"
                                ? !basket.length
                                : !resource || (kind === "SUITE" && !version))
                        }
                        onClick={() => void exportBundle()}
                    >
                        导出签名包 / Export signed bundle
                    </button>
                    {list.hasNextPage && (
                        <button onClick={() => void list.fetchNextPage()}>
                            更多资源 / More resources
                        </button>
                    )}
                    <h2>已导出 / Exports</h2>
                    {(bundles.data?.pages.flatMap((p) => p.items) ?? []).map((b) => (
                        <article key={b.id} data-testid="bundle-item">
                            <p>
                                {b.id} · {b.validationStatus} · {b.createdAt}
                            </p>
                            <button
                                disabled={busy}
                                data-testid="bundle-download"
                                onClick={() => void download(b.id)}
                            >
                                下载 / Download
                            </button>
                        </article>
                    ))}
                    {bundles.data && !bundles.data.pages.some((p) => p.items.length) && (
                        <p>暂无离线包 / No bundles</p>
                    )}
                    {bundles.hasNextPage && (
                        <button onClick={() => void bundles.fetchNextPage()}>
                            更多离线包 / More bundles
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
            {busy && <p role="status">处理中 / Working…</p>}
            {status && <p role="status">{status}</p>}
        </section>
    );
}
