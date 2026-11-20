/**
 * 应用外壳：登录后左列为全高侧栏，右列 sticky 头部集中工作区、主题、通知与账户操作，内容区独立滚动。访客没有侧栏，
 * 改由头部横向品牌标识承担入口；所有文案经 tx 单语展示，跟随当前语言切换而重渲染。
 */

import {
    useContext,
    useEffect,
    useLayoutEffect,
    useId,
    useRef,
    useState,
    type MouseEvent,
    type ReactNode,
} from "react";
import { Link, matchPath, NavLink, useLocation, useNavigate } from "react-router-dom";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Avatar } from "./components";
import { Auth } from "./auth-context";
import { tx, useAppLocale } from "./locale";
import { LanguageControl } from "./locale-ui";
import { WorkspaceControls } from "./features/workspaces/WorkspaceControls";
import { AgentSheet } from "./features/agent/AgentSheet";
import { ThemeToggle } from "./theme-toggle";

import adminIcons from "./admin-icons.svg?no-inline";
import logoLight from "../../../assets/branding/verifyquality-logo-light.svg";
import logoDark from "../../../assets/branding/verifyquality-logo-dark.svg";
import logoIcon from "../../../assets/branding/veriq-logo.svg";

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
            <button
                type="button"
                className="vq-nav-item"
                aria-label={tx(group.label)}
                aria-expanded={open}
                aria-controls={id}
                onClick={onToggle}
            >
                <Icon name={group.icon} />
                <span>{tx(group.label)}</span>
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
/*
 * 侧栏在登录后占据左列全高，顶部品牌区随折叠在横版标识与方形图标之间切换；窄屏按钮连同导航在关闭后退出键盘顺序，
 * 桌面保留各分组的独立展开状态，手风琴逻辑继续按当前路由展开所属分支。
 */
function Sidebar({ collapsed }: { collapsed: boolean }) {
    useAppLocale();
    const { user } = useContext(Auth);
    const { pathname } = useLocation();
    const [openedAt, setOpenedAt] = useState<string | null>(null);
    const [collapsedGroups, setCollapsedGroups] = useState<MenuGroup[]>([]);
    const menuTrigger = useRef<HTMLButtonElement>(null);
    const open = openedAt === pathname;
    useEffect(() => {
        setOpenedAt((path) => (path === pathname ? path : null));
        setCollapsedGroups((groups) => revealCurrentGroup(groups, pathname));
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
        if (!open) setCollapsedGroups((groups) => revealCurrentGroup(groups, pathname));
        setOpenedAt(open ? null : pathname);
    };
    const renderGroup = (group: MenuGroup) => (
        <SidebarGroup
            group={group}
            open={!collapsedGroups.includes(group)}
            onSelect={close}
            onToggle={() =>
                setCollapsedGroups((groups) =>
                    groups.includes(group) ? groups.filter((item) => item !== group) : [...groups, group],
                )
            }
        />
    );
    return (
        <aside className="vq-sidebar" id="vq-sidebar" data-collapsed={collapsed}>
            <div className="vq-sidebar-header">
                <Link to="/" className="vq-sidebar-brand" aria-label="VeriQ">
                    {collapsed ? (
                        <img src={logoIcon} width="32" height="32" alt="VeriQ" />
                    ) : (
                        <>
                            <img className="vq-brand-light" src={logoLight} alt="VeriQ" />
                            <img className="vq-brand-dark" src={logoDark} alt="VeriQ" />
                        </>
                    )}
                </Link>
            </div>
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
                <span className="vq-nav-group-label">{tx("Menu")}</span>
                {renderGroup(authoring)}
                {renderGroup(execution)}
                <NavLink className="vq-nav-item" to="/reports" aria-label={tx("Reports")} onClick={close}>
                    <Icon name="reports" />
                    <span>{tx("Reports")}</span>
                </NavLink>
                {user?.systemAdmin && renderGroup(administration)}
            </nav>
        </aside>
    );
}
/*
 * 通知铃为站内信占位，当前只呈现按钮而无可展开内容，图标符号与通知后端由后续任务接入，避免制造无响应的假交互。
 */
function NotificationBell() {
    return (
        <button type="button" className="vq-icon-button" aria-label={tx("Notifications")}>
            <Icon name="bell" />
        </button>
    );
}

/**
 * 语言子菜单沿用当前页面的翻译实例，选择后由根菜单自然关闭；按 Escape 只退回上一级，让键盘焦点停在语言入口。
 */
function LanguageMenu() {
    const { language, setLanguage } = useAppLocale();
    const [open, setOpen] = useState(false);
    const trigger = useRef<HTMLDivElement>(null);
    const [breakpoint] = useState(() => window.matchMedia("(max-width: 520px)"));
    const [inline, setInline] = useState(breakpoint.matches);
    useLayoutEffect(() => {
        const resize = () => setInline(breakpoint.matches);
        breakpoint.addEventListener("change", resize);
        return () => breakpoint.removeEventListener("change", resize);
    }, [breakpoint]);
    const choices = (
        <DropdownMenu.SubContent
            className="vq-menu vq-language-menu"
            sideOffset={3}
            alignOffset={-2}
            collisionPadding={8}
            onEscapeKeyDown={(event) => {
                event.preventDefault();
                setOpen(false);
                trigger.current?.focus();
            }}
        >
            <DropdownMenu.RadioGroup value={language} onValueChange={setLanguage}>
                {(["en", "zh"] as const).map((value) => (
                    <DropdownMenu.RadioItem key={value} value={value} className="vq-menu-item">
                        <Icon name={`locale-${value}`} />
                        {value === "en" ? "English" : "中文"}
                    </DropdownMenu.RadioItem>
                ))}
            </DropdownMenu.RadioGroup>
        </DropdownMenu.SubContent>
    );
    return (
        <DropdownMenu.Sub open={open} onOpenChange={setOpen}>
            <DropdownMenu.SubTrigger
                className="vq-menu-item"
                ref={trigger}
                onPointerMove={(event) => {
                    if (inline) event.preventDefault();
                }}
                onPointerLeave={(event) => {
                    if (inline && open) event.preventDefault();
                }}
            >
                <Icon name="globe" />
                {tx("Language")}
                <span className="vq-locale-badge">
                    {language.toUpperCase()}
                    <Icon name={`locale-${language}`} />
                </span>
            </DropdownMenu.SubTrigger>
            {inline ? (
                open && <div className="vq-language-inline">{choices}</div>
            ) : (
                <DropdownMenu.Portal>{choices}</DropdownMenu.Portal>
            )}
        </DropdownMenu.Sub>
    );
}

/**
 * 登录菜单在 Portal 中提供语言单选项和账户操作，键盘上下文与焦点恢复由 Radix 的菜单原语持有。
 */
function UserMenu({ onLogout }: { onLogout: () => void }) {
    useAppLocale();
    const [open, setOpen] = useState(false);
    const trigger = useRef<HTMLButtonElement>(null);
    const { user } = useContext(Auth);
    const navigate = useNavigate();
    const { pathname } = useLocation();
    const leaving = useRef(false);
    if (!user) return null;
    return (
        <DropdownMenu.Root open={open} onOpenChange={setOpen} modal={false}>
            <DropdownMenu.Trigger ref={trigger} className="vq-user-trigger">
                <Avatar name={user.displayName} size={32} fontSize={13} />
                <span className="vq-user-name">{user.displayName}</span>
                <Icon name="account-chevron" />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
                <DropdownMenu.Content
                    className="vq-menu vq-profile-menu"
                    sideOffset={6}
                    collisionPadding={8}
                    onKeyDown={(event) => {
                        // 子菜单关闭后，根层监听的交接可能跨越下一次按键；只补接发自当前菜单且尚未处理的退出键。
                        if (
                            !event.defaultPrevented &&
                            event.key === "Escape" &&
                            event.target instanceof Element &&
                            event.target.closest('[role="menu"]') === event.currentTarget
                        ) {
                            event.preventDefault();
                            setOpen(false);
                        }
                    }}
                    align="end"
                    onCloseAutoFocus={(event) => {
                        if (leaving.current || !trigger.current?.isConnected) event.preventDefault();
                        leaving.current = false;
                    }}
                >
                    <DropdownMenu.Label className="vq-menu-identity">
                        <strong>{user.displayName}</strong>
                        <span>{user.email}</span>
                    </DropdownMenu.Label>
                    <DropdownMenu.Separator className="vq-menu-separator" />
                    <DropdownMenu.Item
                        className="vq-menu-item"
                        onSelect={() => {
                            leaving.current = pathname !== "/account";
                            void navigate("/account");
                        }}
                    >
                        <Icon name="settings" />
                        {tx("Account settings")}
                    </DropdownMenu.Item>
                    <LanguageMenu />
                    <DropdownMenu.Separator className="vq-menu-separator" />
                    <DropdownMenu.Item className="vq-menu-item vq-sign-out" onSelect={onLogout}>
                        <Icon name="logout" />
                        {tx("Sign out")}
                    </DropdownMenu.Item>
                </DropdownMenu.Content>
            </DropdownMenu.Portal>
        </DropdownMenu.Root>
    );
}

/*
 * 顶部栏只占据右列：登录后左端汉堡按钮折叠侧栏，中段保留工作区切换，右端依次放置主题、通知与账户操作；访客没有侧栏，
 * 左端改显横向品牌标识，语言选择仍直接暴露在工具区，避免把访客引向不可用的账户菜单。
 * 窄屏保留一个“更多”按钮收起右侧工具组，工作区切换始终可见，展开后工具组独占一行，避免横向溢出。
 */
function Header({
    collapsed,
    onToggleCollapse,
    onLogout,
}: {
    collapsed: boolean;
    onToggleCollapse: () => void;
    onLogout: () => void;
}) {
    useAppLocale();
    const { user } = useContext(Auth);
    const [breakpoint] = useState(() => window.matchMedia("(max-width: 1024px)"));
    const [compact, setCompact] = useState(breakpoint.matches);
    const [expanded, setExpanded] = useState(false);
    const toolsId = useId();
    const more = useRef<HTMLButtonElement>(null);
    const actions = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        const synchronize = () => setCompact(breakpoint.matches);
        breakpoint.addEventListener("change", synchronize);
        return () => breakpoint.removeEventListener("change", synchronize);
    }, [breakpoint]);
    // 回到宽屏后合上临时展开的工具组，保留桌面端始终内联的初始状态。
    useEffect(() => {
        if (!compact) setExpanded(false);
    }, [compact]);
    const collapsible = Boolean(user) && compact;
    const toolsVisible = !collapsible || expanded;
    function toggleTools() {
        setExpanded(!expanded);
    }
    return (
        <header className="vq-header">
            {user ? (
                <button
                    type="button"
                    className="vq-hamburger"
                    aria-label={tx("Toggle sidebar")}
                    aria-controls="vq-sidebar"
                    aria-expanded={!collapsed}
                    onClick={onToggleCollapse}
                >
                    <Icon name="menu" />
                </button>
            ) : (
                <Link to="/" className="vq-sidebar-brand vq-header-brand" aria-label="VeriQ">
                    <img className="vq-brand-light" src={logoLight} alt="VeriQ" />
                    <img className="vq-brand-dark" src={logoDark} alt="VeriQ" />
                </Link>
            )}
            {user && <WorkspaceControls visible />}
            {user && <AgentSheet />}
            {collapsible && (
                <button
                    ref={more}
                    type="button"
                    className="vq-header-more"
                    aria-label={tx("Toggle application menu")}
                    aria-controls={toolsId}
                    aria-expanded={expanded}
                    onClick={toggleTools}
                >
                    <Icon name="horizontal-dots" />
                </button>
            )}
            <div ref={actions} className="vq-header-tools" id={toolsId} hidden={!toolsVisible}>
                <ThemeToggle />
                {user ? (
                    <>
                        <NotificationBell />
                        <UserMenu onLogout={onLogout} />
                    </>
                ) : (
                    <LanguageControl />
                )}
            </div>
        </header>
    );
}

/*
 * 应用外壳组成横向两列：登录后左列渲染全高侧栏，右列固定头部并承载内容；访客只保留右列，主区仍保留 main-content
 * 锚点供跳转链接聚焦，折叠状态由头部按钮在本地维护并同时驱动侧栏宽度与按钮的展开语义。
 */
export function AppShell({ children, onLogout }: { children: ReactNode; onLogout: () => void }) {
    const { user } = useContext(Auth);
    const [collapsed, setCollapsed] = useState(false);
    return (
        <div className="vq-shell">
            {user ? <Sidebar collapsed={collapsed} /> : null}
            <div className="vq-main">
                <Header collapsed={collapsed} onToggleCollapse={() => setCollapsed(!collapsed)} onLogout={onLogout} />
                <main id="main-content" className="vq-content" tabIndex={-1}>
                    <div className="vq-content-inner">{children}</div>
                </main>
            </div>
        </div>
    );
}
