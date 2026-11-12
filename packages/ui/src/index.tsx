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
 * 公开组件 Button 提供 primary/secondary/danger 语气的按钮基元：默认 type=button。
 * 样式由 cva 变体生成。
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
 * 公开组件 ConfirmDialog 用 Radix Dialog 实现确认/取消双按钮对话框：文案中英对照：确认后调用 onConfirm。
 */
export function ConfirmDialog({
    title,
    children,
    trigger,
    onConfirm,
}: {
    title: string;
    children: ReactNode;
    trigger: string;
    onConfirm: () => void;
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
                            <Button tone="secondary">取消 / Cancel</Button>
                        </Dialog.Close>
                        <Dialog.Close asChild>
                            <Button onClick={onConfirm}>确认 / Confirm</Button>
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
