/**
 * 表单字段组件统一「标签 + 控件 + 操作提示」的排列：短提示直接内联在标签后，长提示折叠为「?」图标并借用 Tooltip 悬停展
 * 示。提示文案由调用方传入当前语言文本，组件不做翻译，避免把领域词条塞进通用组件。
 */

import type { ReactNode } from "react";
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
    return (
        <label className="vq-field" htmlFor={htmlFor}>
            <span className="vq-field-label">
                <span>{label}</span>
                {required ? <span className="vq-field-required">*</span> : null}
                {hint && !longHint ? <span className="vq-field-hint">{hint}</span> : null}
                {longHint ? (
                    <Tooltip content={longHint}>
                        <button type="button" className="vq-hint-icon" aria-label="?" tabIndex={-1}>
                            ?
                        </button>
                    </Tooltip>
                ) : null}
            </span>
            {children}
        </label>
    );
}
