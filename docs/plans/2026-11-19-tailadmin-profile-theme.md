# TailAdmin Profile and Theme Implementation Plan

> For agentic workers, use superpowers:subagent-driven-development and verify each stage before integration.

**Goal** 将 TailAdmin Free 的 Profile 头部、菜单及资料页样式接入 VeriQ，支持持久化的浅色和深色主题。

**Architecture** 使用固定版本的官方组件为视觉基准，沿用 Web 的 Radix、账号 API 和全局工作区。主题记忆仅由 Web 层管理，主题样式覆盖外壳、业务页面和 Portal。

**Spec** [Web Console](../specs/web-console.md)

## 约束

- 以上游 Profile 布局作为直接参照，沿用已有尺寸上限及紧凑 Banner。账号页采用标题、面包屑、外层和内层圆角卡片、头像及真实资料。
- 登录区展示 44px 圆形主题按钮、用户头像、姓名、可旋转箭头及右对齐的 260px 弹层。个人信息、设置、语言及退出使用实际应用数据或行为。
- 页面和弹层应用 TailAdmin 的深浅色系。主题在路由、重新加载与登录状态切换后保留，存储受限时仍可切换。
- 使用 VeriQ 现有资料、密码、会话和退出功能。头像通过真实姓名生成，通知流、地址与社交信息没有现有数据源。保持桌面入口和工作区逻辑。

## 实施与验收

- [x] 先写浏览器回归，核对主题按钮、用户菜单、Profile 卡片及主题跨页和刷新。首轮因旧版缺少主题按钮而失败。
- [x] 按已登记的 MIT 源码适配头部、Profile、主题切换和必要译文。保留键盘导航、设置后标题聚焦和紧凑断点。
- [x] 跑红绿用例及相邻布局、语言、账号回归，再检查类型、格式、代码宽度和两个构建入口。
- [x] 独立审查样式和行为，核对功能分支以最新 `dev` 为基线。

## 验证记录

- 两轮浏览器回归覆盖 16 个不同用例。主题可跨页和刷新保留，可在浏览器偏好存储受限时切换。深色主题保留主按钮对比度、选中状态、表单草稿和工作区。
- 56 项 Web 单元测试、类型和格式检查、Web 和桌面构建均通过。生产 HTTPS 在暂缓 Web 入口脚本时仍可恢复已保存主题，之后完成真实页面加载。
