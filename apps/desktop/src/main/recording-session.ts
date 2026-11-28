import { randomUUID } from "node:crypto";
import { maxRecordingOptions, maxRecordingOptionLength } from "../shared/recording.ts";
import type {
    AnnotationAction,
    RecordingArm,
    RecordingCandidate,
    RecordingCaptureRequest,
    RecordingEvent,
    RecordingMode,
    RecordingNavigationCause,
    RecordingNotice,
    RecordingOption,
    RecordingTable,
} from "../shared/recording.ts";

function networkURL(input: string, base?: string): URL {
    if (
        !input ||
        input.length > 2048 ||
        input.startsWith("//") ||
        /[\\\s]/.test(input) ||
        (!input.startsWith("/") && !/^https?:\/\//i.test(input))
    )
        throw new Error("RECORDING_TARGET_DENIED");
    const url = new URL(input, base);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
        throw new Error("RECORDING_TARGET_DENIED");
    return url;
}

/**
 * 目标路径以已发布环境的基准 URL 解析，调用者提供的 URL 不能自行扩张已授权来源。
 */
export function recordingTarget(base: string, origins: readonly string[], input = base): URL {
    try {
        const primary = networkURL(base);
        const approved = new Set([primary.origin, ...origins.map((origin) => networkURL(origin).origin)]);
        const url = networkURL(input, primary.href);
        if (approved.has(url.origin)) return url;
    } catch {}
    throw new Error("RECORDING_TARGET_DENIED");
}

function object(input: unknown): Record<string, unknown> | undefined {
    return input !== null && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : undefined;
}

const commonRoles = new Set([
    "button",
    "checkbox",
    "combobox",
    "link",
    "listbox",
    "menuitem",
    "radio",
    "searchbox",
    "switch",
    "table",
    "list",
    "tab",
    "textbox",
]);

function candidate(input: unknown): RecordingCandidate | undefined {
    const item = object(input);
    const locator = object(item?.locator);
    if (
        !item ||
        !locator ||
        Object.keys(item).length !== 2 ||
        Object.keys(locator).length !== 2 ||
        typeof item.matches !== "number" ||
        !Number.isInteger(item.matches) ||
        item.matches < 0 ||
        item.matches > 10001
    )
        return undefined;
    const { matches } = item;
    if (
        locator.by === "veriqId" &&
        typeof locator.value === "string" &&
        locator.value.length <= 80 &&
        /^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(locator.value)
    )
        return { locator: { by: "veriqId", value: locator.value }, matches };
    if (locator.by === "role" && typeof locator.role === "string" && commonRoles.has(locator.role))
        return { locator: { by: "role", role: locator.role }, matches };
    return undefined;
}

function validatedOptions(input: unknown): RecordingOption[] | undefined {
    if (!Array.isArray(input) || !input.length || input.length > maxRecordingOptions) return;
    const options: RecordingOption[] = [];
    for (const raw of input) {
        const entry = object(raw);
        if (
            !entry ||
            Object.keys(entry).length !== 2 ||
            typeof entry.label !== "string" ||
            entry.label.length > maxRecordingOptionLength ||
            typeof entry.value !== "string" ||
            entry.value.length > maxRecordingOptionLength
        )
            return;
        options.push({ label: entry.label, value: entry.value });
    }
    return options;
}

function validatedTable(input: unknown): RecordingTable | undefined {
    const table = object(input);
    if (
        !table ||
        Object.keys(table).length !== 2 ||
        !Array.isArray(table.columns) ||
        !table.columns.length ||
        table.columns.length > 12 ||
        !Array.isArray(table.rows) ||
        !table.rows.length ||
        table.rows.length > 200
    )
        return;
    function strings(input: unknown, width: number): input is string[] {
        return (
            Array.isArray(input) &&
            input.length === width &&
            Array.from(input).every((cell) => typeof cell === "string" && cell.length <= 256)
        );
    }
    if (!strings(table.columns, table.columns.length)) return;
    const rows: string[][] = [];
    for (const row of table.rows) {
        if (!strings(row, table.columns.length)) return;
        rows.push([...row]);
    }
    return { columns: [...table.columns], rows };
}

/**
 * 本记录能力只属于创建时的 WebContents，导航开始即撤销前一文档，当前主 frame 加载完成后方可继续收集。
 */
export class RecordingSession {
    readonly id = randomUUID();
    private navigation = 1;
    private generation = 0;
    private frame: object | undefined;
    private mode: RecordingMode = "paused";
    private closed = false;
    private selected: { target: Extract<RecordingEvent, { type: "annotation-target" }>; requestId: number } | undefined;
    private capture: { id: string; action: "captureOptions" | "extractData" } | undefined;

    constructor(private readonly contentsId: number) {}

    get arm(): RecordingArm | undefined {
        if (!this.frame || this.closed) return undefined;
        return { sessionId: this.id, navigation: this.navigation, mode: this.mode, generation: this.generation };
    }

    beginNavigation(): void {
        if (this.frame) this.navigation++;
        this.frame = undefined;
        this.dismissAnnotation();
    }

    finishNavigation(frame: object): void {
        if (!this.closed) this.frame = frame;
    }

    setMode(mode: RecordingMode): void {
        if (!this.closed && this.mode !== mode) {
            this.mode = mode;
            this.generation++;
            this.dismissAnnotation();
        }
    }

    close(): void {
        this.closed = true;
        this.frame = undefined;
        this.dismissAnnotation();
    }

    notice(code: RecordingNotice): RecordingEvent {
        return { ...this.identity(), type: "notice", code };
    }

    location(url: string): RecordingEvent {
        return { ...this.identity(), type: "location", url };
    }

    navigated(path: string, cause: RecordingNavigationCause): RecordingEvent | undefined {
        if (this.mode !== "record" || !this.arm) return;
        return { ...this.identity(), type: "navigation", path, cause };
    }

    acceptsArm(sender: { contentsId: number; frame: object | null }, input: unknown): boolean {
        const arm = this.arm;
        const event = object(input);
        return Boolean(
            arm &&
                event &&
                Object.keys(event).length === 3 &&
                sender.contentsId === this.contentsId &&
                sender.frame === this.frame &&
                event.sessionId === arm.sessionId &&
                event.navigation === arm.navigation &&
                event.generation === arm.generation,
        );
    }

    private dismissAnnotation(): void {
        this.selected = undefined;
        this.capture = undefined;
    }

    chooseAnnotation(targetId: string, requested: unknown): RecordingEvent | RecordingCaptureRequest | undefined {
        const selected = this.selected;
        if (!selected || selected.target.id !== targetId || this.mode !== "annotate" || !this.arm) return;
        const action = selected.target.actions.find((allowed) => allowed === requested);
        if (!action) return;
        if (action === "captureOptions" || action === "extractData") {
            if (this.capture) return;
            this.capture = { id: randomUUID(), action };
            return {
                type: action === "captureOptions" ? "read-options" : "read-table",
                sessionId: this.id,
                navigation: this.navigation,
                generation: this.generation,
                requestId: selected.requestId,
                captureId: this.capture.id,
            };
        }
        return {
            ...this.identity(),
            type: "annotation-action",
            targetId,
            action,
            candidates: selected.target.candidates,
        };
    }

    acceptEvent(sender: { contentsId: number; frame: object | null }, input: unknown): RecordingEvent | undefined {
        const event = object(input);
        if (
            !this.arm ||
            this.mode === "paused" ||
            sender.contentsId !== this.contentsId ||
            sender.frame !== this.frame ||
            !event ||
            event.sessionId !== this.id ||
            event.navigation !== this.navigation ||
            event.generation !== this.generation
        )
            return;
        if (event.type === "annotation-options" || event.type === "annotation-table") {
            const selected = this.selected;
            const action = event.type === "annotation-options" ? "captureOptions" : "extractData";
            if (
                this.mode !== "annotate" ||
                !selected ||
                this.capture?.action !== action ||
                event.captureId !== this.capture.id ||
                event.requestId !== selected.requestId ||
                Object.keys(event).length !== 7
            )
                return;
            const raw = action === "captureOptions" ? event.options : event.table;
            if (raw === null) {
                this.capture = undefined;
                return this.notice(action === "captureOptions" ? "OPTIONS_UNAVAILABLE" : "DATA_UNAVAILABLE");
            }
            const result = {
                ...this.identity(),
                type: "annotation-action" as const,
                action,
                targetId: selected.target.id,
                candidates: selected.target.candidates,
            };
            if (action === "captureOptions") {
                const options = validatedOptions(raw);
                if (!options) return;
                this.capture = undefined;
                return { ...result, action, options };
            }
            const table = validatedTable(raw);
            if (!table) return;
            this.capture = undefined;
            return { ...result, action, table };
        }
        if (!Array.isArray(event.candidates) || event.candidates.length > 2) return;
        const candidates: RecordingCandidate[] = [];
        for (const raw of event.candidates) {
            const value = candidate(raw);
            if (!value) return;
            candidates.push(value);
        }
        if (event.type === "annotation-target") {
            if (
                this.mode !== "annotate" ||
                Object.keys(event).length !== 7 ||
                typeof event.requestId !== "number" ||
                !Number.isSafeInteger(event.requestId) ||
                event.requestId < 1 ||
                (event.kind !== "generic" &&
                    event.kind !== "text" &&
                    event.kind !== "select" &&
                    event.kind !== "table" &&
                    event.kind !== "list")
            )
                return;
            const actions: AnnotationAction[] = ["catalog", "click"];
            if (event.kind === "text") actions.push("fill");
            if (event.kind === "select") actions.push("captureOptions", "bindColumn");
            if (event.kind === "table" || event.kind === "list") actions.push("extractData");
            this.capture = undefined;
            const target: Extract<RecordingEvent, { type: "annotation-target" }> = {
                ...this.identity(),
                type: "annotation-target",
                kind: event.kind,
                candidates,
                actions,
            };
            this.selected = { target, requestId: event.requestId };
            return target;
        }
        if (this.mode !== "record") return;
        const keys = Object.keys(event).length;
        if (Object.hasOwn(event, "value") || event.type === "fill-pending") {
            const isCombobox = event.editableCombobox === true;
            const roles = candidates.flatMap(({ locator }) => (locator.by === "role" ? [locator.role] : []));
            if (keys !== (isCombobox ? 6 : 5) || roles.length !== 1) return;
            const [role] = roles;
            if (isCombobox ? role !== "combobox" : role !== "textbox" && role !== "searchbox") return;
            if (event.type === "fill-pending") return { ...this.identity(), type: "fill-pending", candidates };
            if (typeof event.value !== "string" || event.value.length > 4096) return;
            return { ...this.identity(), type: "fill", value: event.value, candidates };
        }
        if (keys === 4) return { ...this.identity(), type: "click", candidates };
    }

    private identity() {
        return { sessionId: this.id, navigation: this.navigation, id: randomUUID() };
    }
}
