/**
 * 文本输入基元统一原生 input 的边框、内边距与焦点样式，供表单与工具栏复用。保留原生语义以便浏览器校验、自动完成和辅助技
 * 术读取，组件只追加视觉类名而不重建输入行为。
 */

import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";

/**
 * 拼接组件类名与调用方额外类名，去除空值后输出单一字符串，避免 undefined 进入 class 属性。
 */
function joinClass(base: string, extra?: string): string {
    return extra ? `${base} ${extra}` : base;
}

/**
 * 单行文本输入，透传全部原生 input 属性并强制附加 vq-input 基础类。
 */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
    ({ className, ...props }, ref) => <input ref={ref} className={joinClass("vq-input", className)} {...props} />,
);
Input.displayName = "Input";

/**
 * 多行文本输入，透传全部原生 textarea 属性并强制附加 vq-input vq-textarea 基础类。
 */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
    ({ className, ...props }, ref) => (
        <textarea ref={ref} className={joinClass("vq-input vq-textarea", className)} {...props} />
    ),
);
Textarea.displayName = "Textarea";
