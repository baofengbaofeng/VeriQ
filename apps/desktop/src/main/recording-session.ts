import { randomUUID } from "node:crypto";
import type {
    RecordingArm,
    RecordingCandidate,
    RecordingEvent,
    RecordingMode,
    RecordingNavigationCause,
    RecordingNotice,
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

/** 目标路径以已发布环境的基准 URL 解析，调用者提供的 URL 不能自行扩张已授权来源。 */
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

/** 本记录能力只属于创建时的 WebContents，导航开始即撤销前一文档，当前主 frame 加载完成后方可继续收集。 */
export class RecordingSession {
    readonly id = randomUUID();
    private navigation = 1;
    private generation = 0;
    private frame: object | undefined;
    private mode: RecordingMode = "paused";
    private closed = false;

    constructor(private readonly contentsId: number) {}

    get arm(): RecordingArm | undefined {
        if (!this.frame || this.closed) return undefined;
        return { sessionId: this.id, navigation: this.navigation, mode: this.mode, generation: this.generation };
    }

    beginNavigation(): void {
        if (this.frame) this.navigation++;
        this.frame = undefined;
    }

    finishNavigation(frame: object): void {
        if (!this.closed) this.frame = frame;
    }

    setMode(mode: RecordingMode): void {
        if (!this.closed && this.mode !== mode) {
            this.mode = mode;
            this.generation++;
        }
    }

    close(): void {
        this.closed = true;
        this.frame = undefined;
    }

    notice(code: RecordingNotice): RecordingEvent {
        return { ...this.identity(), type: "notice", code };
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

    /**
     * 只读取定长会话信息与最多两个定位候选。IPC 对象、来源、代次和生命周期全部验证后，事件才可转交可信工作区。
     */
    acceptEvent(sender: { contentsId: number; frame: object | null }, input: unknown): RecordingEvent | undefined {
        const event = object(input);
        if (
            !this.arm ||
            this.mode === "paused" ||
            sender.contentsId !== this.contentsId ||
            sender.frame !== this.frame ||
            !event ||
            Object.keys(event).length !== 4 ||
            event.sessionId !== this.id ||
            event.navigation !== this.navigation ||
            event.generation !== this.generation ||
            !Array.isArray(event.candidates) ||
            event.candidates.length > 2
        )
            return;
        const candidates: RecordingCandidate[] = [];
        for (const raw of event.candidates) {
            const value = candidate(raw);
            if (!value) return;
            candidates.push(value);
        }
        return { ...this.identity(), type: this.mode === "record" ? "click" : "annotation", candidates };
    }

    private identity() {
        return { sessionId: this.id, navigation: this.navigation, id: randomUUID() };
    }
}
