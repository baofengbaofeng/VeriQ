/**
 * 设置页的横向导航与认证分区的纵向导航共用手动激活规则，方向键移动焦点，回车、空格和点击才显示对应面板。
 */
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import icons from "../../admin-icons.svg?no-inline";
import { tx } from "../../locale";

/**
 * 设置标签共用稳定路由值、面板标识与图标；认证配置深链接使用固定值，不受界面语言切换影响。
 */
export const settingsTabs = [
    { id: "basic", label: "Basic information", icon: "settings" },
    { id: "members", label: "Members", icon: "admin" },
    { id: "auth-credentials", label: "Authentication and credentials", icon: "account" },
    { id: "ai-providers", label: "AI providers", icon: "ai-settings" },
] as const;
/**
 * 仅接受设置标签表中列出的路由查询值，外部链接携带其他值时由调用方退回默认的基本信息面板。
 */
export type SettingsTab = (typeof settingsTabs)[number]["id"];

/**
 * 工作区一级导航保留带图标的下划线布局，接收路由选项并把激活动作交给调用方更新浏览器地址及历史记录。
 */
export function SettingsTabs({
    selected,
    prefix,
    activate,
}: {
    selected: SettingsTab;
    prefix: string;
    activate: (tab: SettingsTab) => void;
}) {
    return (
        <SettingsTabList
            tabs={settingsTabs.map((tab) => ({ ...tab, label: tx(tab.label) }))}
            selected={selected}
            prefix={prefix}
            activate={activate}
            label={tx("Workspace settings")}
            className="vq-settings-tabs"
        />
    );
}

/**
 * 标签列表保留单个 Tab 停靠点，离开列表后回到当前选中的标签；方向键只处理本列表排列方向上的移动。
 * 同一套前缀将每个按钮关联到调用方渲染的面板，内外两级列表可以独立导航。
 */
export function SettingsTabList<T extends string>({
    tabs,
    selected,
    prefix,
    activate,
    label,
    className,
    orientation = "horizontal",
}: {
    tabs: ReadonlyArray<{ id: T; label: string; icon?: string }>;
    selected: T;
    prefix: string;
    activate: (tab: T) => void;
    label: string;
    className: string;
    orientation?: "horizontal" | "vertical";
}) {
    const list = useRef<HTMLDivElement>(null);
    const [focused, setFocused] = useState<T>();
    function move(event: KeyboardEvent<HTMLButtonElement>, index: number) {
        const count = tabs.length;
        const previous = orientation === "vertical" ? "ArrowUp" : "ArrowLeft";
        const following = orientation === "vertical" ? "ArrowDown" : "ArrowRight";
        const next = {
            [previous]: (index + count - 1) % count,
            [following]: (index + 1) % count,
            Home: 0,
            End: count - 1,
        };
        if (!Object.hasOwn(next, event.key)) return;
        event.preventDefault();
        list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next[event.key]]?.focus();
    }
    return (
        <div
            className={className}
            role="tablist"
            aria-label={label}
            aria-orientation={orientation}
            ref={list}
            onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) setFocused(undefined);
            }}
        >
            {tabs.map(({ id, label, icon }, index) => (
                <button
                    type="button"
                    key={id}
                    role="tab"
                    id={`${prefix}-${id}-tab`}
                    aria-selected={selected === id}
                    aria-controls={`${prefix}-${id}-panel`}
                    tabIndex={(focused ?? selected) === id ? 0 : -1}
                    onFocus={() => setFocused(id)}
                    onKeyDown={(e) => move(e, index)}
                    onClick={() => activate(id)}
                >
                    {icon && (
                        <svg aria-hidden="true" width="16" height="16">
                            <use href={`${icons}#${icon}`} />
                        </svg>
                    )}
                    {label}
                </button>
            ))}
        </div>
    );
}

/**
 * 每个标签都关联一个稳定的面板节点；只读成员看到的面板可能没有按钮，仍可用 Tab 进入面板阅读首行内容。
 */
export function SettingsPanel({
    tab,
    prefix,
    selected,
    children,
}: {
    tab: string;
    prefix: string;
    selected: string;
    children: ReactNode;
}) {
    return (
        <div
            role="tabpanel"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: 无可操作控件的只读标签面板也须能通过 Tab 进入。
            tabIndex={0}
            hidden={tab !== selected}
            id={`${prefix}-${tab}-panel`}
            aria-labelledby={`${prefix}-${tab}-tab`}
        >
            {children}
        </div>
    );
}
