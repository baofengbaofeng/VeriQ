/**
 * 右推窗（Sheet）基于 Radix Dialog 实现从右侧滑出的抽屉面板，用于承载需要较大编辑空间的交互，避免窄弹窗挤压内容。标题与
 * 描述参与无障碍名称计算，关闭按钮与遮罩沿用 Radix 的焦点圈定和 Escape 语义。非全宽档位可通过左缘拖拽手柄调整宽度。
 */

import { useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode, type RefObject } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { tx, useAppLocale } from "../locale";

const MIN_SHEET_WIDTH = 300;
const MAX_SHEET_WIDTH_PCT = 0.8;

/**
 * Sheet 公开属性：open/onOpenChange 控制显隐，title 必填作为无障碍名称，description 可选描述，children 为抽屉正文，size
 * 决定抽屉宽度档位（default 为常规窄抽屉，wide 为承载编辑器的大抽屉）。面板固定从右侧进入，宽度由全局样式控制。
 * resizable 为真时在左缘显示拖拽手柄，用户可横向调整抽屉宽度（不适用于 full 档位）。
 */
export function Sheet({
    open,
    onOpenChange,
    title,
    description,
    fallbackFocus,
    headerAction,
    children,
    size = "default",
    resizable = false,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description?: string;
    fallbackFocus?: RefObject<HTMLElement>;
    headerAction?: ReactNode;
    children: ReactNode;
    size?: "default" | "wide" | "third" | "full";
    resizable?: boolean;
}) {
    useAppLocale();
    const wasOpen = useRef(false);
    const opener = useRef<HTMLElement | null>(null);
    const contentRef = useRef<HTMLDivElement | null>(null);
    const [width, setWidth] = useState<number | null>(null);
    const drag = useRef<{ startX: number; startWidth: number } | null>(null);
    useLayoutEffect(() => {
        // 仅在受控状态真正打开时保存入口，早于 Portal 内的自动聚焦；严格模式重放不得用抽屉控件覆盖原节点。
        if (open && !wasOpen.current) {
            opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }
        wasOpen.current = open;
    }, [open]);

    const onResizeStart = (event: PointerEvent<HTMLDivElement>) => {
        const rect = contentRef.current?.getBoundingClientRect();
        if (!rect) return;
        drag.current = { startX: event.clientX, startWidth: rect.width };
        event.currentTarget.setPointerCapture(event.pointerId);
    };
    const onResizeMove = (event: PointerEvent<HTMLDivElement>) => {
        if (!drag.current) return;
        const maxWidth = window.innerWidth * MAX_SHEET_WIDTH_PCT;
        const next = drag.current.startWidth + (drag.current.startX - event.clientX);
        setWidth(Math.min(maxWidth, Math.max(MIN_SHEET_WIDTH, next)));
    };
    const onResizeEnd = (event: PointerEvent<HTMLDivElement>) => {
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    };

    return (
        <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
            <DialogPrimitive.Portal>
                <DialogPrimitive.Overlay className="vq-sheet-overlay" />
                <DialogPrimitive.Content
                    ref={contentRef}
                    className={`vq-sheet${
                        size === "wide"
                            ? " vq-sheet-wide"
                            : size === "third"
                              ? " vq-sheet-third"
                              : size === "full"
                                ? " vq-sheet-full"
                                : ""
                    }`}
                    style={resizable && width !== null ? { width: `${width}px` } : undefined}
                    onCloseAutoFocus={(event) => {
                        // 焦点作用域在严格模式下也会模拟卸载；仍打开时不能抢焦点，跨空间卸载也不返回旧入口。
                        event.preventDefault();
                        if (wasOpen.current) return;
                        const target = opener.current;
                        opener.current = null;
                        // 新建表单在提交后离开主区，打开时浏览器可能已经把焦点还给文档，此时采用列表提供的入口。
                        const destination =
                            target?.isConnected && target !== document.body ? target : fallbackFocus?.current;
                        destination?.focus({ preventScroll: true });
                    }}
                >
                    {resizable && size !== "full" && (
                        <div
                            className="vq-sheet-resizer"
                            aria-hidden="true"
                            onPointerDown={onResizeStart}
                            onPointerMove={onResizeMove}
                            onPointerUp={onResizeEnd}
                        />
                    )}
                    <div className="vq-sheet-header">
                        <div className="vq-sheet-heading">
                            <DialogPrimitive.Title className="vq-sheet-title">{title}</DialogPrimitive.Title>
                            {headerAction}
                        </div>
                        <DialogPrimitive.Close className="vq-sheet-close" aria-label={tx("Close")}>
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
