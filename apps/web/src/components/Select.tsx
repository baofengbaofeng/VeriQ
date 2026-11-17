/**
 * Select 组件基于 Radix Select 提供可访问的下拉选择：触发器、弹层与选项均保留键盘方向键、屏幕阅读器和焦点管理语义。用于
 * 表单下拉与后续把语言切换等原生 select 迁移到统一组件库；样式类统一使用 vq-select 前缀。
 */

import type { ReactNode } from "react";
import * as SelectPrimitive from "@radix-ui/react-select";

/**
 * Select 公开属性：受控 value/onValueChange，placeholder 为未选占位，children 为若干 SelectItem。
 */
export function Select({
    value,
    onValueChange,
    placeholder,
    children,
    id,
    "aria-label": ariaLabel,
    disabled,
}: {
    value: string;
    onValueChange: (value: string) => void;
    placeholder?: string;
    children: ReactNode;
    id?: string;
    "aria-label"?: string;
    disabled?: boolean;
}) {
    return (
        <SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={disabled}>
            <SelectPrimitive.Trigger className="vq-select-trigger" id={id} aria-label={ariaLabel}>
                <SelectPrimitive.Value placeholder={placeholder} />
                <SelectPrimitive.Icon className="vq-select-icon" aria-hidden="true">
                    ▾
                </SelectPrimitive.Icon>
            </SelectPrimitive.Trigger>
            <SelectPrimitive.Portal>
                <SelectPrimitive.Content className="vq-select-content" position="popper" sideOffset={4}>
                    <SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport>
                </SelectPrimitive.Content>
            </SelectPrimitive.Portal>
        </SelectPrimitive.Root>
    );
}

/**
 * 单个选项：value 为提交值，children 为展示文本；禁用的选项由 disabled 控制且不可聚焦。
 */
export function SelectItem({ value, children, disabled }: { value: string; children: ReactNode; disabled?: boolean }) {
    return (
        <SelectPrimitive.Item className="vq-select-item" value={value} disabled={disabled}>
            <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
        </SelectPrimitive.Item>
    );
}
