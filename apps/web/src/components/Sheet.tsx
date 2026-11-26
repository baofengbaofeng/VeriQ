/**
 * 右推窗（Sheet）基于 Radix Dialog 实现从右侧滑出的抽屉面板，用于承载需要较大编辑空间的交互，避免窄弹窗挤压内容。标题与
 * 描述参与无障碍名称计算，关闭按钮与遮罩沿用 Radix 的焦点圈定和 Escape 语义。非全宽档位可通过左缘拖拽手柄调整宽度。
 */

import { useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode, type RefObject } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { tx, useAppLocale } from "../locale";
import icons from "../admin-icons.svg?no-inline";

/**
 * 调用方提供初始宽度与无障碍标题，右侧抽屉负责切换全宽或三分之一宽度，并在关闭时清除本次的宽度调整。
 * 正文可用渲染函数读取全宽状态；启用 resizable 时，非全宽档位在左缘提供拖拽手柄。
 * 关闭后的回调用于在入口恢复焦点后打开后续结果框；已经卸载或重新打开的抽屉不转移焦点。
 */
export function Sheet({
    open,
    onOpenChange,
    title,
    description,
    fallbackFocus,
    onAfterClose,
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
    onAfterClose?: () => void;
    headerAction?: ReactNode;
    children: ReactNode | ((fullWidth: boolean) => ReactNode);
    size?: "default" | "wide" | "third" | "full";
    resizable?: boolean;
}) {
    useAppLocale();
    const wasOpen = useRef(false);
    const opener = useRef<HTMLElement | null>(null);
    const contentRef = useRef<HTMLDivElement | null>(null);
    const [sizeOverride, setSizeOverride] = useState<"third" | "full">();
    const [width, setWidth] = useState<number | null>(null);
    const drag = useRef<{ startX: number; startWidth: number } | null>(null);
    const currentSize = sizeOverride ?? size;
    const fullWidth = currentSize === "full";
    const canResize = resizable && !fullWidth;
    const sizeLabel = tx(fullWidth ? "One third width" : "Full width");
    useLayoutEffect(() => {
        // 仅在受控状态真正打开时保存入口，早于 Portal 内的自动聚焦；严格模式重放不得用抽屉控件覆盖原节点。
        if (open && !wasOpen.current) {
            opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }
        // 关闭时仅清除本次宽度调整，调用方再次打开时仍按最适合该表单或编辑器的宽度显示，并归还原入口焦点。
        if (!open && wasOpen.current) {
            drag.current = null;
            setWidth(null);
            setSizeOverride(undefined);
        }
        wasOpen.current = open;
    }, [open]);

    const onResizeStart = (event: PointerEvent<HTMLDivElement>) => {
        const rect = contentRef.current?.getBoundingClientRect();
        if (!rect || !event.isPrimary || event.button !== 0) return;
        drag.current = { startX: event.clientX, startWidth: rect.width };
        event.currentTarget.setPointerCapture(event.pointerId);
    };
    const onResizeMove = (event: PointerEvent<HTMLDivElement>) => {
        if (!drag.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        setWidth(drag.current.startWidth + (drag.current.startX - event.clientX));
    };
    const onResizeEnd = (event: PointerEvent<HTMLDivElement>) => {
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    };

    // 宽度范围由样式结合当前视口计算，窗口缩小时已拖动的抽屉仍留在视口内，切换档位继续清除这次调整。
    const draggedWidth =
        canResize && width !== null ? `clamp(var(--vq-sheet-min), ${width}px, var(--vq-sheet-max))` : undefined;

    return (
        <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
            <DialogPrimitive.Portal>
                <DialogPrimitive.Overlay className="vq-sheet-overlay" />
                <DialogPrimitive.Content
                    ref={contentRef}
                    className={currentSize === "default" ? "vq-sheet" : `vq-sheet vq-sheet-${currentSize}`}
                    style={{ width: draggedWidth }}
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
                        onAfterClose?.();
                    }}
                >
                    {canResize && (
                        <div
                            className="vq-sheet-resizer"
                            aria-hidden="true"
                            onPointerDown={onResizeStart}
                            onPointerMove={onResizeMove}
                            onPointerUp={onResizeEnd}
                            onPointerCancel={onResizeEnd}
                            onLostPointerCapture={() => {
                                drag.current = null;
                            }}
                        />
                    )}
                    <div className="vq-sheet-header">
                        <div className="vq-sheet-heading">
                            <DialogPrimitive.Title className="vq-sheet-title">{title}</DialogPrimitive.Title>
                            <button
                                type="button"
                                className="vq-sheet-size-toggle"
                                aria-label={sizeLabel}
                                title={sizeLabel}
                                onClick={() => {
                                    drag.current = null;
                                    setWidth(null);
                                    setSizeOverride(fullWidth ? "third" : "full");
                                }}
                            >
                                <svg aria-hidden="true" width="16" height="16">
                                    <use href={`${icons}#${fullWidth ? "minimize" : "maximize"}`} />
                                </svg>
                            </button>
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
                    <div className="vq-sheet-body">
                        {typeof children === "function" ? children(fullWidth) : children}
                    </div>
                </DialogPrimitive.Content>
            </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
    );
}
