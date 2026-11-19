# TailAdmin Banner and User Menu Implementation Plan

> For agentic workers, execute with superpowers:subagent-driven-development.

**Goal** 对齐新版 TailAdmin Free 的 Banner 高度、右侧圆角方形和用户菜单。

**Architecture** 在现有 Web 外壳和 Radix 下拉菜单中应用新版源码尺寸与层级。账号、语言和主题复用 VeriQ 现有行为。

**Spec** [Web Console](../specs/web-console.md)

## 实施与验收

- [ ] 添加浏览器回归并验证旧 56px 桌面高度或旧平铺语言项触发失败。
- [ ] 对齐桌面 77px 及窄屏首行尺寸，保持已有工作区及右侧控件可操作。主题 44px 和头像 44px 分别使用 10px、8px 圆角。
- [ ] 还原姓名、邮箱、设置、语言子菜单和退出的间距、层级和图标。验证展开、键盘、视口翻转、语言即时切换、设置聚焦以及退出流程。
- [ ] 验证浏览器回归、Web 静态检查和构建。独立审查后合入 `dev`。
