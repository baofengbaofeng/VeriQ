import { useOperationFeedback, validateRecordingCase } from "@veriq/web/desktop";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LocatorV1, PlatformComponents, ResourceDocumentV1 } from "@veriq/contracts";
import type { AnnotationAction, RecordingEvent, RecordingMode, RecordingNotice } from "../../shared/recording";
import { desktopErrorMessage } from "../../shared/desktop-errors";
import { createRecordingServices } from "./services";
import { AnnotationDataPanel, type AnnotationActionEvent } from "./AnnotationDataPanel";
import { bindSelectColumn, optionDataset, tableDataset } from "./annotation-data";
import {
    applyRecordingEvent,
    buildCaseDraft,
    copyRecordingDraft,
    listRecordingDrafts,
    newRecordingDraft,
    parseDraftObject,
    stepPhases,
    storeRecordingDraft,
    type DraftReference,
    type RecordingDraft,
} from "./draft-model";
import { locatorLabel, RecordingStepList } from "./RecordingStepList";
import { datasetColumns, listPublishedVersions, staticRowKeys, type PublishedVersion } from "./workspace-data";

type S = PlatformComponents["schemas"];
type DraftUpdate = (previous: RecordingDraft) => RecordingDraft;
type SelectedTarget = Extract<RecordingEvent, { type: "annotation-target" }>;
const workbenchTabs = {
    settings: ["用例", "Case"],
    tools: ["元素工具", "Element tools"],
    catalog: ["元素目录", "Catalog"],
    steps: ["步骤", "Steps"],
    data: ["数据", "Data"],
    run: ["执行", "Run"],
    resources: ["资源", "Resources"],
} as const;
type WorkbenchTab = keyof typeof workbenchTabs;
const toolLabels: Record<AnnotationAction, readonly [string, string]> = {
    catalog: ["加入元素目录", "Add to catalog"],
    click: ["添加点击步骤", "Add click"],
    fill: ["添加填写步骤", "Add fill"],
    captureOptions: ["采集下拉选项", "Capture options"],
    bindColumn: ["绑定数据列", "Bind data column"],
    extractData: ["采集表格或列表", "Capture table or list"],
};
const targetKinds: Record<SelectedTarget["kind"], readonly [string, string]> = {
    generic: ["页面元素", "Page element"],
    text: ["文本输入框", "Text input"],
    select: ["下拉选择框", "Dropdown"],
    table: ["表格", "Table"],
    list: ["列表", "List"],
};

const notices: Record<RecordingNotice, string> = {
    NAVIGATION_BLOCKED: "导航超出环境批准范围 / Navigation outside approved environment",
    FRAME_BLOCKED: "未录入子页面操作 / Frame action was not recorded",
    POPUP_BLOCKED: "新窗口已阻止 / New window blocked",
    DOWNLOAD_BLOCKED: "下载已阻止 / Download blocked",
    LOAD_FAILED: "页面加载失败 / Page load failed",
    VIEW_CLOSED: "录制浏览器已关闭 / Recording browser closed",
    OPTIONS_UNAVAILABLE:
        "请确认下拉框仍可用，选项最多 200 项，每项文字和值最多 256 字符。 / " +
        "Check that the dropdown is available, with at most 200 options and 256 characters per label or value.",
    DATA_UNAVAILABLE:
        "数据结构已变更或超出采集上限。请重新选择表格或列表。 / " +
        "The data changed or exceeded the capture limit. Select the table or list again.",
};
const modeLabels: Record<RecordingMode, string> = {
    record: "录制 / Record",
    annotate: "标注 / Annotate",
    paused: "暂停 / Pause",
};
const defaultBrowser = "chromium";
const versionLabel = (version: PublishedVersion) => `${version.name} · v${version.versionNo}`;
const refOf = ({ resourceId, revision }: S["DraftDTO"]): DraftReference => ({ resourceId, revision });

function executionVariables(value: string | undefined): S["ExecutionPlanWrite"]["variables"] {
    const parsed = parseDraftObject(value);
    if (!parsed) throw new Error("RECORDING_VARIABLES_REQUIRE_JSON_OBJECT");
    return parsed as S["ExecutionPlanWrite"]["variables"];
}

interface Props {
    workspaceId: string;
    owner: string;
    language: "zh" | "en";
    openReport: (runId: string) => void;
    resourceTools?: ReactNode;
}

export function RecordingWorkspace({ workspaceId, owner, language, openReport, resourceTools }: Props) {
    const bridge = window.veriq;
    const { showPending } = useOperationFeedback();
    const services = useMemo(() => createRecordingServices(workspaceId), [workspaceId]);
    const [draft, setDraft] = useState(newRecordingDraft);
    const draftRef = useRef(draft);
    const [savedDrafts, setSavedDrafts] = useState(() => listRecordingDrafts(localStorage, owner));
    const [versions, setVersions] = useState<PublishedVersion[]>([]);
    const [runtimes, setRuntimes] = useState<S["RuntimeDTO"][]>([]);
    const [session, setSession] = useState("");
    const sessionRef = useRef("");
    const lifetime = useRef<AbortController>();
    const nativeView = useRef<HTMLElement>(null);
    const languageRef = useRef(language);
    languageRef.current = language;
    const [mode, setMode] = useState<RecordingMode>("paused");
    const [target, setTarget] = useState("");
    const [path, setPath] = useState("");
    const [busy, setBusy] = useState(false);
    const actionLock = useRef(false);
    const [status, setStatus] = useState("");
    const [browserNotice, setBrowserNotice] = useState("");
    const [error, setError] = useState("");
    const [report, setReport] = useState<S["RunReportDTO"]>();
    const [reportError, setReportError] = useState("");
    const [validation, setValidation] = useState<S["JobDTO"]>();
    const [proposal, setProposal] = useState<LocatorV1>({ by: "veriqId", value: "" });
    const [proposalKey, setProposalKey] = useState("");
    const proposalInput = useRef<HTMLInputElement>(null);
    const [annotation, setAnnotation] = useState<AnnotationActionEvent>();
    const [annotationStatus, setAnnotationStatus] = useState("");
    const [revealStepId, setRevealStepId] = useState("");
    const [openedTabs, setOpenedTabs] = useState<WorkbenchTab[]>(["settings"]);
    const tab = openedTabs[0];
    const setTab = useCallback((next: WorkbenchTab, keepResourceEditor = false) => {
        setOpenedTabs((current) =>
            current[0] === next || (keepResourceEditor && current[0] === "resources")
                ? current
                : [next, ...current.filter((key) => key !== next)],
        );
    }, []);
    const [selected, setSelected] = useState<SelectedTarget>();
    const [locatorIndex, setLocatorIndex] = useState("");
    const selection = useRef<{ target: SelectedTarget; locatorIndex: string }>();
    const clearSelection = useCallback(() => {
        selection.current = undefined;
        setSelected(undefined);
        setLocatorIndex("");
        setAnnotation(undefined);
        setAnnotationStatus("");
        setProposal({ by: "veriqId", value: "" });
        setProposalKey("");
    }, []);

    const environment = versions.find((version) => version.id === draft.environmentVersionId);
    const roles = environment?.content.kind === "ENVIRONMENT" ? environment.content.document.roles : [];
    const selectedCatalog = versions.find((version) => version.id === draft.catalogVersionId);
    const catalog = useMemo(
        () =>
            selectedCatalog?.content.kind === "ELEMENT_CATALOG"
                ? { versionId: selectedCatalog.id, document: selectedCatalog.content.document }
                : undefined,
        [selectedCatalog],
    );
    const selectedDataset = versions.find((version) => version.id === draft.datasetVersionId);
    const dataset = selectedDataset?.content.kind === "DATASET" ? selectedDataset.content.document : undefined;
    const rowKeys = staticRowKeys(dataset);
    const runtimeId = runtimes.find(({ id, status }) => id === draft.runtimeId && status !== "REVOKED")?.id;
    const readyForRun = !!environment && !!runtimeId && roles.some(({ roleKey }) => roleKey === draft.roleKey);
    const build = useMemo(() => buildCaseDraft(draft, catalog, validateRecordingCase), [draft, catalog]);
    const publicationCurrent =
        !!build.content &&
        draft.casePublication?.documentSnapshot === JSON.stringify(build.content.document) &&
        draft.suitePublication?.caseVersionId === draft.casePublication.id;
    const configuration = JSON.stringify([
        draft.environmentVersionId,
        draft.roleKey,
        draft.browser ?? defaultBrowser,
        draft.runtimeId ?? "",
    ]);

    const change = useCallback(
        (update: DraftUpdate) => {
            const next = update(draftRef.current);
            if (next === draftRef.current) return;
            draftRef.current = next;
            setDraft(next);
            try {
                storeRecordingDraft(localStorage, owner, next);
                setSavedDrafts((items) => [next, ...items.filter(({ id }) => id !== next.id)]);
            } catch {
                setError("无法写入本机草稿 / Local draft could not be saved");
            }
        },
        [owner],
    );

    const refreshVersions = useCallback(
        async (signal: AbortSignal) => {
            const result = await listPublishedVersions(services, signal);
            signal.throwIfAborted();
            setVersions(result);
        },
        [services],
    );

    useEffect(() => {
        const controller = new AbortController();
        lifetime.current = controller;
        const { signal } = controller;
        const unsubscribe = bridge.recordingEvents((event) => {
            if (event.sessionId !== sessionRef.current || signal.aborted) return;
            if (event.type === "notice") {
                setBrowserNotice(notices[event.code]);
                if (event.code === "VIEW_CLOSED") {
                    sessionRef.current = "";
                    setSession("");
                    clearSelection();
                }
            } else if (event.type === "location") {
                clearSelection();
                setPath(event.url);
            } else if (event.type === "annotation-target") {
                clearSelection();
                selection.current = { target: event, locatorIndex: "" };
                setSelected(event);
                setBrowserNotice("");
                setTab("tools", true);
            } else if (event.type === "annotation-action") {
                const choice = selection.current;
                if (!choice || choice.target.id !== event.targetId || choice.target.navigation !== event.navigation)
                    return;
                const locatorChoice =
                    choice.locatorIndex === "" ? undefined : choice.target.candidates[Number(choice.locatorIndex)];
                const candidates = locatorChoice ? [locatorChoice] : event.candidates;
                setBrowserNotice("");
                setAnnotationStatus("");
                setAnnotation(undefined);
                if (event.action === "catalog") {
                    change((item) => applyRecordingEvent(item, { ...event, candidates, type: "annotation" }));
                    const locator = candidates.find(({ matches }) => matches === 1)?.locator;
                    setProposal(locator ?? { by: "veriqId", value: "" });
                    setProposalKey(locator ? (locator.by === "veriqId" ? locator.value : locator.role) : "");
                    setTab("catalog");
                    requestAnimationFrame(() => proposalInput.current?.focus());
                } else if (event.action === "click" || event.action === "fill") {
                    if (draftRef.current.steps.length >= 500) {
                        setAnnotationStatus("操作步骤已达 500 项上限 / The case already has 500 action steps.");
                        return;
                    }
                    change((item) => applyRecordingEvent(item, { ...event, candidates }));
                    setRevealStepId(`step_${event.id}`);
                    setTab("steps");
                } else {
                    setAnnotation({ ...event, candidates });
                    setTab("tools");
                }
            } else {
                if (event.type === "navigation") clearSelection();
                change((previous) => applyRecordingEvent(previous, event));
            }
        });
        void refreshVersions(signal).catch((failure) => {
            if (!signal.aborted) setError(desktopErrorMessage(failure, languageRef.current));
        });
        void services
            .runtimes(signal)
            .then((items) => {
                if (!signal.aborted) setRuntimes(items);
            })
            .catch((failure) => {
                if (!signal.aborted) setError(desktopErrorMessage(failure, languageRef.current));
            });
        return () => {
            controller.abort();
            unsubscribe();
            const id = sessionRef.current;
            sessionRef.current = "";
            if (id) void bridge.recordingClose(id).catch(() => undefined);
        };
    }, [change, clearSelection, refreshVersions, services, setTab]);

    useEffect(() => {
        const element = nativeView.current;
        if (!element || !session) return;
        const sync = () => {
            if (document.querySelector('[role="dialog"][data-state="open"]')) {
                void bridge.recordingBounds(session, null).catch(() => undefined);
                return;
            }
            const bounds = element.getBoundingClientRect();
            const x = Math.max(0, Math.ceil(bounds.left));
            const y = Math.max(0, Math.ceil(bounds.top));
            const width = Math.max(0, Math.floor(Math.min(innerWidth, bounds.right) - x));
            const height = Math.max(0, Math.floor(Math.min(innerHeight, bounds.bottom) - y));
            void bridge
                .recordingBounds(session, width && height ? { x, y, width, height } : null)
                .catch(() => undefined);
        };
        const observer = new ResizeObserver(sync);
        observer.observe(element);
        // 原生浏览视图位于渲染层和弹窗传送节点之上，因此监听弹窗节点增删并重新核对可显示区域，避免遮挡操作。
        const portals = new MutationObserver(sync);
        portals.observe(document.body, { childList: true });
        const workspace = element.closest(".recording-workspace");
        if (workspace) observer.observe(workspace);
        const browser = element.closest(".recording-browser");
        if (browser) observer.observe(browser);
        window.addEventListener("resize", sync);
        window.addEventListener("scroll", sync, true);
        sync();
        return () => {
            observer.disconnect();
            portals.disconnect();
            window.removeEventListener("resize", sync);
            window.removeEventListener("scroll", sync, true);
        };
    }, [session]);

    const runId = draft.run?.runId;
    useEffect(() => {
        setReport(undefined);
        setReportError("");
        if (!runId) return;
        const controller = new AbortController();
        const { signal } = controller;
        void services.reports
            .subscribe(
                runId,
                (value) => {
                    if (!signal.aborted && value.run.id === runId) setReport(value);
                },
                signal,
            )
            .catch((failure) => {
                if (!signal.aborted) setReportError(desktopErrorMessage(failure, language));
            });
        return () => controller.abort();
    }, [language, runId, services]);

    const validationJobId = draft.run?.validationJobId;
    useEffect(() => {
        setValidation(undefined);
        if (!validationJobId) return;
        const controller = new AbortController();
        const { signal } = controller;
        let timer: number | undefined;
        const read = async () => {
            try {
                const job = await services.resources.job(validationJobId, signal);
                if (signal.aborted) return;
                setValidation(job);
                if (job.state === "FINISHED") return;
            } catch {
                if (signal.aborted) return;
            }
            timer = window.setTimeout(() => void read(), 750);
        };
        void read();
        return () => {
            controller.abort();
            window.clearTimeout(timer);
        };
    }, [services, validationJobId]);

    async function action(work: (signal: AbortSignal) => Promise<void>) {
        const signal = lifetime.current?.signal;
        if (!signal || signal.aborted || actionLock.current) return;
        actionLock.current = true;
        setBusy(true);
        setError("");
        try {
            await work(signal);
        } catch (failure) {
            if (!signal.aborted) setError(desktopErrorMessage(failure, language));
        } finally {
            actionLock.current = false;
            if (!signal.aborted) setBusy(false);
        }
    }

    async function closeBrowser() {
        const id = sessionRef.current;
        if (id) await bridge.recordingClose(id);
        sessionRef.current = "";
        setSession("");
        setMode("paused");
        setPath("");
        clearSelection();
        setRevealStepId("");
    }

    async function openBrowser(signal: AbortSignal) {
        if (!environment) return;
        setBrowserNotice("");
        const { sessionId } = await bridge.recordingOpen({
            workspaceId,
            resourceId: environment.resourceId,
            versionId: environment.id,
            ...(target ? { target } : {}),
        });
        if (signal.aborted) {
            await bridge.recordingClose(sessionId);
            return;
        }
        sessionRef.current = sessionId;
        setMode("annotate");
        setSession(sessionId);
        setTab("tools");
    }

    async function saveCase(signal: AbortSignal) {
        if (!build.content) throw new Error("RECORDING_DRAFT_INCOMPLETE");
        const content = build.content;
        const current = draftRef.current;
        let existing = current.existing;
        setStatus("正在保存草稿 / Saving draft");
        const remember = (saved: S["DraftDTO"]) => {
            change((previous) => {
                const { pendingCaseCreate: _initial, ...rest } = previous;
                return { ...rest, existing: refOf(saved) };
            });
        };
        if (!existing && current.pendingCaseCreate) {
            const initial = current.pendingCaseCreate;
            const recovered = await services.saveDraft(
                {
                    clientDraftId: current.id,
                    key: initial.document.caseKey,
                    name: initial.name,
                    content: { kind: "CASE", document: initial.document },
                },
                signal,
            );
            remember(recovered);
            existing = refOf(recovered);
        }
        if (!existing)
            change((previous) => ({
                ...previous,
                pendingCaseCreate: { name: current.title, document: content.document },
            }));
        const saved = await services.saveDraft(
            {
                clientDraftId: current.id,
                key: content.document.caseKey,
                name: current.title,
                content,
                ...(existing ? { existing } : {}),
            },
            signal,
        );
        remember(saved);
        setStatus(`草稿已保存 / Draft saved · r${saved.revision}`);
        return saved;
    }

    async function saveCatalogDraft(signal: AbortSignal) {
        const current = draftRef.current;
        const [first, ...remaining] = [...(catalog?.document.elements ?? []), ...current.proposals];
        if (!first) return;
        const previous = current.catalogDraft;
        const baseVersionId = current.catalogVersionId;
        // 元素目录的冻结基准版本变化后必须新建草稿，只有同一基准版本才能复用保存回执，避免覆盖另一版本的恢复点。
        const recover = previous?.baseVersionId === baseVersionId ? previous : undefined;
        const clientDraftId = recover?.clientDraftId ?? current.catalogClientId ?? crypto.randomUUID();
        change((item) => ({ ...item, catalogClientId: clientDraftId }));
        setStatus("正在保存元素目录草稿 / Saving element catalog draft");
        const saved = await services.saveDraft(
            {
                clientDraftId,
                key: `catalog_${clientDraftId.replaceAll("-", "")}`,
                name: `${current.title || "Recorded"} catalog`,
                content: {
                    kind: "ELEMENT_CATALOG",
                    document: { schemaVersion: "1.0", elements: [first, ...remaining] },
                },
                ...(recover ? { existing: recover } : {}),
            },
            signal,
        );
        change((item) => ({ ...item, catalogDraft: { ...refOf(saved), baseVersionId, clientDraftId } }));
        setStatus(`元素目录草稿已保存 / Catalog draft saved · r${saved.revision}`);
        return saved;
    }

    function saveOptions(name: string, clientDraftId: string, trigger: HTMLButtonElement) {
        if (!annotation || !name) return;
        const { options, table, id } = annotation;
        if (!table?.rows.length && !options?.length) return;
        void action(async (signal) => {
            const pending = showPending("正在保存数据集草稿 / Saving dataset draft", { trigger, onClose: () => {} });
            try {
                const saved = await services.saveDraft(
                    {
                        clientDraftId,
                        key: `capture_${clientDraftId.replaceAll("-", "")}`,
                        name,
                        content: table ? tableDataset(table) : optionDataset(options ?? []),
                    },
                    signal,
                );
                signal.throwIfAborted();
                const message = `已保存数据集草稿 / Dataset draft saved · ${name} · r${saved.revision}`;
                setAnnotation((current) => (current?.id === id ? undefined : current));
                if (selection.current?.target.id === annotation.targetId) setAnnotationStatus(message);
                pending.complete("success", message);
            } catch (failure) {
                if (signal.aborted) pending.dismiss();
                else {
                    const message = desktopErrorMessage(failure, language);
                    pending.complete("failure", message);
                    if (selection.current?.target.id === annotation.targetId) setAnnotationStatus(message);
                }
            }
        });
    }

    function selectColumn(version: PublishedVersion, column: string) {
        if (annotation?.action !== "bindColumn") return;
        try {
            change((item) => bindSelectColumn(item, annotation, version, column));
            setRevealStepId(`step_${annotation.id}`);
            setTab("steps");
            setAnnotation(undefined);
            setAnnotationStatus("");
        } catch (failure) {
            const code = failure instanceof Error ? failure.message : "";
            setAnnotationStatus(
                code === "DATASET_VERSION_CONFLICT"
                    ? "请选择用例当前的矩阵版本 / Choose the matrix version already used by this case."
                    : code === "STEP_LIMIT"
                      ? "操作步骤已达 500 项上限 / The case already has 500 action steps."
                      : "请选择已发布静态数据集的文本列 / Choose a text column from a published static dataset.",
            );
        }
    }

    async function publishCatalog(signal: AbortSignal) {
        const current = draftRef.current;
        const saved = await saveCatalogDraft(signal);
        if (!saved) return;
        setStatus("正在发布元素目录 / Publishing element catalog");
        const published = await services.publishDraft(saved.resourceId, saved.revision, signal);
        setVersions((items) => [
            ...items.filter(({ id }) => id !== published.id),
            {
                id: published.id,
                resourceId: published.resourceId,
                versionNo: published.versionNo,
                content: published.content as ResourceDocumentV1,
                kind: "ELEMENT_CATALOG",
                name: `${current.title || "Recorded"} catalog`,
            },
        ]);
        change((item) => {
            const { catalogDraft: _published, catalogClientId: _id, ...rest } = item;
            return { ...rest, catalogVersionId: published.id, proposals: [] };
        });
        setStatus(`元素目录已发布 / Element catalog published · v${published.versionNo}`);
    }

    async function startTrial(signal: AbortSignal) {
        if (!readyForRun || !runtimeId) throw new Error("RECORDING_EXECUTION_SELECTION_REQUIRED");
        const saved = await saveCase(signal);
        const current = draftRef.current;
        const keys = rowKeys.filter((key) => current.dataRowKeys.includes(key));
        if (keys.length !== current.dataRowKeys.length) throw new Error("RECORDING_SELECTED_ROWS_CHANGED");
        const variables = executionVariables(current.planVariables);
        const selection = JSON.stringify([configuration, keys, variables]);
        const pending = current.pendingTrial;
        let jobId = pending?.revision === saved.revision && pending.selection === selection ? pending.jobId : "";
        let key = jobId ? (pending?.key ?? "") : "";
        setStatus("等待编译 / Waiting for compilation");
        if (!jobId || !key) {
            const job = await services.validateDraft(saved.resourceId, saved.revision, signal);
            jobId = job.id;
            key = crypto.randomUUID();
            change((item) => ({ ...item, pendingTrial: { jobId, key, selection, revision: saved.revision } }));
        }
        const result = await services.startTrial(
            {
                draftValidationJobId: jobId,
                environmentVersionId: current.environmentVersionId,
                roleKeys: [current.roleKey],
                browsers: [current.browser ?? defaultBrowser],
                runtimeIds: [runtimeId],
                variables,
                ...(keys.length ? { dataRowKeys: keys } : {}),
            },
            key,
            signal,
        );
        change((item) => {
            const { pendingTrial: _finished, ...rest } = item;
            return { ...rest, run: { runId: result.id, revision: saved.revision, validationJobId: jobId } };
        });
        setStatus("试跑已提交 / Trial submitted");
    }

    async function publishSuite(signal: AbortSignal) {
        const saved = await saveCase(signal);
        const previous = draftRef.current.casePublication;
        let caseVersionId = previous?.revision === saved.revision ? previous.id : "";
        if (!caseVersionId) {
            setStatus("正在发布用例 / Publishing case");
            const published = await services.publishDraft(saved.resourceId, saved.revision, signal);
            caseVersionId = published.id;
            change((item) => ({
                ...item,
                casePublication: {
                    id: published.id,
                    revision: saved.revision,
                    documentSnapshot: JSON.stringify(build.content?.document),
                },
            }));
        }
        const oldSuite = draftRef.current.suitePublication;
        if (oldSuite?.caseVersionId === caseVersionId) {
            setStatus("套件版本已发布 / Suite version already published");
            return;
        }
        const current = draftRef.current;
        const existing = current.suiteDraft;
        const clientDraftId = current.suiteClientId ?? crypto.randomUUID();
        change((item) => ({ ...item, suiteClientId: clientDraftId }));
        setStatus("正在发布套件 / Publishing suite");
        const savedSuite = await services.saveDraft(
            {
                clientDraftId,
                key: `suite_${current.id.replaceAll("-", "")}`,
                name: `${current.title} suite`,
                content: { kind: "SUITE", document: { schemaVersion: "1.0", cases: [{ versionId: caseVersionId }] } },
                ...(existing ? { existing } : {}),
            },
            signal,
        );
        change((item) => ({ ...item, suiteDraft: { ...refOf(savedSuite), caseVersionId } }));
        const published = await services.publishDraft(savedSuite.resourceId, savedSuite.revision, signal);
        change((item) => ({ ...item, suitePublication: { id: published.id, caseVersionId } }));
        setStatus(`套件已发布 / Suite published · v${published.versionNo}`);
    }

    async function launchPlan(signal: AbortSignal) {
        const current = draftRef.current;
        const suite = current.suitePublication;
        if (!suite || !publicationCurrent || !readyForRun || !runtimeId) return;
        const variables = executionVariables(current.planVariables);
        const overlapPolicy = current.overlapPolicy ?? "QUEUE";
        const maxCaseRetries = current.maxCaseRetries ?? 0;
        const selection = JSON.stringify([suite.id, configuration, overlapPolicy, maxCaseRetries, variables]);
        let plan = current.plan;
        if (plan?.selection !== selection) {
            setStatus("正在创建计划 / Creating execution plan");
            const created = await services.createPlan(
                {
                    name: `${current.title} plan`,
                    suiteVersionId: suite.id,
                    environmentVersionId: current.environmentVersionId,
                    roleKeys: [current.roleKey],
                    browsers: [current.browser ?? defaultBrowser],
                    runtimeIds: [runtimeId],
                    overlapPolicy,
                    maxCaseRetries,
                    variables,
                },
                signal,
            );
            if (created.suiteVersionId !== suite.id || created.environmentVersionId !== current.environmentVersionId)
                throw new Error("RECORDING_PLAN_SELECTION_MISMATCH");
            plan = { id: created.id, name: created.name, selection, launchKey: crypto.randomUUID() };
            const createdPlan = plan;
            change((item) => ({ ...item, plan: createdPlan }));
        }
        const result = await services.launchPlan(plan.id, {}, plan.launchKey, signal);
        const launched = { ...plan, launchKey: crypto.randomUUID(), lastRunId: result.runId };
        change((item) => ({ ...item, plan: launched }));
        setStatus(`计划已启动 / Plan launched · ${plan.name}`);
        openReport(result.runId);
    }

    const [bindAlias, setBindAlias] = useState("");
    const [bindDataset, setBindDataset] = useState("");
    const availableDatasets = versions.filter(({ kind }) => kind === "DATASET");
    const availableBindings = [
        ...datasetColumns(dataset).map((column) => `{{data.${column}}}`),
        ...Object.keys(parseDraftObject(draft.initialVariables) ?? {}).map((variable) => `{{vars.${variable}}}`),
    ];
    const validProposal =
        /^[A-Za-z_][A-Za-z0-9_.-]{0,159}$/.test(proposalKey) &&
        !(proposal.by === "veriqId" ? !/^[A-Za-z_][A-Za-z0-9_.-]{0,159}$/.test(proposal.value) : !proposal.role) &&
        ![...(catalog?.document.elements ?? []), ...draft.proposals].some(({ key }) => key === proposalKey);
    const versionControl = (
        kind: PublishedVersion["kind"],
        value: string,
        label: string,
        changeValue: (value: string) => void,
        testid?: string,
    ) => (
        <label>
            {label}
            <select value={value} data-testid={testid} onChange={(event) => changeValue(event.target.value)}>
                <option value="">选择版本 / Choose version</option>
                {versions
                    .filter((version) => version.kind === kind)
                    .map((version) => (
                        <option key={version.id} value={version.id}>
                            {versionLabel(version)}
                        </option>
                    ))}
                {value && !versions.some(({ id }) => id === value) && (
                    <option value={value}>版本不可用 / Version unavailable</option>
                )}
            </select>
        </label>
    );
    const propose = (locator: LocatorV1) => {
        setProposal(locator);
        setProposalKey(locator.by === "veriqId" ? locator.value : locator.role);
        setTab("catalog");
    };

    const panels: Record<WorkbenchTab, ReactNode> = {
        settings: (
            <section className="panel recording-settings">
                <div className="header-actions">
                    <label>
                        本机草稿 / Local draft
                        <select
                            data-testid="recording-draft-select"
                            value={savedDrafts.some(({ id }) => draft.id === id) ? draft.id : ""}
                            disabled={busy}
                            onChange={(event) => {
                                const id = event.target.value;
                                void action(async () => {
                                    const restored = savedDrafts.find((item) => item.id === id);
                                    if (restored) {
                                        await closeBrowser();
                                        change(() => restored);
                                        setStatus("已恢复本机草稿 / Local draft restored");
                                    }
                                });
                            }}
                        >
                            <option value="" disabled>
                                选择草稿 / Choose draft
                            </option>
                            {savedDrafts.map((item) => (
                                <option key={item.id} value={item.id}>
                                    {item.title || "未命名 / Untitled"} · {item.id.slice(0, 8)}
                                </option>
                            ))}
                        </select>
                    </label>
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                            void action(async () => {
                                await closeBrowser();
                                change(newRecordingDraft);
                                setStatus("");
                            })
                        }
                    >
                        新建草稿 / New draft
                    </button>
                    <button
                        type="button"
                        disabled={busy || !savedDrafts.some(({ id }) => id === draft.id)}
                        onClick={() =>
                            void action(async () => {
                                await closeBrowser();
                                change(copyRecordingDraft);
                                setStatus("已保留原草稿 / Original draft retained");
                            })
                        }
                    >
                        复制为新草稿 / Copy as new draft
                    </button>
                    <button type="button" disabled={busy} onClick={() => void action(refreshVersions)}>
                        刷新已发布版本 / Refresh published versions
                    </button>
                </div>
                <fieldset disabled={busy}>
                    <legend>用例设置 / Case settings</legend>
                    <label>
                        用例标题 / Case title
                        <input
                            data-testid="recording-title"
                            maxLength={160}
                            value={draft.title}
                            onChange={(event) => change((item) => ({ ...item, title: event.target.value }))}
                        />
                    </label>
                    <label>
                        用例类型 / Case kind
                        <select
                            value={draft.kind}
                            onChange={(event) =>
                                change((item) => ({
                                    ...item,
                                    kind: event.target.value === "WRITE" ? "WRITE" : "READ",
                                }))
                            }
                        >
                            <option value="READ">READ</option>
                            <option value="WRITE">WRITE</option>
                        </select>
                    </label>
                    {versionControl(
                        "ENVIRONMENT",
                        draft.environmentVersionId,
                        "环境版本 / Environment version",
                        (environmentVersionId) => {
                            void action(async () => {
                                await closeBrowser();
                                change((item) => ({ ...item, environmentVersionId, roleKey: "" }));
                            });
                        },
                        "recording-environment",
                    )}
                    <label>
                        业务角色 / Business role
                        <select
                            data-testid="recording-role"
                            value={draft.roleKey}
                            onChange={(event) => change((item) => ({ ...item, roleKey: event.target.value }))}
                        >
                            <option value="">选择角色 / Choose role</option>
                            {roles.map(({ roleKey }) => (
                                <option key={roleKey} value={roleKey}>
                                    {roleKey}
                                </option>
                            ))}
                        </select>
                        <small>
                            试跑使用该角色已配置的凭据引用。 / Trials use the credential reference configured for this
                            role.
                        </small>
                    </label>
                    {versionControl(
                        "ELEMENT_CATALOG",
                        draft.catalogVersionId,
                        "元素目录版本 / Element catalog version",
                        (catalogVersionId) => {
                            change((item) => {
                                const { catalogClientId: _previousIdentity, ...rest } = item;
                                return { ...rest, catalogVersionId };
                            });
                        },
                        "recording-catalog",
                    )}
                    {versionControl("FIXTURE", draft.fixtureVersionId ?? "", "Fixture version", (fixtureVersionId) =>
                        change((item) => ({ ...item, fixtureVersionId })),
                    )}
                    {draft.fixtureVersionId && (
                        <label>
                            Fixture 输入绑定（JSON） / Fixture input bindings (JSON)
                            <textarea
                                placeholder="{}"
                                value={draft.fixtureInput ?? ""}
                                onChange={(event) => change((item) => ({ ...item, fixtureInput: event.target.value }))}
                            />
                        </label>
                    )}
                    <label>
                        初始变量类型（JSON） / Initial variable types (JSON)
                        <textarea
                            placeholder="{}"
                            value={draft.initialVariables ?? ""}
                            onChange={(event) => change((item) => ({ ...item, initialVariables: event.target.value }))}
                        />
                    </label>
                    {draft.kind === "WRITE" && (
                        <label>
                            持久化检查点 / Persistence checkpoint
                            <select
                                value={draft.persistenceCheckpointStepId ?? ""}
                                onChange={(event) =>
                                    change((item) => ({ ...item, persistenceCheckpointStepId: event.target.value }))
                                }
                            >
                                <option value="">选择步骤 / Choose action</option>
                                {draft.steps
                                    .filter(({ disabled }) => !disabled)
                                    .map(({ step, note }, index) => (
                                        <option key={step.id} value={step.id}>
                                            {index + 1}. {step.action}
                                            {note ? ` · ${note}` : ""}
                                        </option>
                                    ))}
                            </select>
                        </label>
                    )}
                </fieldset>
            </section>
        ),
        tools: (
            <>
                <section className="panel recording-target" data-testid="recording-target-tools">
                    <h2>{language === "zh" ? "选中元素" : "Selected element"}</h2>
                    {selected ? (
                        <>
                            <p data-testid="recording-selected-element">
                                {targetKinds[selected.kind][language === "zh" ? 0 : 1]}
                                {selected.candidates[0] && ` · ${locatorLabel(selected.candidates[0].locator)}`}
                            </p>
                            <label>
                                {language === "zh" ? "元素定位方式" : "Element locator"}
                                <select
                                    data-testid="recording-tool-locator"
                                    value={locatorIndex}
                                    disabled={busy}
                                    onChange={(e) => {
                                        const index = e.target.value;
                                        selection.current = { target: selected, locatorIndex: index };
                                        setLocatorIndex(index);
                                    }}
                                >
                                    <option value="">
                                        {language === "zh" ? "自动匹配唯一定位" : "Match unique locator"}
                                    </option>
                                    {selected.candidates.map(({ locator, matches }, index) => (
                                        <option
                                            key={locatorLabel(locator)}
                                            value={String(index)}
                                            disabled={matches !== 1}
                                        >
                                            {locatorLabel(locator)} · {matches}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <div className="recording-context-actions">
                                {selected.actions.map((command) => (
                                    <button
                                        type="button"
                                        key={command}
                                        disabled={busy}
                                        data-testid={`recording-tool-${command}`}
                                        onClick={() =>
                                            void action(async () => {
                                                setAnnotation(undefined);
                                                setAnnotationStatus("");
                                                try {
                                                    await bridge.recordingAnnotationAction(
                                                        session,
                                                        selected.id,
                                                        command,
                                                    );
                                                } catch (failure) {
                                                    if (selection.current?.target.id === selected.id) {
                                                        setAnnotationStatus(desktopErrorMessage(failure, language));
                                                    }
                                                }
                                            })
                                        }
                                    >
                                        {toolLabels[command][language === "zh" ? 0 : 1]}
                                    </button>
                                ))}
                            </div>
                        </>
                    ) : (
                        <p role="status">
                            {language === "zh"
                                ? "在标注模式中点击右侧页面的元素。"
                                : "Click an element in the browser in Annotate mode."}
                        </p>
                    )}
                </section>
                {annotation && (
                    <AnnotationDataPanel
                        key={annotation.id}
                        event={annotation}
                        versions={versions}
                        matrixId={draft.datasetVersionId}
                        busy={busy}
                        saveOptions={saveOptions}
                        bindColumn={selectColumn}
                        cancel={() => {
                            setAnnotation(undefined);
                            setAnnotationStatus("");
                        }}
                    />
                )}
                {annotationStatus && (
                    <p data-testid="recording-annotation-status" role="status">
                        {annotationStatus}
                    </p>
                )}
            </>
        ),
        catalog: (
            <section className="panel">
                <h2>元素目录草稿 / Element catalog draft</h2>
                {draft.annotations.map(({ id, candidates }) => (
                    <p key={id}>
                        {candidates.length
                            ? candidates.map(({ locator, matches }) => (
                                  <span key={locatorLabel(locator)}>
                                      {locatorLabel(locator)} · {matches} matches{" "}
                                      <button
                                          type="button"
                                          disabled={busy || matches !== 1}
                                          onClick={() => propose(locator)}
                                      >
                                          采用 / Use locator
                                      </button>{" "}
                                  </span>
                              ))
                            : "无可用定位 / No usable locator"}
                    </p>
                ))}
                <fieldset disabled={busy}>
                    <legend>定位配置 / Locator configuration</legend>
                    <label>
                        元素键 / Element key
                        <input
                            ref={proposalInput}
                            data-testid="recording-proposal-key"
                            value={proposalKey}
                            maxLength={160}
                            onChange={(event) => setProposalKey(event.target.value)}
                        />
                    </label>
                    <label>
                        定位方式 / Locator type
                        <select
                            value={proposal.by}
                            onChange={(event) =>
                                setProposal(
                                    event.target.value === "role"
                                        ? { by: "role", role: "button", exact: true }
                                        : { by: "veriqId", value: "" },
                                )
                            }
                        >
                            <option value="veriqId">veriqId</option>
                            <option value="role">role</option>
                        </select>
                    </label>
                    {proposal.by === "veriqId" ? (
                        <label>
                            veriqId{" "}
                            <input
                                value={proposal.value}
                                maxLength={160}
                                onChange={(event) => setProposal({ by: "veriqId", value: event.target.value })}
                            />
                        </label>
                    ) : (
                        <>
                            <label>
                                Role{" "}
                                <input
                                    value={proposal.role}
                                    maxLength={100}
                                    onChange={(event) => setProposal({ ...proposal, role: event.target.value })}
                                />
                            </label>
                            <label>
                                可访问名称 / Accessible name
                                <input
                                    value={proposal.name ?? ""}
                                    maxLength={160}
                                    onChange={(event) => {
                                        const { name: _previous, ...role } = proposal;
                                        setProposal(event.target.value ? { ...role, name: event.target.value } : role);
                                    }}
                                />
                            </label>
                            <label>
                                <input
                                    type="checkbox"
                                    checked={proposal.exact ?? false}
                                    onChange={(event) => setProposal({ ...proposal, exact: event.target.checked })}
                                />
                                精确名称 / Exact name
                            </label>
                        </>
                    )}
                    <button
                        type="button"
                        data-testid="recording-proposal-add"
                        disabled={!validProposal}
                        onClick={() => {
                            change((item) => ({
                                ...item,
                                proposals: [...item.proposals, { key: proposalKey, locator: proposal }],
                            }));
                            setProposalKey("");
                            setProposal({ by: "veriqId", value: "" });
                        }}
                    >
                        添加定位 / Add locator
                    </button>
                    {draft.proposals.map(({ key, locator }) => (
                        <p key={key}>
                            {key} · {locatorLabel(locator)}{" "}
                            <button
                                type="button"
                                onClick={() =>
                                    change((item) => ({
                                        ...item,
                                        proposals: item.proposals.filter((existing) => existing.key !== key),
                                    }))
                                }
                            >
                                移除 / Remove
                            </button>
                        </p>
                    ))}
                    <button
                        type="button"
                        data-testid="recording-catalog-save"
                        disabled={!draft.proposals.length}
                        onClick={() =>
                            void action(async (signal) => {
                                await saveCatalogDraft(signal);
                            })
                        }
                    >
                        保存目录草稿 / Save catalog draft
                    </button>
                    <button
                        type="button"
                        data-testid="recording-catalog-publish"
                        disabled={!draft.proposals.length}
                        onClick={() => void action(publishCatalog)}
                    >
                        发布新目录版本 / Publish new catalog version
                    </button>
                    <small>
                        已发布版本固定。新版本发布后需要重新确认各步骤所用的元素。 / Confirm step targets after
                        publishing a new catalog.
                    </small>
                </fieldset>
            </section>
        ),
        data: (
            <section className="panel">
                <h2>数据 / Data</h2>
                <fieldset disabled={busy}>
                    <legend>冻结数据 / Frozen data</legend>
                    {versionControl(
                        "DATASET",
                        draft.datasetVersionId,
                        "静态矩阵版本 / Static matrix version",
                        (datasetVersionId) => {
                            change((item) => ({ ...item, datasetVersionId, dataRowKeys: [] }));
                        },
                        "recording-dataset",
                    )}
                    {dataset?.schemaVersion === "2.0" && dataset.source.kind === "HTTP" && (
                        <p role="status">
                            HTTP 数据集请作为命名数据集配置，不支持选择试跑行。 / Bind HTTP datasets by name. Trial rows
                            are unavailable.
                        </p>
                    )}
                    {rowKeys.length > 0 && (
                        <fieldset data-testid="recording-data-rows">
                            <legend>试跑行 / Trial rows</legend>
                            <p>未选中时使用全部已冻结行。 / An empty selection uses all frozen rows.</p>
                            {rowKeys.map((key) => (
                                <label className="recording-inline" key={key}>
                                    <input
                                        type="checkbox"
                                        checked={draft.dataRowKeys.includes(key)}
                                        onChange={(event) =>
                                            change((item) => ({
                                                ...item,
                                                dataRowKeys: event.target.checked
                                                    ? [...item.dataRowKeys, key]
                                                    : item.dataRowKeys.filter((existing) => existing !== key),
                                            }))
                                        }
                                    />{" "}
                                    {key}
                                </label>
                            ))}
                        </fieldset>
                    )}
                    {Object.entries(draft.datasetBindings).map(([alias, id]) => (
                        <p key={alias}>
                            {alias} · {availableDatasets.find((v) => v.id === id)?.name ?? "Unavailable"}{" "}
                            <button
                                type="button"
                                onClick={() =>
                                    change((item) => ({
                                        ...item,
                                        datasetBindings: Object.fromEntries(
                                            Object.entries(item.datasetBindings).filter(([key]) => key !== alias),
                                        ),
                                    }))
                                }
                            >
                                移除 / Remove
                            </button>
                        </p>
                    ))}
                    <label>
                        命名数据集别名 / Dataset alias
                        <input
                            value={bindAlias}
                            maxLength={160}
                            onChange={(event) => setBindAlias(event.target.value)}
                        />
                    </label>
                    {versionControl("DATASET", bindDataset, "命名数据集版本 / Named dataset version", setBindDataset)}
                    <button
                        type="button"
                        disabled={
                            !bindDataset ||
                            !/^[A-Za-z_][A-Za-z0-9_.-]{0,159}$/.test(bindAlias) ||
                            Object.hasOwn(draft.datasetBindings, bindAlias)
                        }
                        onClick={() => {
                            change((item) => ({
                                ...item,
                                datasetBindings: { ...item.datasetBindings, [bindAlias]: bindDataset },
                            }));
                            setBindAlias("");
                            setBindDataset("");
                        }}
                    >
                        添加命名数据集 / Add named dataset
                    </button>
                </fieldset>
            </section>
        ),
        steps: (
            <section className="panel">
                <h2>步骤 / Steps</h2>
                <fieldset disabled={busy}>
                    <legend>执行顺序 / Execution order</legend>
                    {stepPhases.map((phase) => (
                        <RecordingStepList
                            key={`${draft.id}:${phase}`}
                            phase={phase}
                            steps={draft[phase]}
                            preceding={phase === "steps" ? draft.prepare : []}
                            catalog={catalog}
                            versions={versions}
                            bindings={availableBindings}
                            revealStepId={phase === "steps" ? revealStepId : ""}
                            propose={propose}
                            update={(items) => change((previous) => ({ ...previous, [phase]: items }))}
                        />
                    ))}
                </fieldset>
            </section>
        ),
        run: (
            <section className="panel">
                <h2>验证、试跑与发布 / Validation, trial and publish</h2>
                <fieldset disabled={busy}>
                    <legend>执行配置 / Execution settings</legend>
                    <label>
                        浏览器 / Browser
                        <select
                            value={draft.browser ?? defaultBrowser}
                            onChange={(event) => {
                                const value = event.target.value;
                                if (value === "chromium" || value === "firefox" || value === "webkit")
                                    change((item) => ({ ...item, browser: value }));
                            }}
                        >
                            <option value="chromium">Chromium</option>
                            <option value="firefox">Firefox</option>
                            <option value="webkit">WebKit</option>
                        </select>
                    </label>
                    <label>
                        Runtime
                        <select
                            data-testid="recording-runtime"
                            value={draft.runtimeId ?? ""}
                            onChange={(event) =>
                                change((item) => ({
                                    ...item,
                                    runtimeId: event.target.value,
                                }))
                            }
                        >
                            <option value="">选择 Runtime / Choose Runtime</option>
                            {runtimes
                                .filter(({ status }) => status !== "REVOKED")
                                .map(({ id, name, status }) => (
                                    <option key={id} value={id}>
                                        {name} · {status}
                                    </option>
                                ))}
                            {draft.runtimeId && !runtimes.some(({ id }) => id === draft.runtimeId) && (
                                <option value={draft.runtimeId}>Runtime unavailable</option>
                            )}
                        </select>
                    </label>
                    <label>
                        计划并发策略 / Plan overlap policy
                        <select
                            value={draft.overlapPolicy ?? "QUEUE"}
                            onChange={(event) => {
                                const policy = event.target.value;
                                if (policy === "QUEUE" || policy === "SKIP" || policy === "REJECT")
                                    change((item) => ({ ...item, overlapPolicy: policy }));
                            }}
                        >
                            <option value="QUEUE">QUEUE</option>
                            <option value="SKIP">SKIP</option>
                            <option value="REJECT">REJECT</option>
                        </select>
                    </label>
                    <label>
                        计划重试次数 / Plan case retries
                        <input
                            type="number"
                            min={0}
                            max={1}
                            value={draft.maxCaseRetries ?? 0}
                            onChange={(event) => {
                                const value = event.target.valueAsNumber;
                                if (Number.isInteger(value) && value >= 0 && value <= 1)
                                    change((item) => ({ ...item, maxCaseRetries: value }));
                            }}
                        />
                    </label>
                    <label>
                        试跑与计划的初始变量值（JSON） / Trial and plan initial variable values (JSON)
                        <textarea
                            placeholder="{}"
                            value={draft.planVariables ?? ""}
                            onChange={(event) => change((item) => ({ ...item, planVariables: event.target.value }))}
                        />
                    </label>
                    <div className="header-actions">
                        <button
                            type="button"
                            data-testid="recording-save"
                            disabled={!build.content}
                            onClick={() =>
                                void action(async (signal) => {
                                    await saveCase(signal);
                                })
                            }
                        >
                            保存云端草稿 / Save cloud draft
                        </button>
                        <button
                            type="button"
                            data-testid="recording-trial"
                            disabled={!build.content || !readyForRun}
                            onClick={() => void action(startTrial)}
                        >
                            试跑 / Run trial
                        </button>
                        <button
                            type="button"
                            data-testid="recording-publish"
                            disabled={!build.content}
                            onClick={() => void action(publishSuite)}
                        >
                            发布用例及套件 / Publish case and suite
                        </button>
                        <button
                            type="button"
                            data-testid="recording-launch"
                            disabled={!readyForRun || !publicationCurrent}
                            onClick={() => void action(launchPlan)}
                        >
                            {draft.plan?.lastRunId
                                ? "再次启动计划 / Launch plan again"
                                : "创建并启动计划 / Create and launch plan"}
                        </button>
                    </div>
                </fieldset>
                {build.diagnostics.length > 0 && (
                    <ul className="recording-diagnostics">
                        {Array.from(
                            new Set(
                                build.diagnostics.map(({ code, stepId, detail }) =>
                                    [code, stepId, detail].filter(Boolean).join(" · "),
                                ),
                            ),
                            (message) => (
                                <li key={message}>{message}</li>
                            ),
                        )}
                    </ul>
                )}
                {draft.casePublication && <p>已发布用例版本 / Published case version · {draft.casePublication.id}</p>}
                {draft.suitePublication && (
                    <p data-testid="recording-suite-version">
                        已发布套件版本 / Published suite version · {draft.suitePublication.id}
                    </p>
                )}
                {draft.suitePublication && !publicationCurrent && (
                    <p role="status">当前编辑需要重新发布 / Publish current edits before launching</p>
                )}
                {draft.run && (
                    <div className="recording-trial">
                        <p role="status">
                            试跑 / Trial · r{draft.run.revision}
                            {" · "}
                            {report?.run.state === "FINISHED"
                                ? (report.run.outcome ?? report.run.state)
                                : report?.run.state === "RUNNING"
                                  ? "执行中 / Running"
                                  : report?.run.state === "CANCEL_REQUESTED"
                                    ? "取消中 / Cancelling"
                                    : validationJobId && validation?.state !== "FINISHED"
                                      ? "等待编译 / Waiting for compilation"
                                      : "等待 Runtime / Waiting for Runtime"}
                        </p>
                        {report && (
                            <p>
                                {report.statistics.firstPassCount}/{report.statistics.caseCount} first-pass cases
                            </p>
                        )}
                        {reportError && <p role="alert">{reportError}</p>}
                        <button
                            type="button"
                            data-testid="recording-open-report"
                            onClick={() => openReport(draft.run?.runId ?? "")}
                        >
                            打开试跑报告 / Open trial report
                        </button>
                        {report?.run.state !== "FINISHED" && (
                            <button
                                type="button"
                                disabled={busy}
                                onClick={() =>
                                    void action(async (signal) => {
                                        if (runId) await services.cancelTrial(runId, signal);
                                    })
                                }
                            >
                                取消试跑 / Cancel trial
                            </button>
                        )}
                    </div>
                )}
            </section>
        ),
        resources: resourceTools,
    };
    return (
        <section className="recording-workspace" data-testid="recording-workspace">
            <aside
                className="recording-toolbox"
                data-testid="recording-toolbox"
                aria-label={language === "zh" ? "测试设计工具" : "Test design tools"}
            >
                <nav className="recording-tabs" aria-label={language === "zh" ? "设计面板" : "Design panels"}>
                    {(Object.keys(workbenchTabs) as WorkbenchTab[])
                        .filter((key) => key !== "resources" || resourceTools)
                        .map((key) => (
                            <button
                                type="button"
                                key={key}
                                aria-current={tab === key ? "page" : undefined}
                                data-testid={`recording-tab-${key}`}
                                onClick={() => setTab(key)}
                            >
                                {workbenchTabs[key][language === "zh" ? 0 : 1]}
                            </button>
                        ))}
                </nav>
                {(Object.keys(workbenchTabs) as WorkbenchTab[])
                    .filter((key) => openedTabs.includes(key))
                    .map((key) => (
                        <div
                            className="recording-tool-content"
                            hidden={key !== tab}
                            key={key}
                            data-testid={`recording-panel-${key}`}
                        >
                            {panels[key]}
                        </div>
                    ))}
                {(status || error) && (
                    <div className="recording-feedback">
                        {status && (
                            <p data-testid="recording-status" role="status">
                                {status}
                            </p>
                        )}
                        {error && (
                            <p data-testid="recording-error" role="alert">
                                {error}
                            </p>
                        )}
                    </div>
                )}
            </aside>
            <section className="panel recording-browser">
                <h2>录制浏览器 / Recording browser</h2>
                <div className="header-actions">
                    <label>
                        目标准备路径 / Target path
                        <input
                            value={target}
                            placeholder="/"
                            maxLength={2048}
                            disabled={busy}
                            onChange={(event) => setTarget(event.target.value)}
                        />
                    </label>
                    {session ? (
                        <>
                            <button
                                type="button"
                                disabled={busy || !target}
                                onClick={() =>
                                    void action(async () => {
                                        await bridge.recordingNavigate(session, target);
                                    })
                                }
                            >
                                前往 / Go
                            </button>
                            <button
                                type="button"
                                data-testid="recording-browser-close"
                                disabled={busy}
                                onClick={() => void action(closeBrowser)}
                            >
                                关闭浏览器 / Close browser
                            </button>
                        </>
                    ) : (
                        <button
                            type="button"
                            data-testid="recording-browser-open"
                            disabled={busy || !environment}
                            onClick={() => void action(openBrowser)}
                        >
                            打开录制浏览器 / Open recording browser
                        </button>
                    )}
                </div>
                {session && (
                    <>
                        <fieldset className="recording-mode">
                            <legend>录制模式 / Recording mode</legend>
                            {(Object.keys(modeLabels) as RecordingMode[]).map((value) => (
                                <button
                                    key={value}
                                    type="button"
                                    data-testid={`recording-mode-${value}`}
                                    aria-pressed={mode === value}
                                    disabled={busy}
                                    onClick={() =>
                                        void action(async () => {
                                            const current = await bridge.recordingMode(session, value);
                                            clearSelection();
                                            setMode(value);
                                            const initialPath = current.path;
                                            if (value === "record" && initialPath) {
                                                change((item) =>
                                                    item.steps.length
                                                        ? item
                                                        : applyRecordingEvent(item, {
                                                              sessionId: session,
                                                              id: crypto.randomUUID(),
                                                              type: "navigation",
                                                              cause: "initial",
                                                              navigation: 0,
                                                              path: initialPath,
                                                          }),
                                                );
                                            }
                                        })
                                    }
                                >
                                    {modeLabels[value]}
                                </button>
                            ))}
                        </fieldset>
                        {path && <p data-testid="recording-current-path">{path}</p>}
                        <section
                            className="recording-viewport"
                            data-testid="recording-viewport"
                            aria-label="被测页面 / Target page"
                            ref={nativeView}
                        />
                    </>
                )}
                {browserNotice && <p role="status">{browserNotice}</p>}
            </section>
        </section>
    );
}
