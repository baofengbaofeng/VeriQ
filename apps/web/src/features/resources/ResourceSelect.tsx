/**
 * 资源选值控件复用管理台下拉样式和键盘交互，清空时仍向草稿或表单传回原有空值，不改变契约字段的取值范围。
 */

import { useId, type ComponentProps, type ReactNode } from "react";
import { Field, Select, SelectItem } from "../../components";

const optionPrefix = "value:";

/**
 * 所有选项编码在同一命名空间内，空选项也有可选择的内部值，避免与用户输入的任意资源标识发生冲突。
 */
export function ResourceSelect({
    value,
    onValueChange,
    placeholder,
    ...props
}: Omit<ComponentProps<typeof Select>, "appearance" | "escapeClosesSelectOnly">) {
    return (
        <Select
            {...props}
            appearance="default-dropdown"
            escapeClosesSelectOnly
            value={value || !placeholder ? optionPrefix + value : ""}
            placeholder={placeholder}
            onValueChange={(selection) => onValueChange(selection.slice(optionPrefix.length))}
        />
    );
}

/**
 * 选项只把内部前缀传给 Radix，原有展示标签和禁用语义分别保留，因此缺失引用仍可以按旧值回显。
 */
export function ResourceSelectItem({ value, ...props }: ComponentProps<typeof SelectItem>) {
    return <SelectItem {...props} value={optionPrefix + value} />;
}

/**
 * 可编辑资源表单使用明确的标签和菜单触发器关联，独立重复项有自己的标识并共享必填和提示的展示方式。
 */
export function ResourceSelectField({
    label,
    hint,
    ...props
}: ComponentProps<typeof ResourceSelect> & {
    label: ReactNode;
    hint?: string;
}) {
    const id = useId();
    return (
        <Field label={label} htmlFor={id} required={props.required} hint={hint}>
            <ResourceSelect {...props} id={id} />
        </Field>
    );
}
