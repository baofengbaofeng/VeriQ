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
 * 被测页面没有公开的 contextBridge。只有显式声明为普通业务数据的字段才能采集值，认证表单与凭证字段排除。
 * 页面脚本派发的事件不会成为录制步骤；标注时在捕获阶段拦截业务激活，记录时放行真实点击。
 */
if (process.isMainFrame) {
    let current: RecordingArm | undefined;
    let edits = new WeakMap<Element, "public" | "pending" | "blocked">();
    let requestId = 0;
    let selected: HTMLSelectElement | ReturnType<typeof findDataElement>;
    ipcRenderer.on("veriq:recording-arm", (_event, next: RecordingArm | undefined) => {
        current = next;
        edits = new WeakMap();
        selected = undefined;
        if (next) {
            const { sessionId, navigation, generation } = next;
            ipcRenderer.send("veriq:recording-arm-ack", { sessionId, navigation, generation });
        }
    });
    const credentialHint = /user.?name|pass.?word|passwd|pass.?code|pass.?phrase|secret|token|one.?time|otp|api.?key/i;
    const verificationHint =
        /(?:verification|security|recovery).?code|cc-|cvv|cvc|webauthn|密码|口令|验证码|密钥|安全码/i;
    function sensitiveHint(text: string): boolean {
        return (
            credentialHint.test(text) ||
            verificationHint.test(text) ||
            /(?:^|[^a-z])pin(?:$|[^a-z]|code|number)/i.test(text.replace(/([a-z])([A-Z])/g, "$1 $2"))
        );
    }
    function riskyLabels(element: Element, labels: Iterable<Element>, matches: (text: string) => boolean): boolean {
        const sources = new Set<Element>();
        for (const label of labels) {
            if (sources.size >= 256) return true;
            sources.add(label);
        }
        for (const key of ["aria-labelledby", "aria-describedby"]) {
            const references = element.getAttribute(key) ?? "";
            if (references.length > 4096) return true;
            for (const id of references.split(/\s+/).filter(Boolean)) {
                const label = element.ownerDocument.getElementById(id);
                if (label) sources.add(label);
                if (sources.size > 256) return true;
            }
        }
        const controls = "input,textarea,select,output,[contenteditable]:not([contenteditable=false i])";
        let count = 0;
        let visibleText = "";
        let namedText = "";
        for (const label of sources) {
            if (label.matches(controls)) return true;
            const tree = document.createTreeWalker(label, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, (node) =>
                node instanceof Element && node.matches(controls) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
            );
            for (let node: Node | null = label; node; node = tree.nextNode()) {
                if (++count > 256) return true;
                if (node instanceof Text) {
                    if (namedText.length + node.length > 4096) return true;
                    visibleText += node.data;
                    namedText += node.data;
                } else if (node instanceof Element) {
                    for (const name of ["aria-label", "alt", "title"]) {
                        const hint = node.getAttribute(name);
                        if (!hint) continue;
                        if (namedText.length + hint.length + 2 > 4096 || matches(hint)) return true;
                        namedText += ` ${hint} `;
                    }
                }
            }
            if (namedText.length >= 4096) return true;
            visibleText += " ";
            namedText += " ";
        }
        return matches(visibleText) || matches(namedText);
    }
    function ordinaryControl(element: HTMLSelectElement | HTMLInputElement | HTMLTextAreaElement): boolean {
        if (element.matches(":disabled")) return false;
        const form = element.form;
        if (form) {
            const formHints = ["name", "id", "action", "aria-label"].map((key) => form.getAttribute(key)).join(" ");
            const authHint = (hint: string) =>
                /log.?in|sign.?in|sign.?up|authenticat|reset.?password|登录|注册/i.test(hint) || sensitiveHint(hint);
            if (
                authHint(formHints) ||
                riskyLabels(form, [], authHint) ||
                !(form.elements instanceof HTMLFormControlsCollection) ||
                form.querySelector("input[type=password]") ||
                Array.from(form.elements).some(
                    (control) =>
                        control instanceof HTMLInputElement &&
                        (control.type === "password" || sensitiveHint(control.autocomplete)),
                )
            )
                return false;
        }
        const hints = [
            element.autocomplete,
            element.name,
            element.id,
            element.getAttribute("aria-label"),
            element.getAttribute("placeholder"),
            element.title,
        ].join(" ");
        if (sensitiveHint(hints) || riskyLabels(element, element.labels ?? [], sensitiveHint)) return false;
        return getComputedStyle(element).getPropertyValue("-webkit-text-security") === "none";
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
        const field = event.target;
        if (!event.isTrusted || current?.mode !== "record" || !(field instanceof Element)) return;
        if (event instanceof KeyboardEvent && (event.key !== "Enter" || event.shiftKey || event.isComposing)) return;
        const previous = edits.get(field);
        if (event.type !== "input" && !edits.delete(field)) return;
        if (previous === "blocked" || !ordinaryField(field)) {
            if (event.type === "input") edits.set(field, "blocked");
            return;
        }
        const declared = field.getAttribute("veriq-record-value") === "public";
        if (event.type === "input") {
            edits.set(field, declared && previous !== "pending" ? "public" : "pending");
            return;
        }
        const { sessionId, navigation, generation } = current;
        const capture = {
            sessionId,
            navigation,
            generation,
            candidates: candidates(event),
            ...(elementRole(field) === "combobox" ? { editableCombobox: true } : {}),
        };
        if (previous !== "public" || !declared) {
            ipcRenderer.sendSync("veriq:recording-event", { ...capture, type: "fill-pending" });
            return;
        }
        const value = field.value;
        if (value.length <= 4096) ipcRenderer.sendSync("veriq:recording-event", { ...capture, value });
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
