/**
 * 用 marked 把 Markdown 解析为 HTML，再经 DOMPurify 清理后注入；模型与员工正文始终视为不可信，禁止内联脚本与事件属性。
 * memo 让已完成的旧消息在流式更新时不会重复解析。
 */
import { memo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

export const Markdown = memo(function Markdown({ children }: { children: string }) {
    const html = DOMPurify.sanitize(marked.parse(children, { async: false }) as string);
    // biome-ignore lint/security/noDangerouslySetInnerHtml: content is sanitized by DOMPurify before injection
    return <div className="vq-agent-md" dangerouslySetInnerHTML={{ __html: html }} />;
});
