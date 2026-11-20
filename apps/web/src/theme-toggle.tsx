/**
 * 主题切换按钮在登录后头部与认证页共用，点击切换根节点 data-theme 与 color-scheme 并尝试持久化到 veriq.theme；
 * 存储被隐私设置禁止时本次页内仍生效。aria-label 固定为 "Dark mode"，aria-pressed 反映当前深色状态。
 */

import { useState } from "react";
import { tx } from "./locale";
import adminIcons from "./admin-icons.svg?no-inline";
/**
 * 主题切换：深色时按钮内显示太阳图标表示可切回浅色，浅色时显示月亮图标；切换不重建表单与路由。
 */
export function ThemeToggle() {
    const [dark, setDark] = useState(() => document.documentElement.dataset.theme === "dark");
    function toggle() {
        const next = dark ? "light" : "dark";
        document.documentElement.dataset.theme = next;
        document.documentElement.style.colorScheme = next;
        setDark(!dark);
        try {
            localStorage.setItem("veriq.theme", next);
        } catch {
            // 当隐私设置禁止写入偏好时，本次页面的主题仍由根节点持有，应用继续响应随后的切换操作。
        }
    }
    return (
        <button
            type="button"
            className="vq-theme-toggle"
            aria-label={tx("Dark mode")}
            aria-pressed={dark}
            onClick={toggle}
        >
            <svg className="vq-nav-icon" aria-hidden="true" width="16" height="16">
                <use href={`${adminIcons}#${dark ? "sun" : "moon"}`} />
            </svg>
        </button>
    );
}
