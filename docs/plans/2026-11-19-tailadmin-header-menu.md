# TailAdmin Banner and User Menu Implementation Plan

> For agentic workers, execute with superpowers:subagent-driven-development.

**Goal** 对齐新版 TailAdmin Free 的 Banner 高度、右侧圆角方形和用户菜单。

**Architecture** 在现有 Web 外壳和 Radix 下拉菜单中应用新版源码尺寸与层级。账号、语言和主题复用 VeriQ 现有行为。

**Spec** [Web Console](../specs/web-console.md)

## 实施与验收

- [x] 添加浏览器回归，验证旧 56px 桌面高度触发失败。
- [x] 对齐桌面 77px 及窄屏首行尺寸，保持已有工作区及右侧控件可操作。主题 44px 和头像 44px 分别使用 10px、8px 圆角。
- [x] 还原姓名、邮箱、设置、语言子菜单和退出的间距、层级和图标。验证展开、键盘、视口边界、语言即时切换、设置聚焦以及退出流程。
- [x] 完成浏览器回归、Web 静态检查、构建及独立审查。

## 验证记录

- 21 项浏览器回归通过，覆盖宽窄屏、鼠标与键盘、语言和草稿状态、账号、报告及工作区生命周期。极窄视口的语言选项在同一弹层内向下展开。
- 56 项 Web 单元测试、生产 HTTPS 验证及 Web 和桌面构建通过。
