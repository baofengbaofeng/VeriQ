# 2026-11-18 Web TailAdmin

> **编码代理执行要求：** 使用 superpowers:subagent-driven-development 逐任务实施本计划，并用复选框记录状态。

**目标** 交付用户已确认的紧凑服务端管理台，验证业务交互后合并并推送到 `dev`。

**架构** 在现有 Web 应用内适配 TailAdmin 头部和可展开分组侧栏。Web 入口单独应用紧凑主题。现有表单、路由、角色规则、资源控制器以及桌面导出接口是接入点。

**技术栈** React 18、Tailwind 3、Vite 6、React Router 7、Radix、i18next、Playwright、Tornado。

**规格** [服务端管理台界面](../specs/web-console.md)

## 全局约束

- Banner 桌面高 56px，侧栏宽 180–200px，导航不超过两级。
- 标题与品牌 14px，正文及控件 13px，表格与辅助提示 12px，触屏文本输入允许 16px。
- 浅灰侧栏和表单、白色主区和输入控件。使用现有彩色 VeriQ SVG。
- TailAdmin React Free `9aaac11e9e6fa87d0afe0e976b5ac291e29eeeb9` 源码适配保留 MIT 声明。
- React、Router、Vite、Tailwind 和全部依赖版本沿用仓库锁定值。现有 HTTP 和桌面共享接口可用。

## 审查重点

- 访客和非管理员只看见对应权限的导航与 Banner 操作。
- 中文切换不重建页面或丢失未提交输入。
- 从窄屏菜单进入资源后收起导航，并保留正确的选中状态和可达性。
- 资源新建、返回及编辑的切换保留筛选和当前 Workspace。
- 生产静态资源与桌面构建分别通过正式入口，浏览器资源与品牌图可被正常打包。

---

### 任务一：将 TailAdmin 接入服务端 Web 应用

**文件范围**

- 修改 `apps/web/src/layout.tsx`、`apps/web/src/main.tsx`，按标签需要修改 `apps/web/src/locales/`。
- 新建仅用于 Web 的主题 `apps/web/src/admin.css`；仅当外壳与密集业务控件需要分开时增加第二份专用样式。
- 按资源界面的实际需要修改 `apps/web/src/features/resources/ResourcePage.tsx` 和 `apps/web/src/ui.tsx`。
- 更新 `THIRD_PARTY_NOTICES.md`，为改编的源码保留上游 MIT 许可声明。
- 测试入口为 `apps/web/tests/console/admin-layout.spec.ts`；仅在布局变更确有需要时调整既有定位器。

**接口约束**

- 为既有调用者保留 `AppShell({ children, onLogout })` 和 `ResourceWorkspaceView`；新增资源布局选项保持可选，共享调用沿用现有默认值。
- 设置链接使用 `/account`，退出调用既有 `onLogout`；导航继续复用现有角色与路由定义。
- 由 `main.tsx` 导入的服务端主题实现新设计令牌及响应式界面；`desktop.ts` 仍只导入共享样式。

- [x] 添加真实 Playwright 用例 `server console follows the approved layout`，验证头部顺序、设置可达性、当前导航，以及实测 56px Banner、14px 标题、13px 导航和 12px 表格文字。
- [x] 添加真实窄屏菜单用例，覆盖打开、选路由、关闭与重开时展示当前入口，同时检查页面宽度和选中分组。
- [x] 使用真实 Tornado 夹具、专用测试库与浏览器，验证打开及离开新建表单、保留类型筛选与 Workspace，并经既有接口提交。
- [x] 在未实现的基线上执行一次，保留缺失行为的失败断言。
- [x] 适配 TailAdmin 外壳、菜单、表单和表格，将 Web 专用样式应用于实际挂载路由及 Portal；账户与数据变更沿用现有端点。
- [x] 复跑定向用例与 Web 单测，并检查变更文件、相关既有浏览器流程和 Web/桌面构建；完整执行引擎验收的缺口另列。
- [x] 提交范围内实现与测试，由协调者完成任务复审及集成；整分支和最终发行验证仍单列执行。

### 集成

构建 Web 和桌面导出，使用 `scripts/stage_web.py` 暂存 Vite 产物，并验证服务端静态路由和 wheel 入包。执行 Web check，对照基线记录既有失败。合并前重新获取 `dev`；若发生相关变动，验证集成后推送并核对远端 SHA。具体完成范围与尚未满足的门禁见[验收记录](../validation/web-console.md)。

### 本轮集成状态

`35fd7be` 保留人工改造和迁移说明变更；`592235e` 完成定向焦点修复及独立复审。
11 项相关 GUI 与 46 项 Node 通过，桌面 68 个构建输出一致；锁定浏览器、完整 Runtime、全仓质量与正式发行仍开放。
