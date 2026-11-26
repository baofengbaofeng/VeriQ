/**
 * 整理模型回复的 Markdown 文本结构，只保留用户可主动打开的链接，阻止消息渲染替用户请求远程资源。
 * 已完成消息通过 memo 复用解析结果，避免每次流式更新都重新解释历史内容。
 */
import { createElement, memo, useMemo, type ReactNode } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { tx, useAppLocale } from "../../locale";
import { DataTable, useTableView } from "../../table-view";

// 会话可显示文档常用格式，元素和属性都按允许范围保留，图片、媒体以及内联样式没有自行加载资源的入口。
const TEXT_TAGS = [
    "a",
    "blockquote",
    "br",
    "code",
    "del",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "li",
    "ol",
    "p",
    "pre",
    "span",
    "strong",
    "table",
    "tbody",
    "td",
    "th",
    "thead",
    "tr",
    "ul",
];

// 允许网页、邮件及相对链接；正则只放行没有协议前缀的相对地址，拒绝其余有冒号的自定义协议。
const LINK_URI = /^(?:(?:https?|mailto):|[^a-z]|[a-z0-9+.-]+(?:[^a-z0-9+.:-]|$))/i;

/**
 * 清理后的节点仅转移许可范围内的文字和属性，消息中的链接保留主动点击路径，表格统一走可筛选的界面。
 */
function renderNode(
    node: Node,
    index: number,
    tableNumbers: ReadonlyMap<HTMLTableElement, number>,
    exportAllowed: boolean,
): ReactNode {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (!(node instanceof HTMLElement)) return null;
    if (node instanceof HTMLTableElement) {
        return <MarkdownTable key={index} table={node} tableNumbers={tableNumbers} exportAllowed={exportAllowed} />;
    }

    const tag = node.localName;
    const props = {
        key: index,
        title: node.getAttribute("title") ?? undefined,
        href: tag === "a" ? (node.getAttribute("href") ?? undefined) : undefined,
        start: tag === "ol" ? (node.getAttribute("start") ?? undefined) : undefined,
        align: tag === "th" || tag === "td" ? (node.getAttribute("align") ?? undefined) : undefined,
    };
    const children = Array.from(node.childNodes, (child, position) =>
        renderNode(child, position, tableNumbers, exportAllowed),
    );
    return createElement(tag, props, ...children);
}

/**
 * 以消息里的原生表头和单元格取出展示值，按原记录次序分页。没有表头的旧消息仍保留全部行与原有内容。
 */
function MarkdownTable({
    table,
    tableNumbers,
    exportAllowed,
}: {
    table: HTMLTableElement;
    tableNumbers: ReadonlyMap<HTMLTableElement, number>;
    exportAllowed: boolean;
}) {
    useAppLocale();
    const { headers, rows, width } = useMemo(() => {
        const headers = Array.from(table.tHead?.rows ?? []);
        const rows = Array.from(table.rows).filter((row) => row.parentElement !== table.tHead);
        const width = [...headers, ...rows].reduce((maximum, row) => Math.max(maximum, row.cells.length), 1);
        return { headers, rows, width };
    }, [table]);
    const view = useTableView(rows, {
        scope: table,
        matches: (row, term) =>
            Array.from(row.cells).some((cell) => (cell.textContent ?? "").toLowerCase().includes(term)),
    });
    const names = Array.from(
        { length: width },
        (_, position) =>
            headers.at(-1)?.cells[position]?.textContent?.trim() ||
            tx("Message column {{number}}", { number: position + 1 }),
    );
    const label = tx("Message table {{number}}", { number: tableNumbers.get(table) });

    return (
        <DataTable<HTMLTableRowElement>
            label={label}
            view={view}
            searchLabel={tx("Search message table {{number}}", { number: tableNumbers.get(table) })}
            exportAllowed={exportAllowed}
            exportColumns={names.map((name, position) => ({
                label: name,
                value: (row) => row.cells[position]?.textContent,
            }))}
        >
            <div className="table-scroll">
                <table aria-label={label}>
                    <thead>
                        {headers.length ? (
                            headers.map((row) => (
                                <tr key={row.rowIndex}>
                                    {Array.from(row.cells, (cell, index) =>
                                        renderNode(cell, index, tableNumbers, exportAllowed),
                                    )}
                                </tr>
                            ))
                        ) : (
                            <tr>
                                {names.map((name) => (
                                    <th key={name} scope="col">
                                        {name}
                                    </th>
                                ))}
                            </tr>
                        )}
                    </thead>
                    <tbody>
                        {view.rows.length === 0 && (
                            <tr>
                                <td className="vq-table-empty" colSpan={width}>
                                    {tx(rows.length ? "No matching rows." : "No message table rows.")}
                                </td>
                            </tr>
                        )}
                        {view.rows.map((row) => (
                            <tr key={row.rowIndex}>
                                {Array.from(row.cells, (cell, index) =>
                                    renderNode(cell, index, tableNumbers, exportAllowed),
                                )}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </DataTable>
    );
}

/**
 * 最终消息先转成已清理的文档片段再渲染，原有段落和行内文字顺序保持不变，页码变化不会重新解析消息。
 */
export const Markdown = memo(function Markdown({
    children,
    exportAllowed = true,
}: {
    children: string;
    exportAllowed?: boolean;
}) {
    const fragment = DOMPurify.sanitize(marked.parse(children, { async: false }) as string, {
        ALLOWED_TAGS: TEXT_TAGS,
        ALLOWED_ATTR: ["href", "title", "align", "start"],
        ALLOW_ARIA_ATTR: false,
        ALLOW_DATA_ATTR: false,
        ALLOWED_URI_REGEXP: LINK_URI,
        RETURN_DOM_FRAGMENT: true,
    });
    const tableNumbers = new Map(Array.from(fragment.querySelectorAll("table"), (table, index) => [table, index + 1]));
    return (
        <div className="vq-agent-md">
            {Array.from(fragment.childNodes, (node, index) => renderNode(node, index, tableNumbers, exportAllowed))}
        </div>
    );
});
