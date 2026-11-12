/**
 * 资源页：Workspace 下列表、创建、草稿编辑、校验作业轮询与发布；可被桌面复用编辑器视图。归档资源默认只读；桌面宿主可嵌入同一编辑器且归档资源只读。
 * CloudResourceAdapter(selected)；桌面可注入 LocalResourceAdapter。
 */

import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { Navigate } from "react-router-dom";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { FormProvider, useForm, useWatch } from "react-hook-form";
import { useReactTable, getCoreRowModel, flexRender, type ColumnDef } from "@tanstack/react-table";
import { useTranslation } from "react-i18next";
import { validateSchema, type ResourceDocumentV1, type ResourceKind } from "@veriq/contracts";
import { Button, ConfirmDialog, Section } from "@veriq/ui";
import { api, ApiError, type Workspace } from "../../api";
import { Auth } from "../../auth-context";
import { Panel } from "../../ui";
import { useWorkspace } from "../workspaces/WorkspaceContext";
import {
    CloudResourceAdapter,
    type ResourceAdapter,
    type Resource,
    type Draft,
    type Version,
    type Receipt,
    type Job,
} from "./adapters";
import { ResourceForms, newDocument, resourceKinds } from "./ResourceForms";
import { Monaco, MonacoDiff } from "./Monaco";
import { editorI18n, useEditorTranslationOptions } from "./i18n";
import type { EditorValues, VersionOption } from "./fields";
import "./resources.css";
const clean = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
type ValidationCandidate = Pick<
    Receipt,
    "workspaceId" | "resourceId" | "jobId" | "revision" | "sourceHash" | "engineVersion"
> & { documentHash: string; generation: number };
const receiptMatchesCandidate = (receipt: Receipt, candidate: ValidationCandidate) =>
    receipt.workspaceId === candidate.workspaceId &&
    receipt.resourceId === candidate.resourceId &&
    receipt.jobId === candidate.jobId &&
    receipt.revision === candidate.revision &&
    receipt.sourceHash === candidate.sourceHash &&
    receipt.engineVersion === candidate.engineVersion;
const schemas: Record<ResourceKind, string> = {
    CASE: "CaseDslV1",
    ELEMENT_CATALOG: "ElementCatalogV1",
    ASSERTION_TEMPLATE: "AssertionTemplateV1",
    DATASET: "DatasetV1",
    FLOW: "FlowV1",
    FIXTURE: "FixtureV1",
    SUITE: "SuiteV1",
    ENVIRONMENT: "EnvironmentV1",
};
const editableRole = (workspace: Workspace, kind: ResourceKind) =>
    !workspace.archived &&
    (kind === "ENVIRONMENT"
        ? ["OWNER", "ADMIN"].includes(workspace.role)
        : ["OWNER", "ADMIN", "EDITOR"].includes(workspace.role));
function useLifetime(parent?: AbortSignal) {
    const [controller] = useState(() => new AbortController());
    const signal = useMemo(
        () => (parent ? AbortSignal.any([parent, controller.signal]) : controller.signal),
        [parent, controller],
    );
    useEffect(() => () => controller.abort(), [controller]);
    return signal;
}
/**
 * 按 kind 过滤入口（默认全部资源）；挂载工作区选择后渲染 ResourceWorkspaceView。environments 路由传入固定 kind。
 * 环境页可传入固定 kind=ENVIRONMENT 复用同一套列表逻辑。
 */
export function ResourcePage({
    initialKind,
    extra,
}: {
    initialKind?: ResourceKind;
    extra?: (workspace: Workspace) => React.ReactNode;
}) {
    const { user } = useContext(Auth),
        { selected, select } = useWorkspace(),
        { t } = useTranslation(undefined, useEditorTranslationOptions);
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
    if (!user) return <Navigate to="/login" />;
    const workspace = items.find((w) => w.id === selected);
    return (
        <Panel title={t(initialKind === "ENVIRONMENT" ? "environments" : "resources")}>
            <div className="vq-actions">
                <label>
                    {t("language")}
                    <select
                        value={editorI18n.language}
                        onChange={(e) => void editorI18n.changeLanguage(e.target.value)}
                    >
                        <option value="zh">中文</option>
                        <option value="en">English</option>
                    </select>
                </label>
                {!!items.length && (
                    <label>
                        Workspace
                        <select
                            data-testid="resource-workspace"
                            value={selected}
                            onChange={(e) => select(e.target.value)}
                        >
                            {items.map((w) => (
                                <option key={w.id} value={w.id}>
                                    {w.name}
                                    {w.archived ? " (Archived)" : ""}
                                </option>
                            ))}
                        </select>
                    </label>
                )}
            </div>
            {workspaces.isPending && <p role="status">{t("loading")}</p>}
            {workspaces.error && (
                <ErrorState error={workspaces.error} retry={() => void workspaces.refetch()} />
            )}
            {workspaces.isSuccess && !items.length && (
                <p>请先创建或加入空间 / Create or join a Workspace first.</p>
            )}
            {workspaces.hasNextPage && (
                <Button onClick={() => void workspaces.fetchNextPage()}>
                    更多空间 / More Workspaces
                </Button>
            )}
            {workspace && (
                <CloudWorkspace
                    key={user.id + workspace.id}
                    workspace={workspace}
                    initialKind={initialKind}
                    extra={extra}
                />
            )}
        </Panel>
    );
}
function CloudWorkspace({
    workspace,
    initialKind,
    extra,
}: {
    workspace: Workspace;
    initialKind?: ResourceKind;
    extra?: (workspace: Workspace) => React.ReactNode;
}) {
    const adapter = useMemo(() => new CloudResourceAdapter(workspace.id), [workspace.id]),
        { signal } = useWorkspace();
    return (
        <>
            <ResourceWorkspaceView
                workspace={workspace}
                adapter={adapter}
                signal={signal}
                initialKind={initialKind}
            />
            {extra?.(workspace)}
        </>
    );
}
/**
 * 拥有资源表、创建表单与当前编辑目标；表格 data 引用保持稳定以免 TanStack 重置环。创建成功后选中新资源；创建成功后立刻把表格选中项切到新资源。
 * 选中后打开 ResourceEditorView；错误态用 ErrorState+retry。
 */
export function ResourceWorkspaceView({
    workspace,
    adapter,
    signal: parent,
    initialKind,
}: {
    workspace: Workspace;
    adapter: ResourceAdapter;
    signal?: AbortSignal;
    initialKind?: ResourceKind;
}) {
    const signal = useLifetime(parent),
        client = useQueryClient(),
        { t } = useTranslation(undefined, useEditorTranslationOptions);
    const [kind, setKind] = useState<ResourceKind | "">(initialKind ?? ""),
        [createKind, setCreateKind] = useState<ResourceKind>(initialKind ?? "CASE"),
        [key, setKey] = useState(""),
        [name, setName] = useState(""),
        [selected, setSelected] = useState<Resource | null>(null),
        [error, setError] = useState<Error | null>(null),
        [busy, setBusy] = useState(false);
    const resources = useInfiniteQuery({
        queryKey: ["workspace", workspace.id, "resources", kind],
        queryFn: ({ pageParam, signal: querySignal }) =>
            adapter.list(kind || undefined, pageParam, AbortSignal.any([signal, querySignal])),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (p) => p.nextCursor ?? undefined,
    });
    // TanStack Table resets row state when data identity changes. Keep it stable
    // across create-form edits so a populated table cannot schedule a render loop.
    const items = useMemo(
        () => resources.data?.pages.flatMap((p) => p.items) ?? [],
        [resources.data],
    );
    const refresh = () => client.invalidateQueries({ queryKey: ["workspace", workspace.id] });
    const columns = useMemo<ColumnDef<Resource>[]>(
        () => [
            {
                header: "Key",
                accessorKey: "key",
                cell: (info) => (
                    <Button
                        tone="secondary"
                        data-testid={`resource-open-${info.row.original.key}`}
                        onClick={() => setSelected(info.row.original)}
                    >
                        {String(info.getValue())}
                    </Button>
                ),
            },
            { header: "名称 / Name", accessorKey: "name" },
            { header: "Kind", accessorKey: "kind" },
            { header: "状态 / Status", accessorKey: "status" },
        ],
        [],
    );
    const table = useReactTable({
        data: items,
        columns,
        getCoreRowModel: getCoreRowModel(),
    });
    return (
        <div className="vq-resources">
            <Section title="资源列表 / Resource library">
                <label>
                    筛选类型 / Filter kind
                    <select
                        data-testid="resource-filter"
                        value={kind}
                        onChange={(e) => setKind(e.target.value as ResourceKind | "")}
                    >
                        <option value="">全部 / All</option>
                        {resourceKinds.map((k) => (
                            <option key={k}>{k}</option>
                        ))}
                    </select>
                </label>
                {resources.isPending && <p role="status">{t("loading")}</p>}
                {resources.error && (
                    <ErrorState error={resources.error} retry={() => void resources.refetch()} />
                )}
                {resources.isSuccess && !items.length && (
                    <p data-testid="resource-empty">{t("empty")}</p>
                )}
                {!!items.length && (
                    <div className="table-scroll">
                        <table data-testid="resource-table">
                            <thead>
                                {table.getHeaderGroups().map((group) => (
                                    <tr key={group.id}>
                                        {group.headers.map((h) => (
                                            <th key={h.id}>
                                                {flexRender(
                                                    h.column.columnDef.header,
                                                    h.getContext(),
                                                )}
                                            </th>
                                        ))}
                                    </tr>
                                ))}
                            </thead>
                            <tbody>
                                {table.getRowModel().rows.map((row) => (
                                    <tr key={row.id}>
                                        {row.getVisibleCells().map((cell) => (
                                            <td key={cell.id}>
                                                {flexRender(
                                                    cell.column.columnDef.cell,
                                                    cell.getContext(),
                                                )}
                                            </td>
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
                {resources.hasNextPage && (
                    <Button
                        disabled={resources.isFetchingNextPage}
                        onClick={() => void resources.fetchNextPage()}
                    >
                        更多资源 / More resources
                    </Button>
                )}
            </Section>
            {!adapter.readOnly && (
                <Section title={t("create")}>
                    <form
                        className="vq-create"
                        onSubmit={(e) => {
                            e.preventDefault();
                            setBusy(true);
                            setError(null);
                            void adapter
                                .create(
                                    {
                                        kind: createKind,
                                        key,
                                        name,
                                        content: newDocument(createKind, key, name),
                                    },
                                    signal,
                                )
                                .then(async (resource) => {
                                    signal.throwIfAborted();
                                    setSelected(resource);
                                    setKey("");
                                    setName("");
                                    await refresh();
                                })
                                .catch((e) => {
                                    if (!signal.aborted) setError(e);
                                })
                                .finally(() => {
                                    if (!signal.aborted) setBusy(false);
                                });
                        }}
                    >
                        <label>
                            类型 / Kind
                            <select
                                data-testid="resource-kind"
                                value={createKind}
                                onChange={(e) => setCreateKind(e.target.value as ResourceKind)}
                            >
                                {resourceKinds.map((k) => (
                                    <option key={k}>{k}</option>
                                ))}
                            </select>
                        </label>
                        <label>
                            Key
                            <input
                                data-testid="resource-key"
                                required
                                pattern="[A-Za-z_][A-Za-z0-9_-]*"
                                value={key}
                                onChange={(e) => setKey(e.target.value)}
                            />
                        </label>
                        <label>
                            名称 / Name
                            <input
                                data-testid="resource-name"
                                required
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                            />
                        </label>
                        <Button
                            type="submit"
                            data-testid="resource-create"
                            disabled={busy || !editableRole(workspace, createKind)}
                        >
                            {t("create")}
                        </Button>
                    </form>
                    {error && <ErrorState error={error} />}
                </Section>
            )}
            {selected && (
                <DraftLoader
                    key={selected.id}
                    resource={selected}
                    adapter={adapter}
                    workspace={workspace}
                    signal={signal}
                    refresh={refresh}
                    onResource={setSelected}
                />
            )}
        </div>
    );
}
function DraftLoader(props: {
    resource: Resource;
    adapter: ResourceAdapter;
    workspace: Workspace;
    signal: AbortSignal;
    refresh: () => Promise<unknown>;
    onResource: (r: Resource) => void;
}) {
    const signal = useLifetime(props.signal),
        draft = useQuery({
            queryKey: ["workspace", props.workspace.id, "draft", props.resource.id],
            queryFn: ({ signal: querySignal }) =>
                props.adapter.draft(props.resource.id, AbortSignal.any([signal, querySignal])),
        });
    if (draft.isPending) return <p role="status">正在加载草稿 / Loading draft…</p>;
    if (draft.error) return <ErrorState error={draft.error} retry={() => void draft.refetch()} />;
    return <ResourceEditorView {...props} signal={signal} initial={draft.data} />;
}
/**
 * 单资源编辑器：草稿 RHF、JSON/表单切换、校验/发布、版本差异与生成源码只读查看。脏草稿阻断校验与发布按钮；存在未保存脏草稿时禁用校验与发布按钮。
 * 依赖 ResourceAdapter；AI 页也可嵌入此视图作为只读或可写宿主。
 */
export function ResourceEditorView({
    resource,
    adapter,
    workspace,
    signal: parent,
    initial,
    refresh,
    onResource,
}: {
    resource: Resource;
    adapter: ResourceAdapter;
    workspace: Workspace;
    signal?: AbortSignal;
    initial: Draft;
    refresh: () => Promise<unknown>;
    onResource: (r: Resource) => void;
}) {
    const signal = useLifetime(parent),
        { t } = useTranslation(undefined, useEditorTranslationOptions);
    const form = useForm<EditorValues>({
        defaultValues: { content: clean(initial.content) },
        shouldUnregister: false,
    });
    const watched = useWatch({ control: form.control, name: "content" }),
        content = clean(watched) as ResourceDocumentV1,
        serialized = pretty(content);
    const [saved, setSaved] = useState(initial),
        [mode, setMode] = useState<"form" | "json">("form"),
        [buffer, setBuffer] = useState(pretty(initial.content)),
        [jsonBaseline, setJsonBaseline] = useState(pretty(initial.content)),
        [error, setError] = useState<Error | null>(null),
        [status, setStatus] = useState(""),
        [busy, setBusy] = useState(false),
        [conflict, setConflict] = useState<Draft | null>(null),
        [validation, setValidation] = useState<ValidationCandidate | null>(null),
        [receipt, setReceipt] = useState<Receipt | null>(null),
        [published, setPublished] = useState<Version | null>(null),
        [rename, setRename] = useState(resource.name);
    const validationGeneration = useRef(0),
        receiptRequest = useRef<AbortController | null>(null);
    const invalidateValidation = () => {
        const generation = ++validationGeneration.current;
        receiptRequest.current?.abort();
        receiptRequest.current = null;
        setValidation(null);
        setReceipt(null);
        setStatus("");
        return generation;
    };
    const jsonDirty = buffer !== jsonBaseline,
        dirty = serialized !== pretty(saved.content),
        writable =
            !adapter.readOnly &&
            resource.status !== "ARCHIVED" &&
            editableRole(workspace, resource.kind);
    const jobId = validation?.jobId ?? "";
    const candidateIsCurrent =
        !!validation &&
        validation.generation === validationGeneration.current &&
        validation.workspaceId === workspace.id &&
        validation.resourceId === resource.id &&
        validation.revision === saved.revision &&
        validation.documentHash === saved.documentHash &&
        !dirty &&
        !jsonDirty;
    const currentReceipt =
        receipt && validation && candidateIsCurrent && receiptMatchesCandidate(receipt, validation)
            ? receipt
            : null;
    const issues = validateSchema(schemas[resource.kind], content.document);
    const allVersions = useQuery({
        queryKey: ["workspace", workspace.id, "reference-versions"],
        queryFn: async ({ signal: querySignal }) => {
            const scope = AbortSignal.any([signal, querySignal]);
            const options: VersionOption[] = [];
            let cursor: string | undefined;
            do {
                const page = await adapter.list(undefined, cursor, scope);
                for (const r of page.items) {
                    let versionCursor: string | undefined;
                    do {
                        const versions = await adapter.versions(r.id, versionCursor, scope);
                        options.push(
                            ...versions.items.map((v) => ({
                                id: v.id,
                                name: r.name,
                                kind: r.kind,
                                versionNo: v.versionNo,
                                content: v.content as ResourceDocumentV1,
                            })),
                        );
                        versionCursor = versions.nextCursor ?? undefined;
                    } while (versionCursor);
                }
                cursor = page.nextCursor ?? undefined;
            } while (cursor);
            return options;
        },
    });
    const job = useQuery({
        queryKey: ["workspace", workspace.id, "validation-job", jobId],
        queryFn: ({ signal: querySignal }) =>
            adapter.job(jobId, AbortSignal.any([signal, querySignal])),
        enabled: !!jobId,
        refetchInterval: (query) => (query.state.data?.state === "FINISHED" ? false : 1000),
    });
    useEffect(() => {
        if (
            !validation ||
            !candidateIsCurrent ||
            job.data?.id !== validation.jobId ||
            job.data?.state !== "FINISHED" ||
            job.data.outcome !== "PASSED"
        )
            return;
        const controller = new AbortController(),
            receiptSignal = AbortSignal.any([signal, controller.signal]);
        const generation = validation.generation;
        let active = true;
        receiptRequest.current = controller;
        void adapter
            .receipt(validation.jobId, receiptSignal)
            .then((r) => {
                if (!active || receiptSignal.aborted || validationGeneration.current !== generation)
                    return;
                if (!receiptMatchesCandidate(r, validation))
                    throw new Error("VALIDATION_RECEIPT_MISMATCH");
                setReceipt(r);
                setStatus(t("success"));
            })
            .catch((e) => {
                if (active && !receiptSignal.aborted && validationGeneration.current === generation)
                    setError(e);
            });
        return () => {
            active = false;
            controller.abort();
            if (receiptRequest.current === controller) receiptRequest.current = null;
        };
    }, [
        job.data?.id,
        job.data?.state,
        job.data?.outcome,
        validation,
        candidateIsCurrent,
        signal,
        adapter,
        t,
    ]);
    const run = (action: () => Promise<void>) => {
        setBusy(true);
        setError(null);
        setStatus("");
        void action()
            .catch(async (e) => {
                if (signal.aborted) return;
                setError(e);
                if (e instanceof ApiError && e.status === 409 && e.code === "STALE_REVISION") {
                    try {
                        const remote = await adapter.draft(resource.id, signal);
                        if (!signal.aborted) setConflict(remote);
                    } catch (readError) {
                        if (!signal.aborted) setError(readError as Error);
                    }
                }
            })
            .finally(() => {
                if (!signal.aborted) setBusy(false);
            });
    };
    const guard = (requireSaved = false) => {
        if (jsonDirty) throw new Error(t("pendingJson"));
        if (issues.length) throw new Error(t("invalid"));
        if (requireSaved && dirty) throw new Error(t("dirty"));
    };
    const discardBuffer = () => {
        setBuffer(serialized);
        setJsonBaseline(serialized);
    };
    const restore = (remote: Draft) => {
        invalidateValidation();
        form.reset({ content: clean(remote.content) });
        setSaved(remote);
        setBuffer(pretty(remote.content));
        setJsonBaseline(pretty(remote.content));
        setConflict(null);
    };
    return (
        <article data-testid="resource-editor">
            <div className="vq-actions">
                <h2>
                    {resource.name} · {resource.kind}
                </h2>
                <span>
                    revision {saved.revision} · {workspace.role}
                </span>
            </div>
            {!writable && <p>{t("readonly")}</p>}
            {status && (
                <p role="status" data-testid="resource-status">
                    {status}
                </p>
            )}
            {error && <ErrorState error={error} />}
            {allVersions.error && (
                <ErrorState error={allVersions.error} retry={() => void allVersions.refetch()} />
            )}
            {jsonDirty && (
                <p role="alert" data-testid="resource-json-pending">
                    {t("pendingJson")}
                </p>
            )}
            {issues.length > 0 && (
                <ul role="alert" data-testid="case.validation-errors">
                    {issues.map((issue, index) => (
                        <li key={index}>
                            {issue.path || "/"} · {issue.code}: {issue.message}
                        </li>
                    ))}
                </ul>
            )}
            {conflict && (
                <Section title={t("conflict")} testId="resource-conflict">
                    <MonacoDiff original={pretty(conflict.content)} modified={serialized} />
                    <ConfirmDialog
                        title={t("reload")}
                        trigger={t("reload")}
                        onConfirm={() => restore(conflict)}
                    >
                        <p>远端内容将替换本地草稿 / Replace local content with the remote draft.</p>
                    </ConfirmDialog>
                    <Button
                        data-testid="resource-rebase"
                        onClick={() => {
                            invalidateValidation();
                            setSaved(conflict);
                            setConflict(null);
                        }}
                    >
                        {t("keep")}
                    </Button>
                </Section>
            )}
            <div className="vq-actions">
                <Button
                    tone="secondary"
                    data-testid="resource-form-tab"
                    onClick={() => setMode("form")}
                >
                    {t("form")}
                </Button>
                <Button
                    tone="secondary"
                    data-testid="resource-json-tab"
                    onClick={() => {
                        if (!jsonDirty) discardBuffer();
                        setMode("json");
                    }}
                >
                    {t("json")}
                </Button>
            </div>
            <FormProvider {...form}>
                <fieldset className="vq-editor-fields" disabled={!writable || busy}>
                    {mode === "form" ? (
                        <ResourceForms kind={resource.kind} versions={allVersions.data ?? []} />
                    ) : (
                        <>
                            <Monaco
                                value={buffer}
                                onChange={setBuffer}
                                readOnly={!writable}
                                label="JSON source"
                                testId="resource-json"
                            />
                            <div className="vq-actions">
                                <Button
                                    data-testid="resource-json-apply"
                                    onClick={() => {
                                        try {
                                            const next: unknown = JSON.parse(buffer);
                                            const problems = validateSchema(
                                                "ResourceDocumentV1",
                                                next,
                                            );
                                            if (problems.length)
                                                throw new Error(
                                                    problems
                                                        .map((p) => `${p.path}: ${p.message}`)
                                                        .join("\n"),
                                                );
                                            if ((next as ResourceDocumentV1).kind !== resource.kind)
                                                throw new Error("RESOURCE_KIND_IMMUTABLE");
                                            invalidateValidation();
                                            form.reset({ content: next as ResourceDocumentV1 });
                                            setJsonBaseline(buffer);
                                            setError(null);
                                        } catch (e) {
                                            setError(e as Error);
                                        }
                                    }}
                                >
                                    {t("apply")}
                                </Button>
                                <Button tone="secondary" onClick={discardBuffer}>
                                    {t("discard")}
                                </Button>
                            </div>
                        </>
                    )}
                </fieldset>
            </FormProvider>
            <div className="vq-actions">
                <Button
                    data-testid="resource-save"
                    disabled={!writable || busy}
                    onClick={() =>
                        run(async () => {
                            guard();
                            invalidateValidation();
                            const draft = await adapter.save(
                                resource.id,
                                { revision: saved.revision, content },
                                signal,
                            );
                            signal.throwIfAborted();
                            setSaved(draft);
                            setStatus(t("saved"));
                            await refresh();
                        })
                    }
                >
                    {t("save")}
                </Button>
                <Button
                    data-testid="case.validate"
                    disabled={!writable || busy}
                    onClick={() =>
                        run(async () => {
                            guard(true);
                            const generation = invalidateValidation();
                            const preview = await adapter.preview(resource.id, signal);
                            signal.throwIfAborted();
                            if (
                                preview.revision !== saved.revision ||
                                preview.documentHash !== saved.documentHash
                            )
                                throw new ApiError(
                                    "STALE_REVISION",
                                    "Draft changed before validation",
                                    409,
                                    "",
                                );
                            const queued = await adapter.validate(
                                resource.id,
                                { revision: saved.revision, sourceHash: preview.sourceHash },
                                signal,
                            );
                            signal.throwIfAborted();
                            if (validationGeneration.current !== generation) return;
                            setValidation({
                                workspaceId: workspace.id,
                                resourceId: resource.id,
                                jobId: queued.id,
                                revision: preview.revision,
                                documentHash: preview.documentHash,
                                sourceHash: preview.sourceHash,
                                engineVersion: preview.engineVersion,
                                generation,
                            });
                            setStatus(t("queued"));
                        })
                    }
                >
                    {t("validate")}
                </Button>
                <Button
                    data-testid="case.publish"
                    disabled={
                        !writable ||
                        busy ||
                        !["OWNER", "ADMIN"].includes(workspace.role) ||
                        !currentReceipt
                    }
                    onClick={() =>
                        run(async () => {
                            guard(true);
                            if (!currentReceipt) throw new Error("VALIDATION_NOT_COMPLETED");
                            const version = await adapter.publish(
                                resource.id,
                                {
                                    revision: saved.revision,
                                    validationReceiptId: currentReceipt.id,
                                },
                                signal,
                            );
                            signal.throwIfAborted();
                            setPublished(version);
                            setStatus(t("publish"));
                            await refresh();
                            onResource({
                                ...resource,
                                status: "PUBLISHED",
                                latestVersionId: version.id,
                            });
                        })
                    }
                >
                    {t("publish")}
                </Button>
            </div>
            {job.data && <ValidationState job={job.data} receipt={currentReceipt} />}
            {job.error && <ErrorState error={job.error} retry={() => void job.refetch()} />}
            {published && (
                <p role="status" data-testid="case.published-version">
                    v{published.versionNo} · {published.id} · {published.sha256}
                </p>
            )}
            <Section title="资源设置 / Resource settings">
                <label>
                    名称 / Name
                    <input
                        value={rename}
                        disabled={!writable}
                        onChange={(e) => setRename(e.target.value)}
                    />
                </label>
                <Button
                    disabled={!writable || busy || !rename.trim()}
                    onClick={() =>
                        run(async () => {
                            const next = await adapter.update(
                                resource.id,
                                { name: rename },
                                signal,
                            );
                            signal.throwIfAborted();
                            onResource(next);
                            await refresh();
                        })
                    }
                >
                    更新名称 / Rename
                </Button>
                {!adapter.readOnly && editableRole(workspace, resource.kind) && (
                    <ConfirmDialog
                        title={resource.status === "ARCHIVED" ? t("restore") : t("archive")}
                        trigger={resource.status === "ARCHIVED" ? t("restore") : t("archive")}
                        onConfirm={() =>
                            run(async () => {
                                const next = await adapter.update(
                                    resource.id,
                                    {
                                        name: resource.name,
                                        archived: resource.status !== "ARCHIVED",
                                    },
                                    signal,
                                );
                                signal.throwIfAborted();
                                onResource(next);
                                await refresh();
                            })
                        }
                    >
                        <p>版本及 key 会保留 / Immutable versions and keys are retained.</p>
                    </ConfirmDialog>
                )}
            </Section>
            <VersionHistory
                key={published?.id ?? "versions"}
                resource={resource}
                adapter={adapter}
                workspaceId={workspace.id}
                signal={signal}
                content={content}
            />
            <Impact
                resource={resource}
                adapter={adapter}
                workspaceId={workspace.id}
                signal={signal}
            />
        </article>
    );
}
function ValidationState({ job, receipt }: { job: Job; receipt: Receipt | null }) {
    return (
        <section data-testid="case.validation-state">
            <p>
                {job.state} · {job.outcome ?? ""} · {job.waitReason ?? ""} · {job.errorCode ?? ""}
            </p>
            {job.diagnostics?.length ? (
                <ul aria-label="Compiler diagnostics">
                    {job.diagnostics.map((issue, index) => (
                        <li key={index}>
                            <code>{issue.code}</code>{" "}
                            {issue.pathStatus === "EXACT" ? (
                                <code>{issue.path || "/"}</code>
                            ) : (
                                "Source path withheld"
                            )}
                            : {issue.message}
                        </li>
                    ))}
                </ul>
            ) : null}
            {job.state !== "FINISHED" && (
                <p>需要在线受管理的 Runtime / Requires an available managed Runtime.</p>
            )}
            {job.state === "FINISHED" && !receipt && (
                <p>尚无成功校验回执 / No successful validation receipt.</p>
            )}
            {receipt && (
                <p data-testid="case.validation-receipt">
                    {receipt.id} · {receipt.engineVersion} · {receipt.sourceHash}
                </p>
            )}
        </section>
    );
}
function VersionHistory({
    resource,
    adapter,
    workspaceId,
    signal,
    content,
}: {
    resource: Resource;
    adapter: ResourceAdapter;
    workspaceId: string;
    signal: AbortSignal;
    content: ResourceDocumentV1;
}) {
    const { t } = useTranslation(undefined, useEditorTranslationOptions),
        [versionId, setVersionId] = useState(resource.latestVersionId ?? ""),
        [other, setOther] = useState("draft"),
        [path, setPath] = useState("");
    useEffect(() => {
        if (!versionId && resource.latestVersionId) setVersionId(resource.latestVersionId);
    }, [resource.latestVersionId, versionId]);
    const versions = useInfiniteQuery({
        queryKey: ["workspace", workspaceId, "versions", resource.id],
        queryFn: ({ pageParam, signal: qs }) =>
            adapter.versions(resource.id, pageParam, AbortSignal.any([signal, qs])),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (p) => p.nextCursor ?? undefined,
    });
    const items = versions.data?.pages.flatMap((p) => p.items) ?? [],
        selected = items.find((v) => v.id === versionId),
        compared = other === "draft" ? content : items.find((v) => v.id === other)?.content;
    const files = useQuery({
        queryKey: ["workspace", workspaceId, "compiled-files", resource.id, versionId],
        queryFn: ({ signal: qs }) =>
            adapter.sourceFiles(resource.id, versionId, AbortSignal.any([signal, qs])),
        enabled: !!selected,
    });
    const file = files.data?.files.find((f) => f.path === path);
    const source = useQuery({
        queryKey: ["workspace", workspaceId, "compiled-source", versionId, path],
        queryFn: ({ signal: qs }) =>
            adapter.source(resource.id, versionId, file!, AbortSignal.any([signal, qs])),
        enabled: !!file,
    });
    return (
        <>
            <Section title={t("versions")}>
                {versions.isPending && <p role="status">{t("loading")}</p>}
                {versions.error && (
                    <ErrorState error={versions.error} retry={() => void versions.refetch()} />
                )}
                {!items.length && versions.isSuccess && (
                    <p>尚无发布版本 / No published versions.</p>
                )}
                {!!items.length && (
                    <>
                        <label>
                            基础版本 / Base version
                            <select
                                data-testid="resource-version"
                                value={versionId}
                                onChange={(e) => {
                                    setVersionId(e.target.value);
                                    setPath("");
                                }}
                            >
                                <option value="">选择 / Select</option>
                                {items.map((v) => (
                                    <option value={v.id} key={v.id}>
                                        v{v.versionNo} · {v.sha256}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <label>
                            比较版本 / Compare with
                            <select
                                data-testid="resource-compare"
                                value={other}
                                onChange={(e) => setOther(e.target.value)}
                            >
                                <option value="draft">当前草稿 / Current draft</option>
                                {items.map((v) => (
                                    <option value={v.id} key={v.id}>
                                        v{v.versionNo}
                                    </option>
                                ))}
                            </select>
                        </label>
                        {selected && compared && (
                            <MonacoDiff
                                original={pretty(selected.content)}
                                modified={pretty(compared)}
                            />
                        )}
                    </>
                )}
                {versions.hasNextPage && (
                    <Button onClick={() => void versions.fetchNextPage()}>
                        更多版本 / More versions
                    </Button>
                )}
            </Section>
            <Section title={t("source")}>
                {!selected && <p>{t("noSource")}</p>}
                {files.isFetching && <p role="status">{t("loading")}</p>}
                {files.error && (
                    <ErrorState error={files.error} retry={() => void files.refetch()} />
                )}
                {files.data && (
                    <>
                        <p>descriptor SHA-256: {files.data.descriptorSha256}</p>
                        <label>
                            保留文件 / Retained file
                            <select
                                data-testid="case.generated-file"
                                value={path}
                                onChange={(e) => setPath(e.target.value)}
                            >
                                <option value="">选择 / Select</option>
                                {files.data.files.map((f) => (
                                    <option key={f.path} value={f.path}>
                                        {f.path} · {f.sha256}
                                    </option>
                                ))}
                            </select>
                        </label>
                    </>
                )}
                {source.isFetching && <p role="status">{t("loading")}</p>}
                {source.error && (
                    <ErrorState error={source.error} retry={() => void source.refetch()} />
                )}
                {source.data !== undefined && file && (
                    <>
                        <p>
                            {file.sizeBytes} bytes · SHA-256: {file.sha256}
                        </p>
                        <Monaco
                            value={source.data}
                            language="typescript"
                            readOnly
                            label="Generated TypeScript read only"
                            testId="case.generated-source"
                        />
                    </>
                )}
            </Section>
        </>
    );
}
function Impact({
    resource,
    adapter,
    workspaceId,
    signal,
}: {
    resource: Resource;
    adapter: ResourceAdapter;
    workspaceId: string;
    signal: AbortSignal;
}) {
    const dependents = useInfiniteQuery({
        queryKey: ["workspace", workspaceId, "dependents", resource.id],
        queryFn: ({ pageParam, signal: qs }) =>
            adapter.dependents(resource.id, pageParam, AbortSignal.any([signal, qs])),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (p) => p.nextCursor ?? undefined,
    });
    const items = dependents.data?.pages.flatMap((p) => p.items) ?? [];
    return (
        <Section title="引用影响 / Reference impact" testId="resource-impact">
            {dependents.isPending && <p role="status">正在加载 / Loading…</p>}
            {dependents.error && (
                <ErrorState error={dependents.error} retry={() => void dependents.refetch()} />
            )}
            {dependents.isSuccess && !items.length && (
                <p>没有已发布资源引用此资源 / No published dependents.</p>
            )}
            <ul>
                {items.map((r) => (
                    <li key={r.id}>
                        {r.kind} · {r.key} · {r.name}
                    </li>
                ))}
            </ul>
            {dependents.hasNextPage && (
                <Button onClick={() => void dependents.fetchNextPage()}>
                    更多引用 / More dependents
                </Button>
            )}
        </Section>
    );
}
/**
 * 资源查询失败时的告警与可选 retry 按钮，避免空白页吞掉 ApiError 信息。无 retry 时仅展示错误文本。
 * retry 由调用方绑定 refetch；本组件不直接触碰 adapter。
 */
export function ErrorState({ error, retry }: { error: Error; retry?: () => void }) {
    return (
        <div role="alert" data-testid="resource-error">
            {error instanceof ApiError
                ? `${error.code} · ${error.message} · Request ${error.requestId}`
                : error.message}
            {retry && (
                <Button tone="secondary" onClick={retry}>
                    重试 / Retry
                </Button>
            )}
        </div>
    );
}
