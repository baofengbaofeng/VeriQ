/**
 * 本文件提供 VeriQ 共享 UI 基元：语气按钮、确认对话框与分区标题：操作文案保持中英对照，供调用方理解 cva 路径。
 */

import { forwardRef, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
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
 * 需要切换到结果弹窗时可延迟到焦点归还给触发器之后执行，其它调用保留原时序。
 */
export function ConfirmDialog({
    title,
    children,
    trigger,
    onConfirm,
    triggerClassName,
    confirmClassName,
    disabled,
    confirmAfterClose = false,
    cancelLabel = "取消 / Cancel",
    confirmLabel = "确认 / Confirm",
}: {
    title: string;
    children: ReactNode;
    trigger: string;
    onConfirm: (trigger: HTMLButtonElement | null) => void;
    triggerClassName?: string;
    confirmClassName?: string;
    disabled?: boolean;
    confirmAfterClose?: boolean;
    cancelLabel?: string;
    confirmLabel?: string;
}) {
    const triggerButton = useRef<HTMLButtonElement>(null);
    const pendingConfirmation = useRef(false);
    return (
        <Dialog.Root>
            <Dialog.Trigger asChild>
                <Button ref={triggerButton} tone="secondary" className={triggerClassName} disabled={disabled}>
                    {trigger}
                </Button>
            </Dialog.Trigger>
            <Dialog.Portal>
                <Dialog.Overlay className="vq-overlay" />
                <Dialog.Content
                    className="vq-dialog"
                    onCloseAutoFocus={(event) => {
                        if (!pendingConfirmation.current) return;
                        pendingConfirmation.current = false;
                        const button = triggerButton.current;
                        if (!button?.isConnected || button.disabled) return;
                        event.preventDefault();
                        button.focus({ preventScroll: true });
                        onConfirm(button);
                    }}
                >
                    <Dialog.Title>{title}</Dialog.Title>
                    <Dialog.Description asChild>
                        <div>{children}</div>
                    </Dialog.Description>
                    <div className="vq-actions">
                        <Dialog.Close asChild>
                            <Button tone="secondary">{cancelLabel}</Button>
                        </Dialog.Close>
                        <Dialog.Close asChild>
                            <Button
                                className={confirmClassName}
                                onClick={() => {
                                    if (confirmAfterClose) pendingConfirmation.current = true;
                                    else onConfirm(triggerButton.current);
                                }}
                            >
                                {confirmLabel}
                            </Button>
                        </Dialog.Close>
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
/**
 * 统一的页面分区容器先用三级标题呈现区块名称，再渲染调用方提供的内容，使各功能页保持一致的结构。
 */
export function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="vq-section">
            <h3>{title}</h3>
            {children}
        </section>
    );
}
