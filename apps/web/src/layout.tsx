/**
 * 应用外壳：顶部横幅、左侧固定宽度两级菜单与右侧自适应内容区。横幅左为品牌标识，右为语言切换、用户头像菜单与退出；侧边
 * 栏仅登录后显示，登录/初始化/重置等独立页无侧边栏。所有文案经 tx 单语展示，跟随当前语言切换而重渲染。
 */

import { useContext, type ReactNode } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Auth } from "./auth-context";
import { tx, useAppLocale } from "./locale";
import { LanguageControl } from "./locale-ui";
import { Avatar } from "./components";

/**
 * 单个导航项：to 为路由路径，label 为已翻译文案，adminOnly 决定是否仅系统管理员可见。
 */
type MenuItem = { to: string; label: string; adminOnly?: boolean };

/**
 * 菜单条目：既可以是独立导航项，也可以是带若干子项的命名分组，用于表达最多两级的菜单结构。
 */
type MenuEntry = { kind: "item"; item: MenuItem } | { kind: "group"; label: string; items: MenuItem[] };

/**
 * 依据当前登录身份构造侧边栏菜单：账号与报告为独立项，测试设计/执行分组容纳相关入口，系统管理分组仅管理员可见。分组标签
 * 与入口文案统一经 tx 得到当前语言文本。
 */
function useMenu(): MenuEntry[] {
    const { user } = useContext(Auth);
    const entries: MenuEntry[] = [
        { kind: "item", item: { to: "/account", label: tx("Account") } },
        {
            kind: "group",
            label: tx("测试设计"),
            items: [
                { to: "/workspaces", label: tx("Workspaces") },
                { to: "/resources", label: tx("Resources") },
                { to: "/environments", label: tx("Environments") },
                { to: "/ai", label: "AI" },
            ],
        },
        {
            kind: "group",
            label: tx("执行"),
            items: [
                { to: "/execution-plans", label: tx("Plans") },
                { to: "/runtimes", label: tx("Runtimes") },
            ],
        },
        { kind: "item", item: { to: "/reports", label: tx("Reports") } },
    ];
    if (user?.systemAdmin) {
        entries.push({
            kind: "group",
            label: tx("系统管理"),
            items: [{ to: "/admin/users", label: tx("Users") }],
        });
    }
    return entries;
}

/**
 * 侧边栏：固定宽度，独立项与两级分组分别渲染，选中态由 NavLink 的 isActive 回调驱动。
 */
function Sidebar() {
    useAppLocale();
    const menu = useMenu();
    return (
        <aside className="vq-sidebar">
            <nav className="vq-nav" aria-label={tx("Main navigation")}>
                {menu.map((entry) =>
                    entry.kind === "item" ? (
                        <NavLink
                            key={entry.item.to}
                            to={entry.item.to}
                            className={({ isActive }) => (isActive ? "vq-nav-item vq-nav-active" : "vq-nav-item")}
                        >
                            {entry.item.label}
                        </NavLink>
                    ) : (
                        <div key={entry.label} className="vq-nav-group">
                            <div className="vq-nav-group-label">{entry.label}</div>
                            {entry.items.map((item) => (
                                <NavLink
                                    key={item.to}
                                    to={item.to}
                                    className={({ isActive }) => (isActive ? "vq-nav-sub vq-nav-active" : "vq-nav-sub")}
                                >
                                    {item.label}
                                </NavLink>
                            ))}
                        </div>
                    ),
                )}
            </nav>
        </aside>
    );
}

/**
 * 用户头像菜单：头像加姓名作为触发器，展开后显示邮箱与前往账号页的入口；退出保持为横幅内的独立按钮。
 */
function UserMenu() {
    useAppLocale();
    const { user } = useContext(Auth);
    const navigate = useNavigate();
    if (!user) return null;
    return (
        <DropdownMenu.Root>
            <DropdownMenu.Trigger className="vq-user-trigger">
                <Avatar name={user.displayName} />
                <span className="vq-user-name">{user.displayName}</span>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
                <DropdownMenu.Content className="vq-menu" sideOffset={8} align="end">
                    <DropdownMenu.Label className="vq-menu-label">{user.email}</DropdownMenu.Label>
                    <DropdownMenu.Item className="vq-menu-item" onSelect={() => navigate("/account")}>
                        {tx("Account")}
                    </DropdownMenu.Item>
                </DropdownMenu.Content>
            </DropdownMenu.Portal>
        </DropdownMenu.Root>
    );
}

/**
 * 顶部横幅：左为品牌标识，右为语言切换、用户头像菜单与退出按钮；未登录时不渲染用户区域。
 */
function TopBar({ onLogout }: { onLogout: () => void }) {
    useAppLocale();
    const { user } = useContext(Auth);
    return (
        <header className="vq-topbar">
            <Link to="/" className="vq-brand">
                <span className="vq-brand-mark" aria-hidden="true">
                    V
                </span>
                <span className="vq-brand-name">VeriQ</span>
            </Link>
            <div className="vq-topbar-actions">
                <LanguageControl />
                {user ? (
                    <>
                        <UserMenu />
                        <button type="button" className="vq-btn vq-btn-secondary" onClick={onLogout}>
                            {tx("Sign out")}
                        </button>
                    </>
                ) : null}
            </div>
        </header>
    );
}

/**
 * 应用外壳：组合横幅、侧边栏与内容主区；侧边栏仅在登录后渲染，主区保留 main-content 锚点供跳转链接聚焦。
 */
export function AppShell({ children, onLogout }: { children: ReactNode; onLogout: () => void }) {
    const { user } = useContext(Auth);
    return (
        <div className="vq-shell">
            <TopBar onLogout={onLogout} />
            <div className="vq-shell-body">
                {user ? <Sidebar /> : null}
                <main id="main-content" className="vq-content" tabIndex={-1}>
                    <div className="vq-content-inner">{children}</div>
                </main>
            </div>
        </div>
    );
}
