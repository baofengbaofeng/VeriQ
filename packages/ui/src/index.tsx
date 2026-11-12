/**
 * 本文件 packages/ui/src/index.tsx 实现 VeriQ Web/共享 UI 界面能力并导出公开组件与辅助函数
 * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
 * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
 * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
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
 * 公开符号 Button（const）定义 packages/ui/src/index.tsx 对外可复用的界面或工具接口
 * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
 * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
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
 * 公开符号 ConfirmDialog（function）定义 packages/ui/src/index.tsx 对外可复用的界面或工具接口
 * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
 * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
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
