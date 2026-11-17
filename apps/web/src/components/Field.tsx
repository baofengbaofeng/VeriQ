/**
 * 表单字段组件统一「标签 + 控件 + 操作提示」的排列：短提示直接内联在标签后，长提示折叠为「?」图标并借用 Tooltip 悬停展
 * 示。领域建议由调用方提供，组件只翻译通用帮助前缀，完整内容保留在聚焦后出现的提示中。
 */

import type { ReactNode } from "react";
import { tx, useAppLocale } from "../locale";
import { Tooltip } from "./Tooltip";

/**
 * Field 公开属性：label 为字段名，htmlFor 关联控件 id；hint 为短提示（直接展示），longHint 为长提示（悬停气泡展示）；必
 * 填标记由 required 控制。children 放置具体控件（Input/Select/Textarea 等）。
 */
export function Field({
    label,
    htmlFor,
    hint,
    longHint,
    required,
    children,
}: {
    label: ReactNode;
    htmlFor?: string;
    hint?: string;
    longHint?: string;
    required?: boolean;
    children: ReactNode;
}) {
    useAppLocale();
    // 帮助名称来自按钮正文以区分字段标签查询，读屏仍能说明帮助对象；问号装饰不进入无障碍名称。
    return (
        <label className="vq-field" htmlFor={htmlFor}>
            <span className="vq-field-label">
                <span>{label}</span>
                {required ? (
                    <span className="vq-field-required" aria-hidden="true">
                        *
                    </span>
                ) : null}
                {hint && !longHint ? <span className="vq-field-hint">{hint}</span> : null}
                {longHint ? (
                    <Tooltip content={longHint}>
                        <button type="button" className="vq-hint-icon">
                            <span className="vq-visually-hidden">
                                {tx("Help for")} {label}
                            </span>
                            <span aria-hidden="true">?</span>
                        </button>
                    </Tooltip>
                ) : null}
            </span>
            {children}
        </label>
    );
}
