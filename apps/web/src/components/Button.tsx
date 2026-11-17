/**
 * 全站按钮基元基于 class-variance-authority 生成语气变体，把「主要/次要/危险/幽灵」四类视觉语义收敛到单一组件，避免各页
 * 面重复拼写样式类。默认 type=button，防止在表单里误触提交；样式类统一使用 vq-btn 前缀并与既有 @veriq/ui 的 vq-* 类区
 * 分开，避免选择器冲突。
 */

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";

/**
 * 语气变体映射：primary 用于主操作，secondary 用于并列次要操作，danger 用于破坏性动作，ghost 用于工具栏或菜单内的低调
 * 入口。样式实现位于全局 style.css，组件只负责稳定地输出对应类名。
 */
const button = cva("vq-btn", {
    variants: {
        tone: {
            primary: "vq-btn-primary",
            secondary: "vq-btn-secondary",
            danger: "vq-btn-danger",
            ghost: "vq-btn-ghost",
        },
    },
    defaultVariants: { tone: "primary" },
});

/**
 * 按钮组件的公开属性类型：透传全部原生按钮属性，并额外接受 tone 语气变体以切换视觉样式。
 */
export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof button>;

/**
 * 公开按钮组件：默认 type=button，其余属性与原生 button 一致。未显式传入 tone 时使用 primary，调用方无需关心 cva 内部
 * 细节即可得到一致的可聚焦、可禁用按钮。
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
    ({ tone, className, type = "button", ...props }, ref) => (
        <button ref={ref} type={type} className={button({ tone, className })} {...props} />
    ),
);
Button.displayName = "Button";
