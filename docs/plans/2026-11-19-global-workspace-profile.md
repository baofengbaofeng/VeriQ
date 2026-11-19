# VeriQ Global Workspace and Profile Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement and review the steps.

**Goal** 在 Web Banner 为整个登录会话提供一处工作区选择和创建入口，并把个人操作移入用户名菜单。

**Architecture** 将现有 WorkspaceProvider 提升到已登录外壳，使用统一目录和授权深链接解析。功能页消费全局选择。用户名菜单和账号页沿用现有认证、语言和会话处理。

**Spec** [服务端管理台界面](../specs/web-console.md)

## Global Constraints

- Banner 左侧顺序为彩色 Logo、工作区下拉列表、添加工作区按钮。用户触发器在右侧，仅显示用户名和表示展开的图标。
- 登录后从用户名菜单进入语言切换、设置及退出。设置打开现有 `/account`。去掉侧栏账号项。
- 保留紧凑外壳的 14px 页面标题、13px 正文、12px 表格及可见键盘焦点。窄屏可折行。
- 全局选择按登录身份隔离。真实工作区权限和分页由现有 API 提供。保留查询取消、跨空间视图清理和深链接。
- Profile 使用现有用户姓名、邮箱、角色、密码和会话数据。复用现有依赖、认证和桌面公开接口。

## Review Focus

- 路由导航、语言切换和目录分页不能替换当前手动工作区选择。
- 指向其它工作区的深链接等待当前授权检查。手动切换要清理旧工作区关联的深链接参数。
- 已经退出或已切换账户的请求结果不能发布目录、选中项或消息。
- 新建工作区与样例导入成功后选择真实新工作区。失败保留表单和当前选择。
- 用户菜单必须可通过键盘打开、选择和关闭。退出和会话失效沿用现有回调。

---

### Task 1: Move workspace selection and profile actions into the shell

**Files**

- Modify `apps/web/src/main.tsx`, `apps/web/src/layout.tsx`, `apps/web/src/admin.css` and required locale entries.
- Create the global directory/controller and workspace creation view under `apps/web/src/features/workspaces/`.
- Update the Web route wrappers for Workspaces, Runtimes, Resources, Environments, Agent, AI, Reports and Execution Plans.
- Update `apps/web/src/pages/account.tsx` and actual browser specs whose controls move. Keep scoped view adapters and desktop entry compatible.

- [ ] Add a real browser case for a single header workspace selector, selecting and retaining a workspace across routes, and creating a workspace from a different page.
- [ ] Assert the user menu actions, the settings route, login-state isolation and working keyboard focus. Include an authorized deep link and manual switch back to the other workspace.
- [ ] Run the focused browser regression on the old implementation and capture the intended failure.
- [ ] Move the provider and directory into the authenticated shell. Keep deep-link authorization, paging and scope cancellation.
- [ ] Move the creation flow and account actions to the header. Arrange the current profile, password and session controls into Profile-style cards.
- [ ] Update callers in existing lifecycle, authorization, locale, resources and report tests to use the new controls. Run focused and related suites, Web checks and both build entries.
- [ ] Commit and request independent code review, then verify the merged result against the latest `dev` before pushing.
