# Workspace Dropdown and Settings Implementation Plan

> For agentic workers, execute with superpowers:subagent-driven-development.

**Goal** 按 TailAdmin Default Dropdown 调整工作区切换器，并在顶栏提供加号创建和齿轮设置。

**Architecture** 使用现有 Radix 和 TailAdmin Free 视觉组件，继续将选择、创建、分页和权限交给当前工作区目录及既有页面。

**Spec** [Web Console](../specs/web-console.md)

## 实施与验收

- [x] 以真实浏览器测试菜单的选择、键盘、分页、添加、设置和侧栏入口。旧实现因缺少设置入口而失败。
- [x] 顶栏采用默认 Dropdown 的轮廓按钮、箭头和菜单卡片，保留清晰可读的选中状态、主题和窄屏边界。加号和齿轮只显示图标，并提供可访问名称。
- [x] 设置链接进入 `/workspaces`，侧栏移除重复入口。保留空目录、归档状态、分页失败后重试、深链接授权及切换中途的目录刷新行为。
- [x] 更新浏览器对工作区操作的通用辅助方法及相关调用，完成回归、构建和独立审查。

## 验证记录

- 30 项相关浏览器用例通过，涵盖分页与重试、320px 布局、键盘焦点、账号与邀请、报告深链接、目录刷新、资源编辑和 AI 工作区切换。
- 56 项 Web 单元测试、Web 静态检查、生产 HTTPS 验证及 Web 和桌面构建通过。
