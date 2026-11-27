import { ipcRenderer } from "electron";
import type { RecordingArm, RecordingCandidate } from "../shared/recording";

function elementRole(element: Element): string | undefined {
    const explicit = element.getAttribute("role")?.trim().split(/\s+/, 1)[0];
    if (explicit) return explicit;
    if (element.matches("button, summary, input:is([type=button],[type=submit],[type=reset],[type=image])"))
        return "button";
    if (element.matches("a[href], area[href]")) return "link";
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
    "listbox",
    "menuitem",
    "radio",
    "searchbox",
    "switch",
    "tab",
    "textbox",
]);

function candidates(event: Event): RecordingCandidate[] {
    const elements = event.composedPath().filter((target): target is Element => target instanceof Element);
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
 * 被测页面没有公开的 contextBridge。只在可信手势期间读有限定位字段，避免读取 DOM 文本、表单值、Cookie 与网络数据。
 * 页面脚本派发的事件不会成为录制步骤；标注时在捕获阶段拦截业务激活，记录时放行真实点击。
 */
if (process.isMainFrame) {
    let current: RecordingArm | undefined;
    ipcRenderer.on("veriq:recording-arm", (_event, next: RecordingArm | undefined) => {
        current = next;
        if (next) {
            const { sessionId, navigation, generation } = next;
            ipcRenderer.send("veriq:recording-arm-ack", { sessionId, navigation, generation });
        }
    });
    const handle = (event: Event) => {
        if (!event.isTrusted || !current || current.mode === "paused") return;
        const { sessionId, navigation, mode, generation } = current;
        if (mode === "annotate") {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
        if (
            event.type === (mode === "annotate" ? "pointerdown" : "click") &&
            event instanceof MouseEvent &&
            event.button === 0
        )
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
