import type { CaseDslV1, ElementCatalogV1, LocatorV1, StepV1, ValidationIssue } from "@veriq/contracts";
import type { RecordingCandidate, RecordingEvent } from "../../shared/recording.js";

export type CleanupOutcome = "SUCCESS" | "FAILURE" | "CANCELLED";
export type StepPhase = "steps" | "prepare" | CleanupOutcome;
export const cleanupOutcomes = ["SUCCESS", "FAILURE", "CANCELLED"] as const;
export const stepPhases = ["prepare", "steps", ...cleanupOutcomes] as const;

export interface DraftStep {
    step: StepV1;
    disabled?: boolean;
    note?: string;
    recording?: { catalogVersionId: string; candidates: RecordingCandidate[] };
    target?: { catalogVersionId: string; key: string };
}

export interface DraftReference {
    resourceId: string;
    revision: number;
}

export interface RecordingDraft {
    id: string;
    title: string;
    roleKey: string;
    kind: CaseDslV1["kind"];
    environmentVersionId: string;
    catalogVersionId: string;
    datasetVersionId: string;
    fixtureVersionId?: string;
    fixtureInput?: string;
    initialVariables?: string;
    persistenceCheckpointStepId?: string;
    dataRowKeys: string[];
    datasetBindings: NonNullable<CaseDslV1["datasetBindings"]>;
    prepare: DraftStep[];
    steps: DraftStep[];
    SUCCESS: DraftStep[];
    FAILURE: DraftStep[];
    CANCELLED: DraftStep[];
    annotations: { id: string; candidates: RecordingCandidate[] }[];
    proposals: { key: string; locator: LocatorV1 }[];
    existing?: DraftReference;
    pendingCaseCreate?: { name: string; document: CaseDslV1 };
    catalogClientId?: string;
    suiteClientId?: string;
    catalogDraft?: DraftReference & { clientDraftId: string; baseVersionId: string };
    suiteDraft?: DraftReference & { caseVersionId: string };
    casePublication?: { id: string; revision: number; documentSnapshot: string };
    suitePublication?: { id: string; caseVersionId: string };
    pendingTrial?: { key: string; jobId: string; revision: number; selection: string };
    plan?: { id: string; name: string; selection: string; launchKey: string; lastRunId?: string };
    run?: { runId: string; revision: number; validationJobId?: string };
    runtimeId?: string;
    browser?: "chromium" | "firefox" | "webkit";
    overlapPolicy?: "QUEUE" | "SKIP" | "REJECT";
    maxCaseRetries?: number;
    planVariables?: string;
}

export interface CatalogVersion {
    versionId: string;
    document: ElementCatalogV1;
}

export function newRecordingDraft(): RecordingDraft {
    return {
        id: crypto.randomUUID(),
        title: "",
        roleKey: "",
        kind: "READ",
        environmentVersionId: "",
        catalogVersionId: "",
        datasetVersionId: "",
        dataRowKeys: [],
        datasetBindings: {},
        prepare: [],
        steps: [],
        SUCCESS: [],
        FAILURE: [],
        CANCELLED: [],
        annotations: [],
        proposals: [],
    };
}

export function copyRecordingDraft(draft: RecordingDraft): RecordingDraft {
    const {
        existing: _existing,
        pendingCaseCreate: _pendingCase,
        catalogClientId: _catalogClientId,
        suiteClientId: _suiteClientId,
        catalogDraft: _catalogDraft,
        suiteDraft: _suiteDraft,
        casePublication: _casePublication,
        suitePublication: _suitePublication,
        pendingTrial: _pendingTrial,
        plan: _plan,
        run: _run,
        ...editing
    } = draft;
    return { ...editing, id: crypto.randomUUID() };
}

export function applyRecordingEvent(draft: RecordingDraft, event: RecordingEvent): RecordingDraft {
    if (event.type === "annotation") {
        if (draft.annotations.some(({ id }) => id === event.id) || draft.annotations.length >= 500) return draft;
        return { ...draft, annotations: [...draft.annotations, { id: event.id, candidates: event.candidates }] };
    }
    const id = `step_${event.id}`;
    if (draft.steps.some(({ step }) => step.id === id) || draft.steps.length >= 500) return draft;
    if (
        event.type === "navigation" &&
        (event.cause === "explicit" || (event.cause === "initial" && !draft.steps.length))
    ) {
        return { ...draft, steps: [...draft.steps, { step: { id, action: "goto", path: event.path } }] };
    }
    if (event.type !== "click" && event.type !== "fill") return draft;
    return {
        ...draft,
        steps: [
            ...draft.steps,
            {
                step:
                    event.type === "fill"
                        ? { id, action: "fill", target: "", value: event.value }
                        : { id, action: "click", target: "" },
                recording: { catalogVersionId: draft.catalogVersionId, candidates: event.candidates },
            },
        ],
    };
}

export function confirmTarget(
    draft: RecordingDraft,
    stepId: string,
    catalogVersionId: string,
    key: string,
): RecordingDraft {
    const updated = { ...draft };
    for (const phase of stepPhases) {
        updated[phase] = draft[phase].map((item) =>
            item.step.id === stepId ? { ...item, target: { catalogVersionId, key } } : item,
        );
    }
    return updated;
}

function sameLocator(left: LocatorV1, right: LocatorV1): boolean {
    return left.by === "veriqId"
        ? right.by === "veriqId" && left.value === right.value
        : right.by === "role" && left.role === right.role && left.name === right.name && !!left.exact === !!right.exact;
}

interface Diagnostic {
    code: string;
    stepId?: string;
    detail?: string;
}

export function requiresTarget(step: StepV1): step is Extract<StepV1, { target: string }> {
    return "target" in step;
}

export function parseDraftObject(value: string | undefined): Record<string, unknown> | undefined {
    try {
        const parsed: unknown = JSON.parse(value?.trim() || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
        // Invalid freeform JSON remains editable in the local draft.
    }
}

export function buildCaseDraft(
    draft: RecordingDraft,
    catalog: CatalogVersion | undefined,
    validate: (value: CaseDslV1) => ValidationIssue[],
): { content?: { kind: "CASE"; document: CaseDslV1 }; diagnostics: Diagnostic[] } {
    const diagnostics: Diagnostic[] = [];
    if (!catalog || catalog.versionId !== draft.catalogVersionId)
        return { diagnostics: [{ code: "SELECT_PUBLISHED_CATALOG" }] };

    const resolveTarget = ({ step, target, recording }: DraftStep): string | undefined => {
        const stepId = step.id;
        if (target) {
            if (target.catalogVersionId !== catalog.versionId) diagnostics.push({ code: "CATALOG_CHANGED", stepId });
            else {
                const element = catalog.document.elements.find(({ key }) => key === target.key);
                if (
                    element &&
                    !recording?.candidates.some(
                        ({ locator, matches }) => matches !== 1 && sameLocator(locator, element.locator),
                    )
                )
                    return element.key;
                diagnostics.push({ code: element ? "AMBIGUOUS_LOCATOR" : "UNKNOWN_ELEMENT_KEY", stepId });
            }
            return;
        }
        if (recording && recording.catalogVersionId !== catalog.versionId) {
            diagnostics.push({ code: "CATALOG_CHANGED", stepId });
            return;
        }
        const valid = recording?.candidates.filter(({ matches }) => matches === 1) ?? [];
        const keys = catalog.document.elements.filter((element) =>
            valid.some(({ locator }) => sameLocator(locator, element.locator)),
        );
        if (keys.length === 1) return keys[0]?.key;
        diagnostics.push({
            code:
                keys.length > 1 || recording?.candidates.some(({ matches }) => matches > 1)
                    ? "AMBIGUOUS_LOCATOR"
                    : "SELECT_ELEMENT_KEY",
            stepId,
        });
    };

    const knownKeys = new Set(catalog.document.elements.map(({ key }) => key));
    const ids = new Set<string>();
    const disabledValues = new Set<string>();
    const enabledValues = new Set<string>();
    for (const phase of stepPhases) {
        for (const { step, disabled } of draft[phase]) {
            for (const item of step.extract ?? []) (disabled ? disabledValues : enabledValues).add(item.to);
        }
    }
    function convert(items: DraftStep[], inheritedPages: ReadonlySet<string> = new Set()) {
        const pages = new Set(inheritedPages);
        const converted: StepV1[] = [];
        for (const item of items) {
            if (item.disabled) continue;
            let { step } = item;
            if (ids.has(step.id)) diagnostics.push({ code: "DUPLICATE_STEP_ID", stepId: step.id });
            ids.add(step.id);
            if (requiresTarget(step)) {
                const key = resolveTarget(item);
                if (key) step = { ...step, target: key };
            }
            const checkPage = (key: string | undefined) => {
                if (key && !pages.has(key))
                    diagnostics.push({ code: "MISSING_PAGE_DEPENDENCY", stepId: step.id, detail: key });
            };
            function checkAssertions(assertions: StepV1["beforeAssertions"]) {
                for (const assertion of assertions ?? []) {
                    if ("target" in assertion && !knownKeys.has(assertion.target))
                        diagnostics.push({ code: "UNKNOWN_ASSERTION_KEY", stepId: step.id, detail: assertion.target });
                    if ("pageKey" in assertion) checkPage(assertion.pageKey);
                }
            }
            checkPage(step.pageKey);
            checkAssertions(step.beforeAssertions);
            for (const observer of step.observers ?? [])
                if ("kind" in observer && observer.kind === "newPage" && typeof observer.pageKey === "string")
                    pages.add(observer.pageKey);
            checkAssertions(step.afterAssertions);
            for (const binding of JSON.stringify(step).matchAll(/\{\{vars\.([A-Za-z_][A-Za-z0-9_.-]*)\}\}/g)) {
                const key = binding[1];
                if (key && disabledValues.has(key) && !enabledValues.has(key))
                    diagnostics.push({ code: "DISABLED_VARIABLE_DEPENDENCY", stepId: step.id, detail: key });
            }
            converted.push(step);
        }
        return { converted, pages };
    }
    const prepare = convert(draft.prepare);
    const main = convert(draft.steps, prepare.pages);
    type Cleanup = NonNullable<NonNullable<CaseDslV1["lifecycle"]>["cleanup"]>;
    const [success, failure, cancelled] = cleanupOutcomes.flatMap<Cleanup[number]>((on) => {
        const { converted } = convert(draft[on]);
        const [first, ...rest] = converted;
        return first ? [{ on, steps: [first, ...rest] }] : [];
    });
    const cleanup: Cleanup = !success
        ? []
        : !failure
          ? [success]
          : !cancelled
            ? [success, failure]
            : [success, failure, cancelled];
    const [first, ...rest] = main.converted;
    if (!first) diagnostics.push({ code: "NO_ENABLED_ACTIONS" });
    if (draft.kind === "WRITE" && !main.converted.some(({ id }) => id === draft.persistenceCheckpointStepId))
        diagnostics.push({ code: "MISSING_PERSISTENCE_CHECKPOINT" });
    const fixtureInput = parseDraftObject(draft.fixtureInput) as CaseDslV1["fixtureInput"];
    const initialVariables = parseDraftObject(draft.initialVariables) as CaseDslV1["initialVariables"];
    if (!fixtureInput && draft.fixtureVersionId) diagnostics.push({ code: "FIXTURE_INPUT_REQUIRES_JSON_OBJECT" });
    if (!initialVariables) diagnostics.push({ code: "INITIAL_VARIABLES_REQUIRE_JSON_OBJECT" });
    if (diagnostics.length || !first) return { diagnostics };

    const document: CaseDslV1 = {
        schemaVersion: "1.0",
        caseKey: `case_${draft.id.replaceAll("-", "")}`,
        title: draft.title,
        kind: draft.kind,
        roleKey: draft.roleKey,
        catalogVersionId: catalog.versionId,
        ...(draft.datasetVersionId ? { datasetVersionId: draft.datasetVersionId } : {}),
        ...(draft.fixtureVersionId ? { fixtureVersionId: draft.fixtureVersionId } : {}),
        ...(draft.fixtureVersionId && fixtureInput && Object.keys(fixtureInput).length ? { fixtureInput } : {}),
        ...(initialVariables && Object.keys(initialVariables).length ? { initialVariables } : {}),
        ...(draft.persistenceCheckpointStepId
            ? { persistenceCheckpointStepId: draft.persistenceCheckpointStepId }
            : {}),
        ...(Object.keys(draft.datasetBindings).length ? { datasetBindings: draft.datasetBindings } : {}),
        ...(prepare.converted.length || cleanup.length ? { lifecycle: { prepare: prepare.converted, cleanup } } : {}),
        steps: [first, ...rest],
    };
    const issues = validate(document);
    return issues.length
        ? { diagnostics: issues.map((issue) => ({ code: issue.code, detail: issue.path })) }
        : { content: { kind: "CASE", document }, diagnostics };
}

const draftId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

export function storeRecordingDraft(storage: Storage, scope: string, draft: RecordingDraft): void {
    storage.setItem(`veriq:recording:1:${scope}:${draft.id}`, JSON.stringify(draft));
}

export function listRecordingDrafts(storage: Storage, scope: string): RecordingDraft[] {
    const prefix = `veriq:recording:1:${scope}:`;
    const drafts: RecordingDraft[] = [];
    for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        if (!key?.startsWith(prefix) || !draftId.test(key.slice(prefix.length))) continue;
        try {
            const draft = JSON.parse(storage.getItem(key) ?? "") as RecordingDraft;
            if (draft?.id === key.slice(prefix.length) && stepPhases.every((phase) => Array.isArray(draft[phase])))
                drafts.push(draft);
        } catch {
            // An incomplete local copy cannot overwrite any valid draft.
        }
    }
    return drafts;
}
