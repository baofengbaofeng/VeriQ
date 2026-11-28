import { ipcRenderer } from "electron";
import { findDataElement, readDataElement } from "./annotation-table";
import { maxRecordingOptions, maxRecordingOptionLength } from "../shared/recording";
import type {
    RecordingAnnotationTarget,
    RecordingArm,
    RecordingCandidate,
    RecordingCaptureRequest,
    RecordingOption,
    RecordingOptionsReply,
    RecordingTableReply,
} from "../shared/recording";

function elementRole(element: Element): string | undefined {
    const explicit = element.getAttribute("role")?.trim().split(/\s+/, 1)[0];
    if (explicit) return explicit;
    if (element.matches("button, summary, input:is([type=button],[type=submit],[type=reset],[type=image])"))
        return "button";
    if (element.matches("a[href], area[href]")) return "link";
    if (element.matches("table")) return "table";
    if (element.matches("ul, ol")) return "list";
    if (element.matches("input[type=checkbox]")) return "checkbox";
    if (element.matches("input[type=radio]")) return "radio";
    if (element.matches("input[type=search]:not([list])")) return "searchbox";
    if (element.matches("select[multiple], select[size]:not([size='1'])")) return "listbox";
    if (element.matches("select, input[list]:not([type=hidden])")) return "combobox";
    if (element.matches("textarea, input:not([type]), input:is([type=text],[type=email],[type=tel],[type=url])"))
        return "textbox";
}

const roles = new Set([
    "button",
    "checkbox",
    "combobox",
    "link",
    "list",
    "listbox",
    "menuitem",
    "radio",
    "searchbox",
    "switch",
    "tab",
    "table",
    "textbox",
]);

function candidates(event: Event, selected?: Element): RecordingCandidate[] {
    const elements = selected
        ? [selected]
        : event.composedPath().filter((target): target is Element => target instanceof Element);
    const named = elements.find((element) => element.hasAttribute("veriq-id"));
    const value = named?.getAttribute("veriq-id");
    const role = elements.map(elementRole).find((entry) => entry && roles.has(entry));
    let byId = 0;
    let byRole = 0;
    const tree = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
    let incomplete = false;
    for (let count = 0; ; count++) {
        const node = tree.nextNode();
        if (!(node instanceof Element)) break;
        if (count >= 10000 || node.shadowRoot) {
            incomplete = true;
            break;
        }
        if (value && node.getAttribute("veriq-id") === value) byId++;
        if (role && elementRole(node) === role) byRole++;
    }
    const result: RecordingCandidate[] = [];
    if (value && value.length <= 80 && /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(value))
        result.push({ locator: { by: "veriqId", value }, matches: incomplete ? 10001 : byId });
    if (role) result.push({ locator: { by: "role", role }, matches: incomplete ? 10001 : byRole });
    return result;
}

/**
 * 被测页面没有公开的 contextBridge。普通文本仅在用户编辑并提交时进入录制；认证表单与凭证字段不自动采集。
 * 页面脚本派发的事件不会成为录制步骤；标注时在捕获阶段拦截业务激活，记录时放行真实点击。
 */
if (process.isMainFrame) {
    let current: RecordingArm | undefined;
    let edits = new WeakSet<Element>();
    let requestId = 0;
    let selected: HTMLSelectElement | ReturnType<typeof findDataElement>;
    ipcRenderer.on("veriq:recording-arm", (_event, next: RecordingArm | undefined) => {
        current = next;
        edits = new WeakSet();
        selected = undefined;
        if (next) {
            const { sessionId, navigation, generation } = next;
            ipcRenderer.send("veriq:recording-arm-ack", { sessionId, navigation, generation });
        }
    });
    function ordinaryControl(element: HTMLSelectElement | HTMLInputElement | HTMLTextAreaElement): boolean {
        if (element.matches(":disabled") || element.form?.querySelector("input[type=password]")) return false;
        const hints = [
            element.autocomplete,
            element.name,
            element.id,
            element.getAttribute("aria-label"),
            element.getAttribute("placeholder"),
        ].join(" ");
        return !/username|password|passwd|secret|token|one-time|otp|verification.?code|cc-|cvv|cvc|webauthn|密码|口令|验证码|密钥/i.test(
            hints,
        );
    }
    function ordinaryField(element: EventTarget | null): element is HTMLTextAreaElement | HTMLInputElement {
        return (
            (element instanceof HTMLTextAreaElement ||
                (element instanceof HTMLInputElement &&
                    ["text", "search", "url", "email", "tel"].includes(element.type))) &&
            !element.readOnly &&
            ordinaryControl(element)
        );
    }

    function readOptions(select: HTMLSelectElement): RecordingOption[] | null {
        if (
            !select.isConnected ||
            !ordinaryControl(select) ||
            !select.options.length ||
            select.options.length > maxRecordingOptions
        )
            return null;
        const options: RecordingOption[] = [];
        for (const option of select.options) {
            const { label, value } = option;
            if (label.length > maxRecordingOptionLength || value.length > maxRecordingOptionLength) return null;
            options.push({ label, value });
        }
        return options;
    }
    function selectTarget(field: Element) {
        const control = field.closest("input,select,textarea,button,[contenteditable=true],[role=button]");
        selected = undefined;
        if (control) {
            if (control instanceof HTMLSelectElement && ordinaryControl(control)) {
                selected = control;
                return { kind: "select", element: control } as const;
            }
            return { kind: ordinaryField(control) ? "text" : "generic", element: control } as const;
        }
        selected = findDataElement(field);
        if (!selected) return { kind: "generic", element: undefined } as const;
        return { kind: selected instanceof HTMLTableElement ? "table" : "list", element: selected } as const;
    }
    ipcRenderer.on("veriq:recording-capture", (_event, request: RecordingCaptureRequest) => {
        if (
            !selected ||
            current?.mode !== "annotate" ||
            request.requestId !== requestId ||
            request.sessionId !== current.sessionId ||
            request.navigation !== current.navigation ||
            request.generation !== current.generation
        )
            return;
        if (request.type === "read-options" && selected instanceof HTMLSelectElement) {
            ipcRenderer.send("veriq:recording-event", {
                ...request,
                type: "annotation-options",
                options: readOptions(selected),
            } satisfies RecordingOptionsReply);
        } else if (request.type === "read-table" && !(selected instanceof HTMLSelectElement)) {
            ipcRenderer.send("veriq:recording-event", {
                ...request,
                type: "annotation-table",
                table: selected.isConnected ? readDataElement(selected) : null,
            } satisfies RecordingTableReply);
        }
    });
    const captureEdit = (event: Event) => {
        if (!event.isTrusted || current?.mode !== "record" || !ordinaryField(event.target)) return;
        const field = event.target;
        if (event.type === "input") {
            edits.add(field);
            return;
        }
        if (event instanceof KeyboardEvent && (event.key !== "Enter" || event.shiftKey || event.isComposing)) return;
        if (!edits.delete(field) || field.value.length > 4096) return;
        const { sessionId, navigation, generation } = current;
        ipcRenderer.sendSync("veriq:recording-event", {
            sessionId,
            navigation,
            generation,
            candidates: candidates(event),
            value: field.value,
        });
    };
    for (const type of ["input", "change", "focusout", "keydown"])
        window.addEventListener(type, captureEdit, { capture: true });
    const handle = (event: Event) => {
        if (!event.isTrusted || !current || current.mode === "paused") return;
        const { sessionId, navigation, mode, generation } = current;
        if (mode === "annotate") {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (
                event.type === "pointerdown" &&
                event instanceof PointerEvent &&
                event.isPrimary &&
                event.button === 0
            ) {
                const field = event.composedPath().find((item) => item instanceof Element);
                if (!field) return;
                const target = selectTarget(field);
                ipcRenderer.send("veriq:recording-event", {
                    type: "annotation-target",
                    sessionId,
                    navigation,
                    generation,
                    requestId: ++requestId,
                    kind: target.kind,
                    candidates: candidates(event, target.element),
                } satisfies RecordingAnnotationTarget);
            }
            return;
        }
        if (event.type === "click" && event instanceof MouseEvent && event.button === 0)
            // 先提交可信点击，随后才放行页面默认导航，避免旧文档事件因 IPC 与导航乱序而被丢弃。
            ipcRenderer.sendSync("veriq:recording-event", {
                sessionId,
                navigation,
                generation,
                candidates: candidates(event),
            });
    };
    for (const type of [
        "pointerdown",
        "pointerup",
        "mousedown",
        "mouseup",
        "click",
        "auxclick",
        "dblclick",
        "contextmenu",
        "keydown",
        "keyup",
        "submit",
    ])
        window.addEventListener(type, handle, { capture: true, passive: false });
}
