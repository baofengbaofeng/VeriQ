/**
 * 成员与邀请表将筛选归入同一个键盘菜单，业务页继续拥有已选条件、查询范围和分页重置行为。
 */
import { useId, useLayoutEffect, useRef, useState, type Ref } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import icons from "../../admin-icons.svg?no-inline";
import { Button } from "../../components";
import { tx } from "../../locale";

/**
 * 单选和多选分别保存条件，业务页提供当前语言的标签和真实查询使用的选项值，菜单只负责展示与选取。
 */
type WorkspaceFilter = {
    label: string;
    choices: readonly (readonly [string, string])[];
} & (
    | { multiple: true; value: readonly string[]; onChange: (values: string[]) => void }
    | { multiple?: false; value: string; onChange: (value: string) => void }
);

/**
 * 一张表只显示一组筛选与查看全部入口，下载仍由共享表格按当前可见范围及权限控制，不受弹出菜单影响。
 */
export function WorkspaceTableFilters({
    filters,
    onReset,
}: {
    filters: readonly WorkspaceFilter[];
    onReset: () => void;
}) {
    const [open, setOpen] = useState(false);
    const [section, setSection] = useState<string>();
    const trigger = useRef<HTMLButtonElement>(null);
    const content = useRef<HTMLDivElement>(null);
    const sectionTrigger = useRef<HTMLDivElement>(null);
    const sectionContent = useRef<HTMLDivElement>(null);
    const updateOpen = (next: boolean) => {
        setOpen(next);
        if (!next) setSection(undefined);
    };

    useLayoutEffect(() => {
        const button = trigger.current;
        const view = button?.ownerDocument.defaultView;
        if (!open || !view) return;
        /**
         * 在 Radix 的文档监听之前处理本菜单树的退出键，关闭一层并还原焦点。其它窗格的按键保持原有行为。
         */
        function closeLevel(event: KeyboardEvent) {
            const { target } = event;
            if (event.key !== "Escape" || !(target instanceof Node)) return;
            const withinMenu = content.current?.contains(target) || sectionContent.current?.contains(target);
            if (target !== button && !withinMenu) return;
            event.preventDefault();
            event.stopPropagation();
            if (section) {
                setSection(undefined);
                sectionTrigger.current?.focus();
            } else {
                setOpen(false);
            }
        }
        view.addEventListener("keydown", closeLevel, true);
        return () => view.removeEventListener("keydown", closeLevel, true);
    }, [open, section]);

    return (
        <>
            <DropdownMenu.Root open={open} onOpenChange={updateOpen}>
                <DropdownMenu.Trigger asChild>
                    <Button ref={trigger} size="regular" tone="secondary" className="vq-workspace-table-tool">
                        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
                            <path
                                d="M2 4.5h12M4.5 8h7M6.5 11.5h3"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                            />
                        </svg>
                        {tx("Filter")}
                    </Button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                    <DropdownMenu.Content
                        ref={content}
                        align="end"
                        sideOffset={4}
                        collisionPadding={8}
                        className="vq-dropdown vq-workspace-table-filter-menu"
                    >
                        {filters.map((filter) => {
                            const active = section === filter.label;
                            return (
                                <FilterSection
                                    key={filter.label}
                                    filter={filter}
                                    open={active}
                                    onOpenChange={(next) =>
                                        setSection((current) =>
                                            next ? filter.label : current === filter.label ? undefined : current,
                                        )
                                    }
                                    triggerRef={active ? sectionTrigger : undefined}
                                    contentRef={active ? sectionContent : undefined}
                                />
                            );
                        })}
                    </DropdownMenu.Content>
                </DropdownMenu.Portal>
            </DropdownMenu.Root>
            <Button size="regular" tone="secondary" className="vq-workspace-table-tool" onClick={onReset}>
                {tx("See all")}
            </Button>
        </>
    );
}

/**
 * 分类的标签、已选摘要和子菜单共用同一份筛选状态，角色选项和单选选项继续使用对应的菜单语义。
 */
function FilterSection({
    filter,
    open,
    onOpenChange,
    triggerRef,
    contentRef,
}: {
    filter: WorkspaceFilter;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    triggerRef?: Ref<HTMLDivElement>;
    contentRef?: Ref<HTMLDivElement>;
}) {
    const summaryId = useId();
    const selected = filter.choices
        .filter(([value]) => value && (filter.multiple ? filter.value.includes(value) : filter.value === value))
        .map(([, label]) => label)
        .join(", ");
    return (
        <DropdownMenu.Sub open={open} onOpenChange={onOpenChange}>
            <DropdownMenu.SubTrigger
                ref={triggerRef}
                className="vq-dropdown-item vq-workspace-table-filter-category"
                aria-label={filter.label}
                aria-describedby={selected ? summaryId : undefined}
            >
                {filter.label}
                {selected && (
                    <span id={summaryId} className="vq-workspace-table-filter-value">
                        {selected}
                    </span>
                )}
                <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path d="m4.5 3 3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
                <DropdownMenu.SubContent
                    className="vq-dropdown vq-workspace-table-filter-menu"
                    ref={contentRef}
                    sideOffset={4}
                    collisionPadding={8}
                >
                    <FilterOptions filter={filter} />
                </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
        </DropdownMenu.Sub>
    );
}

/**
 * 选项选中后保留弹层，便于相继组合多项条件。角色可以独立开关，单选组则互斥并允许回到全部。
 */
function FilterOptions({ filter }: { filter: WorkspaceFilter }) {
    const check = (
        <DropdownMenu.ItemIndicator className="vq-dropdown-check">
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24">
                <use href={`${icons}#check`} />
            </svg>
        </DropdownMenu.ItemIndicator>
    );
    if (filter.multiple)
        return filter.choices.map(([value, label]) => (
            <DropdownMenu.CheckboxItem
                key={value}
                className="vq-dropdown-item"
                checked={filter.value.includes(value)}
                onCheckedChange={(checked) =>
                    filter.onChange(
                        checked ? [...filter.value, value] : filter.value.filter((current) => current !== value),
                    )
                }
                onSelect={(event) => event.preventDefault()}
            >
                {label}
                {check}
            </DropdownMenu.CheckboxItem>
        ));
    return (
        <DropdownMenu.RadioGroup value={filter.value} onValueChange={filter.onChange}>
            {filter.choices.map(([value, label]) => (
                <DropdownMenu.RadioItem
                    key={value}
                    value={value}
                    onSelect={(event) => event.preventDefault()}
                    className="vq-dropdown-item"
                >
                    {label}
                    {check}
                </DropdownMenu.RadioItem>
            ))}
        </DropdownMenu.RadioGroup>
    );
}
