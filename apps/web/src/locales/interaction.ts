/**
 * 原生导航、编辑器键盘提示与新增真实状态使用独立的小型词条集合，操作说明依据当前控件和实际权限行为编写；日期、技术枚举
 * 、用户名称和业务参数继续保持原值，不能通过展示翻译修改。
 */
export const interactionMessages: Record<string, readonly [string, string]> = {
    "Main navigation": ["主要导航", "Main navigation"],
    "Version difference": ["版本差异", "Version difference"],
    Kind: ["类型", "Kind"],
    "状态 / Status": ["状态", "Status"],
    Saved: ["已保存", "Saved"],
    "Compilation validated": ["编译校验通过", "Compilation validated"],
    "Use Ctrl+M (Control+Shift+M on macOS) to switch between editing with Tab and moving keyboard focus.": [
        "使用 Ctrl+M（macOS 上为 Control+Shift+M）切换 Tab 的缩进和焦点导航功能。",
        "Use Ctrl+M (Control+Shift+M on macOS) to switch between editing with Tab and moving keyboard focus.",
    ],
    "Toggle Tab key navigation": ["切换 Tab 键焦点导航", "Toggle Tab key navigation"],
    "Use Move up and Move down to reorder rows with the keyboard.": [
        "可使用上移和下移按钮通过键盘调整行顺序。",
        "Use Move up and Move down to reorder rows with the keyboard.",
    ],
    "Press Space to pick up a row, arrow keys to move, Space to drop, or Escape to cancel.": [
        "按空格选中拖动行，使用方向键移动，再按空格放下，或按 Escape 取消。",
        "Press Space to pick up a row, arrow keys to move, Space to drop, or Escape to cancel.",
    ],
    "Moving row {{position}}": ["正在移动第 {{position}} 行", "Moving row {{position}}"],
    "Over row {{position}}": ["位于第 {{position}} 行上方", "Over row {{position}}"],
    "Outside the list": ["已移出列表", "Outside the list"],
    "Reordering finished": ["排序已完成", "Reordering finished"],
    "Reordering cancelled": ["已取消排序", "Reordering cancelled"],
    "Move row {{position}} up": ["上移第 {{position}} 行", "Move row {{position}} up"],
    "Move row {{position}} down": ["下移第 {{position}} 行", "Move row {{position}} down"],
    "{{kind}} resource": ["{{kind}} 资源", "{{kind}} resource"],
    "{{kind}} version": ["{{kind}} 版本", "{{kind}} version"],
    "No execution plans yet.": ["尚无执行计划。", "No execution plans yet."],
    "Your role or the archived Workspace allows read-only plan access.": [
        "当前角色或已归档工作区仅允许只读访问执行计划。",
        "Your role or the archived Workspace allows read-only plan access.",
    ],
    "No published versions available.": ["尚无可用的已发布版本。", "No published versions available."],
    "No resources available.": ["尚无可用资源。", "No resources available."],
    "Loading resources…": ["正在加载资源…", "Loading resources…"],
    "Loading versions…": ["正在加载版本…", "Loading versions…"],
    "Loading tokens…": ["正在加载令牌…", "Loading tokens…"],
    "No tokens issued for this account.": ["此账号尚未签发令牌。", "No tokens issued for this account."],
    "No service accounts yet.": ["尚无服务账号。", "No service accounts yet."],
    none: ["无", "none"],
    allowed: ["已允许", "allowed"],
    disabled: ["已禁用", "disabled"],
    offline: ["离线", "offline"],
    revoked: ["已吊销", "revoked"],
    "Please sign in": ["请先登录", "Please sign in"],
    "Report access changed. Reload after signing in or confirming Workspace access.": [
        "报告访问权限已变化，请登录或确认工作区权限后重新加载。",
        "Report access changed. Reload after signing in or confirming Workspace access.",
    ],
    "Report stream is unavailable.": ["报告数据流不可用。", "Report stream is unavailable."],
};
