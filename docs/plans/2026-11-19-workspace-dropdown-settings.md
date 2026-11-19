# Workspace Dropdown and Settings Implementation Plan

> For agentic workers, execute with superpowers:subagent-driven-development.

**Goal** 按 TailAdmin Default Dropdown 调整工作区切换器，并在顶栏提供加号创建和齿轮设置。

**Architecture** 使用现有 Radix 和 TailAdmin Free 视觉组件，继续将选择、创建、分页和权限交给当前工作区目录及既有页面。

**Spec** [Web Console](../specs/web-console.md)

## 实施与验收

- [ ] 以真实浏览器测试菜单的选择、键盘、分页、添加、设置和侧栏入口。旧实现缺少设置入口或非原生弹层时应失败。
- [ ] 顶栏采用默认 Dropdown 的轮廓按钮、箭头和菜单卡片，保留清晰可读的选中状态、主题和窄屏边界。加号和齿轮只显示图标，并提供可访问名称。
- [ ] 设置链接进入 `/workspaces`，侧栏移除重复入口。保留空目录、归档状态、分页失败后重试、深链接授权及切换中途的目录刷新行为。
- [ ] 更新浏览器对工作区操作的通用辅助方法及相关调用。完成回归、构建和独立审查后合入 `dev`。
