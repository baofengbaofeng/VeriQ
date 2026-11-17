/**
 * 右推窗（Sheet）基于 Radix Dialog 实现从右侧滑出的抽屉面板，用于承载需要较大编辑空间的交互，避免窄弹窗挤压内容。标题与
 * 描述参与无障碍名称计算，关闭按钮与遮罩沿用 Radix 的焦点圈定和 Escape 语义。
 */

import type { ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";

/**
 * Sheet 公开属性：open/onOpenChange 控制显隐，title 必填作为无障碍名称，description 可选描述，children 为抽屉正文。面板
 * 固定从右侧进入，宽度由全局样式控制。
 */
export function Sheet({
    open,
    onOpenChange,
    title,
    description,
    children,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description?: string;
    children: ReactNode;
}) {
    return (
        <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
            <DialogPrimitive.Portal>
                <DialogPrimitive.Overlay className="vq-sheet-overlay" />
                <DialogPrimitive.Content className="vq-sheet">
                    <div className="vq-sheet-header">
                        <DialogPrimitive.Title className="vq-sheet-title">{title}</DialogPrimitive.Title>
                        <DialogPrimitive.Close className="vq-sheet-close" aria-label="Close">
                            ×
                        </DialogPrimitive.Close>
                    </div>
                    {description ? (
                        <DialogPrimitive.Description className="vq-sheet-desc">
                            {description}
                        </DialogPrimitive.Description>
                    ) : null}
                    <div className="vq-sheet-body">{children}</div>
                </DialogPrimitive.Content>
            </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
    );
}
