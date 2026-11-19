/**
 * 应用外壳：顶部横幅、左侧固定宽度两级菜单与右侧自适应内容区。横幅左为品牌标识，右为个人资料、语言、退出与设置；侧边
 * 栏仅登录后显示，登录/初始化/重置等独立页无侧边栏。所有文案经 tx 单语展示，跟随当前语言切换而重渲染。
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
        { path: "/resources", label: "Resources" },
        { path: "/environments", label: "Environments" },
        { path: "/ai", label: "AI" },
        { path: "/agent", label: "Test Agent" },
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
 * 根节点在载入应用前已读取过浏览器主题，按钮沿用此值；存储受限时仍改变当前文档，表单及会话不必重新挂载。
 */
function ThemeToggle() {
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
            <Icon name={dark ? "sun" : "moon"} />
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
            sideOffset={4}
            alignOffset={-3}
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
                    sideOffset={12}
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

/**
 * 品牌图标及成员空间操作组成横幅左区，右区按身份展示个人菜单或访客语言选择器，保持单一空间入口。
 */
function TopBar({ onLogout }: { onLogout: () => void }) {
    useAppLocale();
    const { user } = useContext(Auth);
    const [breakpoint] = useState(() => window.matchMedia("(max-width: 1279.98px)"));
    const [compact, setCompact] = useState(breakpoint.matches);
    const [expanded, setExpanded] = useState(false);
    const actions = useRef<HTMLDivElement>(null);
    const more = useRef<HTMLButtonElement>(null);
    const restore = useRef(false);
    const toolsId = useId();
    useLayoutEffect(() => {
        const synchronize = () => {
            if (
                breakpoint.matches &&
                (actions.current?.contains(document.activeElement) ||
                    actions.current?.querySelector('[aria-expanded="true"]'))
            )
                restore.current = true;
            if (!breakpoint.matches && more.current === document.activeElement) restore.current = true;
            setExpanded(false);
            setCompact(breakpoint.matches);
        };
        breakpoint.addEventListener("change", synchronize);
        return () => breakpoint.removeEventListener("change", synchronize);
    }, [breakpoint]);
    useLayoutEffect(() => {
        if (restore.current) (compact ? more.current : actions.current?.querySelector("button"))?.focus();
        restore.current = false;
    }, [compact]);
    return (
        <header className="vq-topbar">
            <div className="vq-header-main">
                <div className="vq-topbar-workspaces">
                    <Link to="/" className="vq-brand">
                        <img src={brand} width="22" height="22" alt="VeriQ" />
                    </Link>
                    {user && <WorkspaceControls />}
                </div>
                {compact && (
                    <button
                        ref={more}
                        type="button"
                        className="vq-header-more"
                        aria-label={tx("Toggle application menu")}
                        aria-controls={toolsId}
                        aria-expanded={expanded}
                        onClick={() => setExpanded(!expanded)}
                    >
                        <Icon name="horizontal-dots" />
                    </button>
                )}
            </div>
            <div className="vq-header-tools" id={toolsId} ref={actions} hidden={compact && !expanded}>
                {(!compact || expanded) && (
                    <>
                        <ThemeToggle />
                        {user ? <UserMenu onLogout={onLogout} /> : <LanguageControl />}
                    </>
                )}
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
