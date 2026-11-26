/**
 * 提示气泡基于 Radix Tooltip 提供可访问的悬停/聚焦说明：触发器保留真实子元素，气泡经 Portal 渲染以避免被容器裁剪。用于
 * 长文案操作提示的「?」图标，短提示则直接内联展示，不经过本组件。
 */

import type { ReactNode } from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

/**
 * Tooltip 公开属性：content 为提示正文，children 为触发器，side 控制气泡相对触发器的出现
 * 方向，默认顶部。delayDuration 保持默认值，避免误触时频繁弹出。
 */
export function Tooltip({
    content,
    children,
    side = "top",
}: {
    content: ReactNode;
    children: ReactNode;
    side?: "top" | "right" | "bottom" | "left";
}) {
    return (
        <TooltipPrimitive.Provider>
            <TooltipPrimitive.Root>
                <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
                <TooltipPrimitive.Portal>
                    <TooltipPrimitive.Content className="vq-tooltip" side={side} sideOffset={6}>
                        {content}
                        <TooltipPrimitive.Arrow className="vq-tooltip-arrow" />
                    </TooltipPrimitive.Content>
                </TooltipPrimitive.Portal>
            </TooltipPrimitive.Root>
        </TooltipPrimitive.Provider>
    );
}
