/**
 * 工作区列表的单值筛选共用成员页的行内标签、紧凑触发器和跨层菜单，避免不同标签页各自维护筛选尺寸。
 */
import { useId } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Button, Field } from "../../components";

/**
 * 调用方持有筛选值和翻译后的选项。可见标签标识筛选类别，当前选择通过按钮文字和可访问描述同步更新。
 */
export function ChoiceFilter({
    label,
    value,
    onChange,
    choices,
    disabled,
}: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    choices: readonly (readonly [string, string])[];
    disabled?: boolean;
}) {
    const id = useId();
    const summaryId = `${id}-value`;
    const active = (choices.find(([item]) => item === value) ?? choices[0])?.[1] ?? label;
    return (
        <div className="vq-workspace-filter">
            <Field label={label} htmlFor={id}>
                <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                        <Button
                            id={id}
                            size="compact"
                            tone="secondary"
                            disabled={disabled}
                            aria-describedby={summaryId}
                        >
                            <span id={summaryId}>{active}</span>
                            <FilterChevron />
                        </Button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                        <DropdownMenu.Content
                            className="vq-dropdown vq-workspace-filter-menu"
                            align="start"
                            sideOffset={4}
                            collisionPadding={8}
                        >
                            <DropdownMenu.RadioGroup value={value} onValueChange={onChange}>
                                {choices.map(([item, option]) => (
                                    <DropdownMenu.RadioItem key={item} value={item} className="vq-dropdown-item">
                                        {option}
                                        <DropdownMenu.ItemIndicator className="vq-dropdown-check">
                                            <svg
                                                aria-hidden="true"
                                                width="14"
                                                height="14"
                                                viewBox="0 0 14 14"
                                                fill="none"
                                            >
                                                <path
                                                    d="m3 7.5 2.5 2.5L11 4.5"
                                                    stroke="currentColor"
                                                    strokeWidth="1.5"
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                />
                                            </svg>
                                        </DropdownMenu.ItemIndicator>
                                    </DropdownMenu.RadioItem>
                                ))}
                            </DropdownMenu.RadioGroup>
                        </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                </DropdownMenu.Root>
            </Field>
        </div>
    );
}

/**
 * 单选和多选筛选使用相同尺寸的箭头，图标不参与按钮名称计算，避免读屏重复朗读可展开的信息。
 */
export function FilterChevron() {
    return (
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
    );
}
