/**
 * 应用语言和键盘导航组件直接渲染真实 React 控件并保留原生交互语义，语言偏好通过共享实例更新；路由焦点只随页面路径变化
 * ，不能因为字段编辑、报告刷新或语言切换抢走用户当前光标。
 */
import { useEffect, useId, useRef, type ComponentProps, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { I18nextProvider } from "react-i18next";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ConfirmDialog as SharedConfirmDialog } from "@veriq/ui";
import { appI18n, tx, useAppLocale } from "./locale";

/**
 * 全局 Provider 明确绑定应用实例，嵌入宿主时仍可复用同一状态与清理边界；它不把语言放进子树 key，也不以切换语言触发路由
 * 、Workspace 或资源编辑器的卸载重建。
 */
export function AppLocaleProvider({ children }: { children: ReactNode }) {
    useAppLocale();
    return <I18nextProvider i18n={appI18n}>{children}</I18nextProvider>;
}

/**
 * 共享语言控件使用真实标签关联和原生 select，键盘方向键、屏幕阅读器及表单焦点均沿用浏览器行为；中英文选项使用本族语言
 * 名称，且只接受已支持的两个持久化语言值。
 */
export function LanguageControl() {
    const { language, setLanguage } = useAppLocale();
    const id = useId();
    return (
        <label htmlFor={id} className="veriq-language">
            {tx("Language")}
            <select id={id} value={language} onChange={(event) => setLanguage(event.target.value)}>
                <option value="zh">中文</option>
                <option value="en">English</option>
            </select>
        </label>
    );
}

/**
 * 语言下拉切换沿用 TailAdmin Default Dropdown 外观，以按钮加单选菜单替代原生 select，触发按钮只显示当前语言名与下拉箭头，
 * 打开后由 RadioGroup 在两个持久化语言值之间互斥选择。
 */
export function LanguageDropdown() {
    const { language, setLanguage } = useAppLocale();
    const active = language === "zh" ? "中文" : "English";
    return (
        <DropdownMenu.Root>
            <DropdownMenu.Trigger className="vq-filter-button">
                {active}
                <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path
                        d="m3 4.5 3 3 3-3"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    />
                </svg>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
                <DropdownMenu.Content className="vq-dropdown" align="start" sideOffset={4} collisionPadding={8}>
                    <DropdownMenu.RadioGroup value={language} onValueChange={setLanguage}>
                        <DropdownMenu.RadioItem value="zh" className="vq-dropdown-item">
                            中文
                            <DropdownMenu.ItemIndicator className="vq-dropdown-check">
                                <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none">
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
                        <DropdownMenu.RadioItem value="en" className="vq-dropdown-item">
                            English
                            <DropdownMenu.ItemIndicator className="vq-dropdown-check">
                                <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none">
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
                    </DropdownMenu.RadioGroup>
                </DropdownMenu.Content>
            </DropdownMenu.Portal>
        </DropdownMenu.Root>
    );
}

/**
 * 跳转链接指向可聚焦主内容地标，真正路径导航后聚焦页面标题或加载中的主内容；查询参数及语言变更不会重置焦点，首次打开也
 * 不抢走浏览器或自动填充已拥有的输入焦点。
 */
export function AccessibilityNavigation() {
    useAppLocale();
    const { pathname } = useLocation();
    const previous = useRef(pathname);
    useEffect(() => {
        if (previous.current === pathname) return;
        previous.current = pathname;
        const main = document.getElementById("main-content");
        const heading = main?.querySelector<HTMLElement>("h1[tabindex='-1']");
        (heading ?? main)?.focus({ preventScroll: true });
    }, [pathname]);
    return (
        <a href="#main-content" className="veriq-skip-link">
            {tx("Skip to main content")}
        </a>
    );
}

/**
 * Web 确认框复用现有 Radix 的焦点圈定、Escape 关闭及触发器焦点恢复能力，只传入当前语言的确认和取消文案；共享包的默认行
 * 为、执行回调和对话框权限不在此处重新实现。
 */
export function ConfirmDialog(props: ComponentProps<typeof SharedConfirmDialog>) {
    useAppLocale();
    return (
        <SharedConfirmDialog
            {...props}
            title={tx(props.title)}
            trigger={tx(props.trigger)}
            cancelLabel={props.cancelLabel ?? tx("Cancel")}
            confirmLabel={props.confirmLabel ?? tx("Confirm")}
        />
    );
}
