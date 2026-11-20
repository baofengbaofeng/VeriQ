/**
 * 设置页采用 TailAdmin 带图标的下划线标签。方向键只移动焦点，原生按钮的回车、空格和点击才激活标签。
 */
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import icons from "../../admin-icons.svg?no-inline";
import { tx } from "../../locale";

/**
 * 三个固定标签共用稳定路由值、面板标识与图标，显示名称交由现有语言切换更新，路径不依赖翻译结果。
 */
export const settingsTabs = [
    { id: "basic", label: "Basic information", icon: "settings" },
    { id: "members", label: "Members", icon: "admin" },
    { id: "ai-providers", label: "AI providers", icon: "ai-settings" },
] as const;
/**
 * 只允许设置页公开的三种标签值，外部链接中的其他查询值由调用方退回默认的基本信息面板。
 */
export type SettingsTab = (typeof settingsTabs)[number]["id"];

/**
 * 标签列表保留单个 Tab 停靠点，移出列表后回到当前选中的标签；面板由工作区详情管理以保留表单状态。
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
    const list = useRef<HTMLDivElement>(null);
    const [focused, setFocused] = useState<SettingsTab>();
    function move(event: KeyboardEvent<HTMLButtonElement>, index: number) {
        const count = settingsTabs.length;
        const next = {
            ArrowLeft: (index + count - 1) % count,
            ArrowRight: (index + 1) % count,
            Home: 0,
            End: count - 1,
        };
        if (!(event.key in next)) return;
        event.preventDefault();
        list.current
            ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
            [next[event.key as keyof typeof next]]?.focus();
    }
    return (
        <div
            className="vq-settings-tabs"
            role="tablist"
            aria-label={tx("Workspace settings")}
            ref={list}
            onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) setFocused(undefined);
            }}
        >
            {settingsTabs.map(({ id, label, icon }, index) => (
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
                    <svg aria-hidden="true" width="16" height="16">
                        <use href={`${icons}#${icon}`} />
                    </svg>
                    {tx(label)}
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
    tab: SettingsTab;
    prefix: string;
    selected: SettingsTab;
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
