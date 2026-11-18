/**
 * 应用外壳：顶部横幅、左侧固定宽度两级菜单与右侧自适应内容区。横幅左为品牌标识，右为个人资料、语言、退出与设置；侧边
 * 栏仅登录后显示，登录/初始化/重置等独立页无侧边栏。所有文案经 tx 单语展示，跟随当前语言切换而重渲染。
 */

import { useContext, useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Link, matchPath, NavLink, useLocation, useNavigate } from "react-router-dom";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Auth } from "./auth-context";
import { tx, useAppLocale } from "./locale";
import { LanguageControl } from "./locale-ui";
import { Avatar } from "./components";

import adminIcons from "./admin-icons.svg?no-inline";
import brand from "../../../assets/branding/veriq-logo.svg";

/**
 * 菜单图标沿用 TailAdmin 的轮廓和当前文字颜色；链接或按钮的可读名称始终来自其文本。
 */
function Icon({ name }: { name: string }) {
    return (
        <svg className="vq-nav-icon" aria-hidden="true" width="16" height="16">
            <use href={`${adminIcons}#${name}`} />
        </svg>
    );
}

/**
 * 沿用 TailAdmin 的单链接及子菜单数据结构，以稳定标识保存展开偏好；翻译只在渲染时解析。
 */
type MenuGroup = { icon: string; label: string; items: { path: string; label: string }[] };
const authoring: MenuGroup = {
    icon: "design",
    label: "测试设计",
    items: [
        { path: "/workspaces", label: "Workspaces" },
        { path: "/resources", label: "Resources" },
        { path: "/environments", label: "Environments" },
        { path: "/ai", label: "AI" },
    ],
};
const execution: MenuGroup = {
    icon: "execution",
    label: "执行",
    items: [
        { path: "/execution-plans", label: "Plans" },
        { path: "/runtimes", label: "Runtimes" },
    ],
};
const administration: MenuGroup = {
    icon: "admin",
    label: "系统管理",
    items: [{ path: "/admin/users", label: "Users" }],
};

/**
 * 直接打开深层链接或浏览器前进后退时，目标所在分组随路由展开；手动折叠只影响当前分组。
 */
function SidebarGroup({
    group,
    open,
    onSelect,
    onToggle,
}: {
    group: MenuGroup;
    open: boolean;
    onSelect: (event: MouseEvent<HTMLAnchorElement>) => void;
    onToggle: () => void;
}) {
    const id = useId();
    return (
        <div className="vq-nav-group">
            <button type="button" className="vq-nav-item" aria-expanded={open} aria-controls={id} onClick={onToggle}>
                <Icon name={group.icon} />
                {tx(group.label)}
                <Icon name="chevron" />
            </button>
            <div className="vq-nav-children" id={id} hidden={!open}>
                {group.items.map((item) => (
                    <NavLink className="vq-nav-sub" key={item.path} to={item.path} onClick={onSelect}>
                        {tx(item.label)}
                    </NavLink>
                ))}
            </div>
        </div>
    );
}

/**
 * 导航和重开菜单都按路由自身的匹配规则展开当前路径所属分组，保留用户对其他分组的折叠选择。
 */
function revealCurrentGroup(groups: MenuGroup[], pathname: string) {
    return groups.filter((group) => !group.items.some((item) => matchPath({ path: item.path, end: false }, pathname)));
}
/**
 * 窄屏按钮位于导航前面，关闭后链接同时退出布局和键盘顺序；桌面保留各分组的独立展开状态。
 */
function Sidebar() {
    useAppLocale();
    const { user } = useContext(Auth);
    const { pathname } = useLocation();
    const [openedAt, setOpenedAt] = useState<string | null>(null);
    const [collapsed, setCollapsed] = useState<MenuGroup[]>([]);
    const menuTrigger = useRef<HTMLButtonElement>(null);
    const open = openedAt === pathname;
    useEffect(() => {
        setOpenedAt((path) => (path === pathname ? path : null));
        setCollapsed((groups) => revealCurrentGroup(groups, pathname));
    }, [pathname]);
    // 同一路径不会触发标题聚焦，窄屏关闭导航时把焦点交给仍在布局中的菜单按钮，桌面链接保持原焦点。
    const close = (event: MouseEvent<HTMLAnchorElement>) => {
        setOpenedAt(null);
        const trigger = menuTrigger.current;
        if (open && event.currentTarget.pathname === pathname && trigger?.getClientRects().length) {
            trigger.focus({ preventScroll: true });
        }
    };
    const toggleMenu = () => {
        if (!open) setCollapsed((groups) => revealCurrentGroup(groups, pathname));
        setOpenedAt(open ? null : pathname);
    };
    const renderGroup = (group: MenuGroup) => (
        <SidebarGroup
            group={group}
            open={!collapsed.includes(group)}
            onSelect={close}
            onToggle={() =>
                setCollapsed((groups) =>
                    groups.includes(group) ? groups.filter((item) => item !== group) : [...groups, group],
                )
            }
        />
    );
    return (
        <aside className="vq-sidebar">
            <button
                ref={menuTrigger}
                type="button"
                className="vq-mobile-menu"
                aria-controls="vq-navigation"
                aria-expanded={open}
                onClick={toggleMenu}
            >
                <Icon name="menu" />
                {tx("Menu")}
            </button>
            <nav className="vq-nav" id="vq-navigation" aria-label={tx("Main navigation")}>
                <NavLink className="vq-nav-item" to="/account" onClick={close}>
                    <Icon name="account" />
                    {tx("Account")}
                </NavLink>
                {renderGroup(authoring)}
                {renderGroup(execution)}
                <NavLink className="vq-nav-item" to="/reports" onClick={close}>
                    <Icon name="reports" />
                    {tx("Reports")}
                </NavLink>
                {user?.systemAdmin && renderGroup(administration)}
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
                <Avatar name={user.displayName} size={28} />
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
 * 顶部横幅：左为品牌标识，右为个人资料、语言、退出与设置按钮；未登录时不渲染用户区域。
 */
function TopBar({ onLogout }: { onLogout: () => void }) {
    useAppLocale();
    const { user } = useContext(Auth);
    return (
        <header className="vq-topbar">
            <Link to="/" className="vq-brand">
                <img src={brand} width="28" height="28" alt="" />
                <span className="vq-brand-name">VeriQ</span>
            </Link>
            <div className="vq-topbar-actions">
                {user && <UserMenu />}
                <LanguageControl />
                {user ? (
                    <>
                        <button type="button" className="vq-btn vq-btn-secondary" onClick={onLogout}>
                            <Icon name="logout" />
                            {tx("Sign out")}
                        </button>
                        <Link className="vq-settings" to="/account">
                            <Icon name="settings" />
                            {tx("Settings")}
                        </Link>
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
