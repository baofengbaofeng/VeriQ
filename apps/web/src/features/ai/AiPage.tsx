import { useContext, useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { PlatformComponents } from "@veriq/contracts";
import { api, type Workspace } from "../../api";
import { Auth } from "../../auth-context";
import { Panel } from "../../ui";
import { useWorkspace } from "../workspaces/WorkspaceContext";
import { ResourceEditorView } from "../resources/ResourcePage";
import {
  CloudResourceAdapter,
  type ResourceAdapter,
} from "../resources/adapters";
import {
  CloudAiAdapter,
  type AiAdapter,
  type Generation,
  type GenerationRequest,
  type Provider,
} from "./adapters";
import { aiI18n } from "./i18n";
import "./ai.css";
type S = PlatformComponents["schemas"];
const useLabels = () => useTranslation("ai", { i18n: aiI18n }).t;
const json = (v: unknown) => JSON.stringify(v, null, 2);
const defaults: S["ProviderWrite"] = {
  name: "",
  adapter: "OPENAI_COMPATIBLE",
  baseURL: "https://api.openai.com/v1",
  model: "",
  enabled: false,
  monthlyBudgetUsd: 1,
  inputUsdPerMillion: 1,
  outputUsdPerMillion: 2,
  maxOutputTokens: 1024,
  maxRequestUsd: 0.5,
};
export function AiPage() {
  const t = useLabels(),
    { user } = useContext(Auth),
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
  const adapter = useMemo(() => new CloudAiAdapter(selected), [selected]);
  const resources = useMemo(
    () => new CloudResourceAdapter(selected),
    [selected],
  );
  if (!user) return <Navigate to="/login" />;
  const ws = items.find((w) => w.id === selected);
  return (
    <Panel title={t("title")}>
      <label>
        语言 / Language
        <select
          value={aiI18n.language}
          onChange={(e) => void aiI18n.changeLanguage(e.target.value)}
        >
          <option value="zh">中文</option>
          <option value="en">English</option>
        </select>
      </label>
      <label>
        Workspace
        <select
          data-testid="ai-workspace"
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
          {t("more")}
        </button>
      )}
      {!items.length && <p>{t("noWorkspace")}</p>}
      {ws && (
        <AiWorkspaceView
          key={user.id + selected}
          workspace={ws}
          adapter={adapter}
          resources={resources}
          signal={signal}
        />
      )}
    </Panel>
  );
}
export function AiWorkspaceView({
  workspace,
  adapter,
  resources,
  signal: parent,
}: {
  workspace: Workspace;
  adapter: AiAdapter;
  resources: ResourceAdapter;
  signal?: AbortSignal;
}) {
  const t = useLabels();
  const [controller] = useState(() => new AbortController());
  const signal = useMemo(
    () =>
      parent ? AbortSignal.any([parent, controller.signal]) : controller.signal,
    [parent, controller],
  );
  useEffect(() => () => controller.abort(), [controller]);
  const manage =
    ["OWNER", "ADMIN"].includes(workspace.role) && !workspace.archived;
  const edit =
    ["OWNER", "ADMIN", "EDITOR"].includes(workspace.role) &&
    !workspace.archived;
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [generating, setGenerating] = useState(false);
  const [providerId, setProviderId] = useState(""),
    [form, setForm] = useState<S["ProviderWrite"]>(defaults),
    [editing, setEditing] = useState(""),
    [apiKey, setKey] = useState("");
  const [purpose, setPurpose] =
      useState<GenerationRequest["purpose"]>("CASE_DRAFT"),
    [prompt, setPrompt] = useState(""),
    [versions, setVersions] = useState(""),
    [openapi, setOpenapi] = useState("{}"),
    [data, setData] = useState("{}"),
    [resourceId, setResourceId] = useState(""),
    [runId, setRunId] = useState("");
  const [preview, setPreview] = useState<S["AiContextDTO"]>(),
    [reviewedRequest, setReviewedRequest] = useState<GenerationRequest>(),
    [generation, setGeneration] = useState<Generation>(),
    [key, setResourceKey] = useState(""),
    [name, setName] = useState(""),
    [editorId, setEditorId] = useState("");
  const providers = useInfiniteQuery({
    queryKey: ["workspace", workspace.id, "ai", "providers"],
    queryFn: ({ pageParam }) => adapter.providers(pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  const history = useInfiniteQuery({
    queryKey: ["workspace", workspace.id, "ai", "history"],
    queryFn: ({ pageParam }) => adapter.history(pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  const sources = useInfiniteQuery({
    queryKey: ["workspace", workspace.id, "ai", "sources"],
    queryFn: ({ pageParam }) => resources.list(undefined, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  const rows = providers.data?.pages.flatMap((p) => p.items) ?? [],
    calls = history.data?.pages.flatMap((p) => p.items) ?? [];
  const provider = rows.find((p) => p.id === providerId);
  useEffect(() => {
    if (!providerId && rows.length) setProviderId(rows[0]!.id);
  }, [providerId, rows[0]?.id]);
  useEffect(() => {
    setPreview(undefined);
    setReviewedRequest(undefined);
  }, [providerId, purpose, prompt, versions, openapi, data, resourceId, runId]);
  const refresh = async () => {
    await Promise.all([providers.refetch(), history.refetch()]);
  };
  const action = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      if (!signal.aborted)
        setError(e instanceof Error ? e.message : t("failed"));
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  };
  const selectProvider = (p: Provider) => {
    setEditing(p.id);
    setProviderId(p.id);
    setForm({
      name: p.name,
      adapter: p.adapter,
      baseURL: p.baseURL,
      model: p.model,
      enabled: p.enabled,
      monthlyBudgetUsd: p.monthlyBudgetUsd,
      inputUsdPerMillion: p.inputUsdPerMillion,
      outputUsdPerMillion: p.outputUsdPerMillion,
      maxOutputTokens: p.maxOutputTokens,
      maxRequestUsd: p.maxRequestUsd,
    });
    setKey("");
  };
  const makeRequest = (): GenerationRequest => ({
    requestId: crypto.randomUUID(),
    providerId,
    purpose,
    prompt,
    versionIds: versions
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    openapi: JSON.parse(openapi),
    data: JSON.parse(data),
    ...(resourceId ? { resourceId } : {}),
    ...(runId ? { runId } : {}),
  });
  const editor = useQuery({
    queryKey: ["workspace", workspace.id, "ai", "editor", editorId],
    queryFn: async () => ({
      resource: await adapter.resource(editorId, signal),
      draft: await resources.draft(editorId, signal),
    }),
    enabled: !!editorId,
  });
  return (
    <div className="vq-ai">
      <p data-testid="ai-execution-independent">{t("independent")}</p>
      <p>{t("privacy")}</p>
      <p>{t("estimate")}</p>
      {!edit && <p>{t("readonly")}</p>}
      {(error || providers.error || history.error || sources.error) && (
        <p role="alert">
          {error ||
            providers.error?.message ||
            history.error?.message ||
            sources.error?.message}
        </p>
      )}
      {(busy || providers.isPending) && <p role="status">{t("loading")}</p>}
      {!providers.isPending && !rows.length && (
        <p data-testid="ai-empty">{t("empty")}</p>
      )}
      <label>
        {t("provider")}
        <select
          data-testid="ai-provider"
          value={providerId}
          onChange={(e) => setProviderId(e.target.value)}
        >
          <option value="">—</option>
          {rows.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {p.enabled ? "ON" : "OFF"}
            </option>
          ))}
        </select>
      </label>
      {providers.hasNextPage && (
        <button onClick={() => void providers.fetchNextPage()}>
          {t("more")}
        </button>
      )}
      {provider && (
        <div data-testid="ai-budget">
          <strong>{t("budget")} USD</strong> {t("used")}:{" "}
          {provider.budget.estimatedUsedUsd} · {t("held")}:{" "}
          {provider.budget.heldUsd} · {t("available")}:{" "}
          {provider.budget.availableUsd}
        </div>
      )}
      {manage && (
        <fieldset disabled={busy}>
          <legend>{t("provider")}</legend>
          <button
            onClick={() => {
              setEditing("");
              setForm(defaults);
              setKey("");
            }}
          >
            {t("newProvider")}
          </button>
          {provider && (
            <button
              data-testid="ai-edit-provider"
              onClick={() => selectProvider(provider)}
            >
              {t("provider")} {provider.name}
            </button>
          )}
          {(["name", "baseURL", "model"] as const).map((k, i) => (
            <label key={k}>
              {t((["name", "endpoint", "model"] as const)[i]!)}
              <input
                data-testid={"ai-" + k}
                value={form[k]}
                onChange={(e) => setForm({ ...form, [k]: e.target.value })}
              />
            </label>
          ))}
          <label>
            Adapter
            <select
              data-testid="ai-adapter"
              value={form.adapter}
              onChange={(e) =>
                setForm({
                  ...form,
                  adapter: e.target.value as S["ProviderWrite"]["adapter"],
                })
              }
            >
              <option>OPENAI_COMPATIBLE</option>
              <option>ANTHROPIC</option>
            </select>
          </label>
          <label>
            {t("key")}
            <input
              type="password"
              autoComplete="new-password"
              data-testid="ai-key"
              value={apiKey}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
          <p>{t("keyHint")}</p>
          {(
            [
              "monthlyBudgetUsd",
              "inputUsdPerMillion",
              "outputUsdPerMillion",
              "maxOutputTokens",
              "maxRequestUsd",
            ] as const
          ).map((k, i) => (
            <label key={k}>
              {t(
                (
                  [
                    "monthly",
                    "inputRate",
                    "outputRate",
                    "outputLimit",
                    "requestLimit",
                  ] as const
                )[i]!,
              )}
              <input
                type="number"
                min="0"
                step="any"
                data-testid={"ai-" + k}
                value={form[k]}
                onChange={(e) =>
                  setForm({ ...form, [k]: Number(e.target.value) })
                }
              />
            </label>
          ))}
          <label>
            <input
              type="checkbox"
              data-testid="ai-enabled"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            {t("enabled")}
          </label>
          <button
            data-testid="ai-save"
            onClick={() =>
              void action(async () => {
                const p = await adapter.save(
                  { ...form, ...(apiKey ? { apiKey } : {}) },
                  editing || undefined,
                  signal,
                );
                if (signal.aborted) return;
                setKey("");
                setEditing(p.id);
                setProviderId(p.id);
                await refresh();
              })
            }
          >
            {t("save")}
          </button>
          {provider && (
            <>
              <button
                data-testid="ai-test"
                disabled={!provider.enabled}
                onClick={() =>
                  void action(async () => {
                    const g = await adapter.test(
                      provider.id,
                      crypto.randomUUID(),
                      signal,
                    );
                    if (signal.aborted) return;
                    setGeneration(g);
                    await refresh();
                  })
                }
              >
                {t("test")}
              </button>
              <button
                data-testid="ai-delete"
                onClick={() =>
                  void action(async () => {
                    await adapter.remove(provider.id, signal);
                    if (signal.aborted) return;
                    setProviderId("");
                    setEditing("");
                    setForm(defaults);
                    await refresh();
                  })
                }
              >
                {t("remove")}
              </button>
            </>
          )}
        </fieldset>
      )}
      <fieldset disabled={!edit || busy || generating}>
        <legend>{t("selected")}</legend>
        <p>{t("privacy")}</p>
        <label>
          {t("purpose")}
          <select
            data-testid="ai-purpose"
            value={purpose}
            onChange={(e) =>
              setPurpose(e.target.value as GenerationRequest["purpose"])
            }
          >
            <option>CASE_DRAFT</option>
            <option>BOUNDARY_SUGGESTION</option>
            <option>FAILURE_ANALYSIS</option>
          </select>
        </label>
        <label>
          {t("requirement")}
          <textarea
            data-testid="ai-prompt"
            maxLength={16000}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>
        {(["versions", "resource", "run"] as const).map((k, i) => (
          <label key={k}>
            {t(k)}
            <input
              data-testid={"ai-" + k}
              value={[versions, resourceId, runId][i]}
              onChange={(e) =>
                [setVersions, setResourceId, setRunId][i]!(e.target.value)
              }
            />
          </label>
        ))}
        <label>
          {t("openapi")}
          <textarea
            data-testid="ai-openapi"
            value={openapi}
            onChange={(e) => setOpenapi(e.target.value)}
          />
        </label>
        <label>
          {t("data")}
          <textarea
            data-testid="ai-data"
            value={data}
            onChange={(e) => setData(e.target.value)}
          />
        </label>
        <details>
          <summary>{t("selected")}</summary>
          {sources.data?.pages
            .flatMap((p) => p.items)
            .filter((r) => !["ENVIRONMENT", "SUITE"].includes(r.kind))
            .map((r) => (
              <p key={r.id}>
                {r.name} · {r.kind}{" "}
                {r.latestVersionId && (
                  <button
                    onClick={() =>
                      setVersions(
                        [
                          ...new Set([
                            ...versions.split(",").filter(Boolean),
                            r.latestVersionId!,
                          ]),
                        ].join(","),
                      )
                    }
                  >
                    {t("use")}
                  </button>
                )}
                {r.kind === "CASE" && (
                  <button onClick={() => setResourceId(r.id)}>
                    {t("target")}
                  </button>
                )}
              </p>
            ))}
          {sources.hasNextPage && (
            <button onClick={() => void sources.fetchNextPage()}>
              {t("more")}
            </button>
          )}
        </details>
        <button
          data-testid="ai-preview"
          disabled={!provider?.enabled || !prompt}
          onClick={() =>
            void action(async () => {
              const req = makeRequest();
              const p = await adapter.preview(req, signal);
              if (signal.aborted) return;
              setPreview(p);
              setReviewedRequest({ ...req, contextHash: p.contextHash });
            })
          }
        >
          {t("preview")}
        </button>
      </fieldset>
      {preview && (
        <section data-testid="ai-context">
          <h3>{t("context")}</h3>
          <pre>{json(preview.context)}</pre>
          <pre>{json(preview.provenance)}</pre>
          <p>
            {preview.inputTokenBound} tokens · USD {preview.reservedUsd}
          </p>
          <button
            data-testid="ai-generate"
            disabled={busy || generating || !edit || !reviewedRequest}
            onClick={() => {
              if (!reviewedRequest) return;
              setGenerating(true);
              setError("");
              void adapter
                .generate(reviewedRequest, signal)
                .then(async (g) => {
                  if (!signal.aborted) {
                    setGeneration(g);
                    setReviewedRequest(undefined);
                    await refresh();
                  }
                })
                .catch((e) => {
                  if (!signal.aborted) setError(e.message);
                })
                .finally(() => {
                  if (!signal.aborted) setGenerating(false);
                });
            }}
          >
            {t("generate")}
          </button>
        </section>
      )}
      {generating && <p role="status">{t("pending")}</p>}
      <section>
        <h3>{t("history")}</h3>
        <button data-testid="ai-refresh" onClick={() => void action(refresh)}>
          {t("refresh")}
        </button>
        {!calls.length && <p>{t("noHistory")}</p>}
        <ul data-testid="ai-history">
          {calls.map((g) => (
            <li key={g.id}>
              <button
                onClick={() =>
                  void action(async () => {
                    const value = await adapter.get(g.id, signal);
                    if (!signal.aborted) setGeneration(value);
                  })
                }
              >
                {g.purpose} · {g.status} · {g.createdAt}
              </button>{" "}
              {g.costState === "UNKNOWN" ? t("unknown") : "USD " + g.costUsd} (
              {g.inputTokens ?? "?"} / {g.outputTokens ?? "?"} tokens){" "}
              {g.status === "RUNNING" && edit && (
                <button
                  data-testid="ai-cancel"
                  onClick={() =>
                    void action(async () => {
                      await adapter.cancel(g.id, signal);
                      await refresh();
                    })
                  }
                >
                  {t("cancel")}
                </button>
              )}
            </li>
          ))}
        </ul>
        {history.hasNextPage && (
          <button onClick={() => void history.fetchNextPage()}>
            {t("more")}
          </button>
        )}
      </section>
      {generation && (
        <section data-testid="ai-review">
          <h3>
            {t("output")} · {generation.status}
          </h3>
          <p>{t("review")}</p>
          {generation.errorCode && <p role="alert">{generation.errorCode}</p>}
          {generation.diagnostics && (
            <pre>
              {t("diagnostics")}: {json(generation.diagnostics)}
            </pre>
          )}
          <div className="vq-ai-diff">
            <div>
              <h4>{t("original")}</h4>
              <pre data-testid="ai-original">
                {json(generation.original ?? null)}
              </pre>
            </div>
            <div>
              <h4>{t("output")}</h4>
              <pre data-testid="ai-output">
                {json(generation.output ?? null)}
              </pre>
            </div>
          </div>
          {generation.status === "SUCCEEDED" && edit && (
            <fieldset disabled={busy}>
              <label>
                {t("keyName")}
                <input
                  data-testid="ai-resource-key"
                  value={key}
                  onChange={(e) => setResourceKey(e.target.value)}
                />
              </label>
              <label>
                {t("resourceName")}
                <input
                  data-testid="ai-resource-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              {generation.purpose === "CASE_DRAFT" && (
                <button
                  data-testid="ai-accept"
                  onClick={() =>
                    void action(async () => {
                      const g = await adapter.review(
                        generation.id,
                        {
                          decision: "ACCEPT_DRAFT",
                          key,
                          name,
                          ...(generation.revision
                            ? { revision: generation.revision }
                            : {}),
                        },
                        signal,
                      );
                      if (signal.aborted) return;
                      setGeneration(g);
                      await refresh();
                    })
                  }
                >
                  {t("apply")}
                </button>
              )}
              <button
                data-testid="ai-reject"
                onClick={() =>
                  void action(async () => {
                    const g = await adapter.review(
                      generation.id,
                      { decision: "REJECT" },
                      signal,
                    );
                    if (signal.aborted) return;
                    setGeneration(g);
                    await refresh();
                  })
                }
              >
                {t("reject")}
              </button>
            </fieldset>
          )}
          {generation.status === "REVIEWED" && generation.resourceId && (
            <button
              data-testid="ai-open-editor"
              onClick={() => setEditorId(generation.resourceId!)}
            >
              {t("edit")}
            </button>
          )}
        </section>
      )}
      {editor.error && <p role="alert">{editor.error.message}</p>}
      {editor.data && (
        <ResourceEditorView
          key={editorId}
          resource={editor.data.resource}
          initial={editor.data.draft}
          adapter={resources}
          workspace={workspace}
          signal={signal}
          refresh={async () => {
            await editor.refetch();
          }}
          onResource={() => void editor.refetch()}
        />
      )}
    </div>
  );
}
