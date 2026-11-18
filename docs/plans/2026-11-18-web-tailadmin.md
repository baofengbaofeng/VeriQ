# VeriQ Web Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal** 交付用户已确认的紧凑服务端管理台，验证业务交互后合并并推送到 `dev`。

**Architecture** 在现有 Web 应用内适配 TailAdmin 头部和可展开分组侧栏。Web 入口单独应用紧凑主题。现有表单、路由、角色规则、资源控制器以及桌面导出接口是接入点。

**Tech Stack** React 18、Tailwind 3、Vite 6、React Router 7、Radix、i18next、Playwright、Tornado。

**Spec** [服务端管理台界面](../specs/web-console.md)

## Global Constraints

- Banner 桌面高 56px，侧栏宽 180–200px，导航不超过两级。
- 标题与品牌 14px，正文及控件 13px，表格与辅助提示 12px，触屏文本输入允许 16px。
- 浅灰侧栏和表单、白色主区和输入控件。使用现有彩色 VeriQ SVG。
- TailAdmin React Free `9aaac11e9e6fa87d0afe0e976b5ac291e29eeeb9` 源码适配保留 MIT 声明。
- React、Router、Vite、Tailwind 和全部依赖版本沿用仓库锁定值。现有 HTTP 和桌面共享接口可用。

## Review Focus

- 访客和非管理员只看见对应权限的导航与 Banner 操作。
- 中文切换不重建页面或丢失未提交输入。
- 从窄屏菜单进入资源后收起导航，并保留正确的选中状态和可达性。
- 资源新建、返回及编辑的切换保留筛选和当前 Workspace。
- 生产静态资源与桌面构建分别通过正式入口，浏览器资源与品牌图可被正常打包。

---

### Task 1: Adapt TailAdmin to the server Web application

**Files**

- Modify `apps/web/src/layout.tsx`, `apps/web/src/main.tsx`, `apps/web/src/locales/` as needed for labels.
- Create `apps/web/src/admin.css` as the Web-only theme. Use a second focused stylesheet only if needed to separate shell and crowded business controls.
- Modify `apps/web/src/features/resources/ResourcePage.tsx` and `apps/web/src/ui.tsx` as needed for the resource screen.
- Modify `THIRD_PARTY_NOTICES.md` and retain the upstream MIT permission notice for adapted source.
- Test `apps/web/tests/console/admin-layout.spec.ts`; update existing locators only when layout changes require it.

**Interfaces**

- Maintain `AppShell({ children, onLogout })` and `ResourceWorkspaceView` for existing callers. Any resource layout option is additive and shared calls keep their existing default.
- Settings links to `/account`; logout calls the existing `onLogout`; navigation continues to use the existing role and route definitions.
- A single server theme imported by `main.tsx` implements the new tokens and responsive surfaces. `desktop.ts` continues to import the shared stylesheet only.

- [ ] Add a real Playwright test `server console follows the approved layout` for ordered header, accessible Settings, current navigation, measured 56px Banner and 14px title, 13px navigation and 12px table text.
- [ ] Add a real Playwright test for small viewport menu opening, selecting a route, closing and re-opening with the current entry exposed. Check the page width and preserve the active branch.
- [ ] Add a real resource flow test for opening and leaving the new form, preserving type filter and Workspace, and submitting through the existing create path. Use the actual Tornado fixture, target test schema and browser.
- [ ] Run the tests on the base once to verify the intended missing behavior. Record failing assertions.
- [ ] Adapt TailAdmin shell, menus and visual form/table patterns. Apply Web-only styles to actual mounted routes and to portal content. Keep account settings and all data mutations on the current endpoints.
- [ ] Rerun the focused tests and Web unit suite. Check the changed files, relevant existing browser flows and production/desktop builds before reporting.
- [ ] Commit the scoped implementation and tests. The coordinator performs review, whole-branch validation, and integration.

### Integration

Build Web and desktop exports, stage Vite output with `scripts/stage_web.py`, and verify the server static route and wheel packaging tests. Run the Web check and record any pre-existing failures by comparison to the baseline. Re-fetch `dev` before merging, retest the integration if it moved, then push and verify the remote SHA.
