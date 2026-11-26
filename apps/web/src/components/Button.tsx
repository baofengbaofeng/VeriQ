/**
 * 全站按钮基元通过 class-variance-authority 集中管理语气与尺寸，供独立表单和密集表格选择各自的操作规格。
 * 默认 type=button，防止在表单里误提交；样式统一使用 vq-btn 前缀，与共享包的按钮类区分。
 */

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";

/**
 * 语气描述操作的优先级或风险，尺寸描述实际点击区域。只有显式传入尺寸时才添加尺寸类，保留现有入口的布局。
 */
const button = cva("vq-btn", {
    variants: {
        tone: {
            primary: "vq-btn-primary",
            secondary: "vq-btn-secondary",
            danger: "vq-btn-danger",
            ghost: "vq-btn-ghost",
        },
        size: {
            compact: "vq-btn-compact",
            regular: "vq-btn-regular",
        },
    },
    defaultVariants: { tone: "primary" },
});

/**
 * 按钮组件保留原生按钮属性，额外接受 tone 语气与 size 尺寸。紧凑档用于行操作，常规档用于表单或工具栏。
 */
export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof button>;

/**
 * 按钮默认具有主要语气，不会提交所属表单。原生类型、禁用状态和 ref 透传给实际按钮，保留键盘焦点行为。
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
    ({ tone, size, className, type = "button", ...props }, ref) => (
        <button ref={ref} type={type} className={button({ tone, size, className })} {...props} />
    ),
);
Button.displayName = "Button";
