/**
 * Select 组件基于 Radix Select 提供可访问的下拉选择：触发器、弹层与选项均保留键盘方向键、屏幕阅读器和焦点管理语义。用于
 * 表单下拉与后续把语言切换等原生 select 迁移到统一组件库；样式类统一使用 vq-select 前缀。
 */

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import icons from "../admin-icons.svg?no-inline";

/**
 * 受控下拉将必填要求传给 Radix，并让触发器保留调用方提供的标签、字段说明以及管理台菜单外观。
 * 嵌入抽屉的菜单可先消费自身的退出键事件，让外层对话框保留焦点和未保存草稿。
 */
export function Select({
    value,
    onValueChange,
    placeholder,
    children,
    id,
    "aria-label": ariaLabel,
    "aria-describedby": ariaDescribedBy,
    appearance,
    size,
    contentClassName,
    disabled,
    required,
    escapeClosesSelectOnly,
}: {
    value: string;
    onValueChange: (value: string) => void;
    placeholder?: string;
    children: ReactNode;
    id?: string;
    "aria-label"?: string;
    "aria-describedby"?: string;
    appearance?: "default-dropdown";
    size?: "compact";
    contentClassName?: string;
    disabled?: boolean;
    required?: boolean;
    escapeClosesSelectOnly?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const trigger = useRef<HTMLButtonElement>(null);
    const content = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        const button = trigger.current;
        const view = button?.ownerDocument.defaultView;
        if (!escapeClosesSelectOnly || !open || !view) return;
        // 在 Radix 的文档捕获监听器之前消费归属当前菜单的退出键，关闭后仍由 Radix 把焦点还给触发按钮。
        function closeSelect(event: KeyboardEvent) {
            const target = event.target;
            if (event.key !== "Escape" || !(target instanceof Node)) return;
            if (target !== button && !content.current?.contains(target)) return;
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
        }
        view.addEventListener("keydown", closeSelect, true);
        return () => view.removeEventListener("keydown", closeSelect, true);
    }, [escapeClosesSelectOnly, open]);
    const surfaceClasses = ["vq-select-content", appearance === "default-dropdown" && "vq-dropdown", contentClassName];
    return (
        <SelectPrimitive.Root
            value={value}
            onValueChange={onValueChange}
            disabled={disabled}
            required={required}
            open={escapeClosesSelectOnly ? open : undefined}
            onOpenChange={escapeClosesSelectOnly ? setOpen : undefined}
        >
            <SelectPrimitive.Trigger
                ref={trigger}
                className="vq-select-trigger"
                data-appearance={appearance}
                data-size={size}
                id={id}
                aria-label={ariaLabel}
                aria-describedby={ariaDescribedBy}
            >
                <SelectPrimitive.Value placeholder={placeholder} />
                <SelectPrimitive.Icon className="vq-select-icon" aria-hidden="true">
                    ▾
                </SelectPrimitive.Icon>
            </SelectPrimitive.Trigger>
            <SelectPrimitive.Portal>
                <SelectPrimitive.Content
                    ref={content}
                    className={surfaceClasses.filter(Boolean).join(" ")}
                    data-appearance={appearance}
                    data-size={size}
                    position="popper"
                    sideOffset={4}
                >
                    <SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport>
                </SelectPrimitive.Content>
            </SelectPrimitive.Portal>
        </SelectPrimitive.Root>
    );
}

/**
 * 单个选项沿用 Radix 的选择和禁用语义，对勾独立于选项文本，使触发器显示选值时只复制对应的文本。
 */
export function SelectItem({ value, children, disabled }: { value: string; children: ReactNode; disabled?: boolean }) {
    return (
        <SelectPrimitive.Item className="vq-select-item" value={value} disabled={disabled}>
            <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
            <SelectPrimitive.ItemIndicator className="vq-dropdown-check" aria-hidden="true">
                <svg width="16" height="16" aria-hidden="true">
                    <use href={`${icons}#check`} />
                </svg>
            </SelectPrimitive.ItemIndicator>
        </SelectPrimitive.Item>
    );
}
