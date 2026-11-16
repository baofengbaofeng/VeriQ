/**
 * 本文件提供 VeriQ 共享 UI 基元：语气按钮、确认对话框与分区标题：操作文案保持中英对照，供调用方理解 cva 路径。
 */

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { cva } from "class-variance-authority";
const button = cva("vq-button", {
    variants: {
        tone: {
            primary: "vq-primary",
            secondary: "vq-secondary",
            danger: "vq-danger",
        },
    },
    defaultVariants: { tone: "primary" },
});
/**
 * 公开组件 Button 提供 primary/secondary/danger 语气的按钮基元：默认 type=button。样式由 cva 变体生成。
 */
export const Button = forwardRef<
    HTMLButtonElement,
    ButtonHTMLAttributes<HTMLButtonElement> & {
        tone?: "primary" | "secondary" | "danger";
    }
>(({ tone, className, type = "button", ...props }, ref) => (
    <button ref={ref} type={type} className={button({ tone, className })} {...props} />
));
/**
 * 共享确认对话框保留 Radix 的焦点管理与键盘关闭语义，调用方可按当前语言提供按钮文案，未指定时沿用既有双语默认值，
 * 避免桌面旧入口因语言接入而改变确认动作或丢失取消路径。
 */
export function ConfirmDialog({
    title,
    children,
    trigger,
    onConfirm,
    cancelLabel = "取消 / Cancel",
    confirmLabel = "确认 / Confirm",
}: {
    title: string;
    children: ReactNode;
    trigger: string;
    onConfirm: () => void;
    cancelLabel?: string;
    confirmLabel?: string;
}) {
    return (
        <Dialog.Root>
            <Dialog.Trigger asChild>
                <Button tone="secondary">{trigger}</Button>
            </Dialog.Trigger>
            <Dialog.Portal>
                <Dialog.Overlay className="vq-overlay" />
                <Dialog.Content className="vq-dialog">
                    <Dialog.Title>{title}</Dialog.Title>
                    <Dialog.Description asChild>
                        <div>{children}</div>
                    </Dialog.Description>
                    <div className="vq-actions">
                        <Dialog.Close asChild>
                            <Button tone="secondary">{cancelLabel}</Button>
                        </Dialog.Close>
                        <Dialog.Close asChild>
                            <Button onClick={onConfirm}>{confirmLabel}</Button>
                        </Dialog.Close>
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
/**
 * 公开组件 Section 渲染带标题的页面分区：可选 data-testid：供各功能页统一区块结构（Section）。
 */
export function Section({
    title,
    children,
    testId,
}: {
    title: string;
    children: ReactNode;
    testId?: string;
}) {
    return (
        <section className="vq-section" data-testid={testId}>
            <h3>{title}</h3>
            {children}
        </section>
    );
}
