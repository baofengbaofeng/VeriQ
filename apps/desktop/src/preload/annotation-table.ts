import type { RecordingTable } from "../shared/recording";

type DataElement = HTMLTableElement | HTMLUListElement | HTMLOListElement;

const editable =
    "[contenteditable]:not([contenteditable=false i]), [role~=textbox], [role~=searchbox], [role~=combobox]";
const interactive = [
    "input, textarea, select, button, label, a[href], area[href], summary, [tabindex]:not([tabindex='-1'])",
    editable,
    ...[
        "button",
        "link",
        "textbox",
        "searchbox",
        "combobox",
        "listbox",
        "checkbox",
        "radio",
        "switch",
        "tab",
        "option",
        "menuitem",
        "menuitemcheckbox",
        "menuitemradio",
        "slider",
        "spinbutton",
        "treeitem",
    ].map((role) => `[role~="${role}"]`),
].join(",");
const hidden = "[hidden], [inert], [aria-hidden=true i]";
const omitText = [
    hidden,
    "script, style, template, noscript, input, textarea, select, datalist, button, output, form, iframe, object, embed",
    editable,
].join(",");

function shown(element: Element): boolean {
    return element.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && !element.closest(hidden);
}

export function findDataElement(element: Element): DataElement | undefined {
    if (element.closest(interactive) || element.closest("form")?.querySelector("input[type=password]")) return;
    const data = element.closest("table, ul, ol");
    if (
        (data instanceof HTMLTableElement || data instanceof HTMLUListElement || data instanceof HTMLOListElement) &&
        element.isConnected &&
        shown(element) &&
        shown(data)
    )
        return data;
}

/**
 * 仅遍历当前单元格或列表项。表单控件的值、不可见文本与内层列表均不属于该项，
 * 遇到不规则或超长的数据时拒绝整次提取，避免把截断内容交给数据集编辑器。
 */
function visibleText(root: HTMLElement): string | null {
    if (root.closest(editable)) return "";
    const parts: string[] = [];
    let length = 0;
    function append(value: string) {
        const normalized = value.replace(/\s+/gu, " ");
        const previous = parts.at(-1);
        const next = !previous || previous.endsWith(" ") ? normalized.trimStart() : normalized;
        if (next) {
            parts.push(next);
            length += next.length;
        }
    }

    function visit(node: Node, depth: number): boolean {
        if (length > 257 || depth > 128) return false;
        if (node instanceof Text) {
            const range = document.createRange();
            range.selectNodeContents(node);
            if (Array.from(range.getClientRects()).some((rect) => rect.height > 0 && rect.width > 0)) append(node.data);
            return true;
        }
        if (!(node instanceof Element) || node.matches(omitText)) return true;
        const style = getComputedStyle(node);
        if (style.display !== "contents" && !shown(node)) return true;
        if (node instanceof HTMLElement && style.display !== "inline") {
            const clippedX = ["hidden", "clip"].includes(style.overflowX);
            const clippedY = ["hidden", "clip"].includes(style.overflowY);
            if ((clippedX && !node.clientWidth) || (clippedY && !node.clientHeight)) return true;
            if (
                (clippedX && node.scrollWidth > node.clientWidth) ||
                (clippedY && node.scrollHeight > node.clientHeight)
            )
                return false;
        }
        if (style.clipPath !== "none" || style.clip !== "auto" || style.contentVisibility === "hidden") return true;
        if (node.matches("table, ul, ol")) return root instanceof HTMLLIElement;
        if (node instanceof HTMLBRElement) {
            append(" ");
            return true;
        }
        const block = !style.display.startsWith("inline") && style.display !== "contents";
        if (block) append(" ");
        const ink = style.getPropertyValue("-webkit-text-fill-color");
        const masked = style.getPropertyValue("-webkit-text-security") !== "none";
        const transparent = (ink.startsWith("rgba(") && ink.endsWith(", 0)")) || ink.endsWith(" / 0)");
        for (const child of node.childNodes) {
            if (child instanceof Text && (masked || transparent)) continue;
            if (!visit(child, depth + 1)) return false;
        }
        if (block) append(" ");
        return true;
    }
    if (!visit(root, 0)) return null;
    const text = parts.join("").trimEnd();
    return text.length <= 256 ? text : null;
}

export function readDataElement(element: DataElement): RecordingTable | null {
    if (findDataElement(element) !== element) return null;
    const rows: string[][] = [];
    if (!(element instanceof HTMLTableElement)) {
        for (const item of element.children) {
            if (!(item instanceof HTMLLIElement) || !shown(item)) continue;
            if (rows.length === 200) return null;
            const text = visibleText(item);
            if (text === null) return null;
            rows.push([text]);
        }
        return rows.length ? { columns: ["value"], rows } : null;
    }

    let columns: string[] | undefined;
    let positions: number[] | undefined;
    for (const row of element.rows) {
        if (!shown(row)) continue;
        const cells = Array.from(row.cells).filter(shown);
        if (!cells.length) continue;
        if (cells.length > 12 || cells.some((cell) => cell.colSpan !== 1 || cell.rowSpan !== 1)) return null;
        positions ??= cells.map((cell) => cell.cellIndex);
        const reference = positions;
        if (reference.length !== cells.length || cells.some((cell, i) => cell.cellIndex !== reference[i])) return null;
        const values: string[] = [];
        for (const cell of cells) {
            const text = visibleText(cell);
            if (text === null) return null;
            values.push(text);
        }
        const heading = row.parentElement === element.tHead;
        if (heading && columns) return null;
        if (
            !columns &&
            (heading || cells.every((cell) => cell.matches("th:not([scope=row i]):not([scope=rowgroup i])")))
        ) {
            columns = values;
            continue;
        }
        columns ??= values.map((_, index) => `column${index + 1}`);
        if (rows.length === 200) return null;
        rows.push(values);
    }
    return columns && rows.length ? { columns, rows } : null;
}
