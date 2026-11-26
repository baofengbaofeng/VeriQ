/**
 * 表单字段按标签、控件、操作提示排列。短说明直接显示，完整说明通过控件下方可聚焦的问号打开。
 * 帮助与标签分开，使浏览器使用字段名作为控件名称，帮助按钮仍有独立名称。
 */

import { Fragment, cloneElement, isValidElement, useId, type AriaAttributes, type ReactNode } from "react";
import { tx, useAppLocale } from "../locale";
import { Tooltip } from "./Tooltip";

/**
 * 使用 htmlFor 与控件 ID 建立显式标签关联，省略时由原生标签包裹控件。短提示关联可直接接收属性的子控件。
 * 传入 longHint 时以键盘或指针打开完整说明，required 在标签文案左侧显示视觉标记。
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
    const hintId = useId();
    const shortHint = longHint ? undefined : hint;
    let control = children;
    // 保留调用方已经关联的验证或状态说明，新增的短提示与它们一起作为控件描述播报，不进入可访问名称。
    if (shortHint && isValidElement<Pick<AriaAttributes, "aria-describedby">>(children) && children.type !== Fragment) {
        const describedBy = children.props["aria-describedby"];
        control = cloneElement(children, { "aria-describedby": describedBy ? `${describedBy} ${hintId}` : hintId });
    }
    const caption = (
        <span className="vq-field-label">
            {required ? (
                <span className="vq-field-required" aria-hidden="true">
                    *
                </span>
            ) : null}
            <span>{label}</span>
        </span>
    );
    return (
        <div className="vq-field">
            <label htmlFor={htmlFor} className={htmlFor ? undefined : "vq-field-implicit"}>
                {caption}
                {htmlFor ? null : control}
            </label>
            {htmlFor ? control : null}
            {shortHint ? (
                <span id={hintId} className="vq-field-hint">
                    {shortHint}
                </span>
            ) : null}
            {longHint ? (
                <Tooltip side="bottom" content={<span className="vq-field-help-text">{longHint}</span>}>
                    <button type="button" className="vq-hint-icon">
                        <span className="vq-visually-hidden">
                            {tx("Help for")} {label}
                        </span>
                        <span aria-hidden="true">?</span>
                    </button>
                </Tooltip>
            ) : null}
        </div>
    );
}
