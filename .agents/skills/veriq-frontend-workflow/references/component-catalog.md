# VeriQ 前端组件索引

按用户要完成的动作找组件。条目中的「复用」指可直接沿用的 VeriQ 入口，「组合」指可借鉴的本地
页面写法。标为「上游候选」的条目提供适配参考。已有做法覆盖时，读取该条的本地实现及本次调用。
新适配或需要确认具体交互时，只查对应的上游源文件和许可。

上游链接固定到 TailAdmin React Free v2.5.1 的提交 `486ed748b21e032a4432effeca4ef3684fa223d3`。
TailAdmin 现行 React 文档采用 React 19、Tailwind CSS 4 和 Base UI，可用来了解组件概念。核验免费
版组件以固定提交的源码为准。VeriQ 采用 React 18、Tailwind CSS 3 和已锁定的 Radix、CVA，按
本地 API、样式、本地化与可访问语义适配。采用上游源码时，记录提交与文件并保留版权和 MIT
许可证原文。依赖变更沿用仓库的审批和 ADR 规则。
[官方 React 文档][官方] · [上游包清单][上游包] · [MIT 原文][MIT] · [第三方声明][声明] · [ADR 0024][ADR]

## 列表、筛选和记录操作

- **选一个筛选值或表单值。** 上游 `Select`、`SelectItem`。复用 Web `Select` 与 `SelectItem`，
  展示当前值并本地化选项。资源列表的状态筛选支持「全部」及单个状态，工作区邀请表单用它选择一个
  角色。工作区成员角色可多选，参考同页 `RoleFilter` 的 Radix 菜单复选项。
  [上游 Select][u-select] · [Web Select][select] · [资源列表][资源] · [工作区成员和邀请][工作区]
- **从同一入口选择一项命令。** 上游 `DropdownMenu`、`DropdownMenuItem`。在 Web 组合 Radix
  Dropdown Menu，参考测试 Agent 会话的「更多选项」及账户菜单。用可访问名称表明触发按钮和目标，
  按当前记录和权限提供命令。命令执行后的状态沿用下文的确认与结果入口。
  [上游 DropdownMenu][u-dropdown] · [会话行菜单][Agent] · [账户菜单][布局]
- **在锚点附近编辑一组设置。** 上游 `Popover`、`PopoverContent` 是上游候选，用于含多个可聚焦控件
  的局部表单或面板。参考现有工作区 `RoleFilter` 可在命令菜单内完成的复选筛选，新增含输入框或
  完整表单的浮层时按其焦点语义适配。简短帮助使用 `Tooltip`。
  [上游 Popover][u-popover] · [工作区筛选][工作区] · [Web Tooltip][tooltip]
- **展示系统表格。** Web、Electron 和共享视图统一复用 `DataTable`，采用 Data Table 3 的表身、
  记录范围、分页及当前页下载。工具栏按 Basic Table 5 分组组织搜索、筛选和操作。用语义化
  `table` 保留业务列和行操作。已有完整数据的视图复用 `useTableView` 筛选和分页，服务端游标
  视图按实际游标获取对应页和已授权记录。
  [数据表格规范][数据表格] · [共享表格][table-view] · [资源列表][资源] · [工作区表格][工作区]
- **标记状态或权限角色。** 上游 `Badge` 提供视觉参考。按成员账户、邀请和 AI 供应商的现有写法，
  用本地化文字配合 `data-tone` 表达状态。成员角色用其已本地化的角色文字表达，操作资格从工作区
  授权判定。资源生命周期参考列表的 `data-status`。颜色辅助识别，徽标承担信息展示。
  [上游 Badge][u-badge] · [徽标样式][管理样式] · [成员和邀请][工作区] · [供应商启停状态][供应商] ·
  [资源状态][资源]

## 确认、反馈和编辑

- **执行确认与操作反馈。** 上游 `Dialog` 是外观和结构参考。执行前确认用 Web 本地化的
  `ConfirmDialog`，参考资源归档。等待与最终结果由共享 `OperationFeedbackProvider` 在同一个 Dialog
  内呈现，通过 `useOperationFeedback` 接收真实业务状态。[操作规范][规范]
  [上游 Dialog][u-dialog] · [Web 确认封装][locale-ui] · [共享确认][shared-ui] ·
  [资源归档][资源] · [供应商删除][供应商] · [共享结果][反馈]
- **显示加载、空态或读取失败。** 上游 `Alert` 适用于需要持续显示的页面提醒，`Skeleton` 是
  占位视觉候选。沿用资源页面的加载 `status`、空表格及可重试错误区。已知进度值适用上游
  `Progress`（`progress-bar.tsx`，上游候选），可先核对资源校验现有的排队和状态文字。
  [上游 Alert][u-alert] · [上游 Skeleton][u-skeleton] · [上游 Progress][u-progress-bar] · [资源页][资源]
- **保留列表上下文并编辑复杂内容。** 上游 `Sheet`、`SheetContent` 提供抽屉结构参考。复用
  VeriQ 基于 Radix Dialog 的 `Sheet`，参考资源编辑或数据集复制。直角、三分之一、左缘拖动与
  全宽切换遵循 VeriQ 自有布局与显式参数。[上游 Sheet][u-sheet] · [Web Sheet][sheet] ·
  [资源抽屉][资源] · [界面规范][规范]
- **输入、校验和帮助。** 上游 `Field`、`Input`、`Textarea` 和 `Tooltip`。单行输入与多行
  输入分别复用 Web `Input`、`Textarea`，用 `Field` 关联说明和校验。资源名称和键名展示普通
  说明与长帮助。多行 JSON 输入参考执行计划变量的原生 `textarea`。
  [上游 Field][u-field] · [上游 Input][u-input] · [上游 Textarea][u-textarea] · [上游 Tooltip][u-tooltip] ·
  [Web Field][field] · [Web Input / Textarea][input] · [Web Tooltip][tooltip] · [资源表单][资源] ·
  [执行计划变量][执行计划]
- **呈现提交、编辑和取消按钮。** 上游 `Button` 提供视觉参考。Web 的 `Button` 提交用蓝色
  `primary`，删除用红色 `danger`。桌面直接使用的共享控件查 `@veriq/ui`。资源列表新建与数据集复制展示不同
  动作语气。按钮组的 `ButtonGroup` 是上游候选，适用于语义相关且相邻的操作。
  [上游 Button][u-button] · [上游 ButtonGroup][u-button-group] · [Web Button][button] ·
  [共享 UI][shared-ui] · [资源操作][资源]
- **设置独立项或一组互斥项。** 上游 `Checkbox`、`RadioGroup` 与 `Switch` 对应独立勾选、
  一组互斥值及即时开关。复用现有原生控件和标签，如 AI 供应商的启用复选框随表单保存、工作区
  菜单用 Radix 单选组选取当前工作区。需要新的独立即时开关时参考上游 `Switch`。
  [上游 Checkbox][u-checkbox] · [上游 RadioGroup][u-radio-group] · [上游 Switch][u-switch] ·
  [供应商表单][供应商] · [工作区菜单][工作区菜单]

## 页面骨架和导航

- **在控制台内定位页面。** 上游 `AppLayout`、页眉、`Sidebar` 和 `PageBreadcrumb` 提供视觉和
  结构参考。组合 VeriQ 的 `AppShell`、`PageBreadcrumb` 与现有侧栏分组，参考账户和资源路由。
  独立登录使用自己的 `AuthLayout`。
  [上游 AppLayout][u-layout] · [上游页眉][u-header] · [上游 Sidebar][u-sidebar] ·
  [上游 PageBreadcrumb][u-breadcrumb] · [Web 壳层][布局] · [Web 路由][路由] · [独立登录][登录布局]
- **组织同页不同内容或分组。** 上游 `Tabs`、`Card`、`ComponentCard` 是结构与视觉参考。工作区
  设置复用 `SettingsTabList` 和 `SettingsPanel` 切换成员、邀请等区域，页面级标题和操作参考
  `Panel` 及系统用户目录，资料区参考账户页。
  [上游 Tabs][u-tabs] · [上游 Card][u-card] · [上游 ComponentCard][u-component-card] ·
  [工作区页签][页签] · [Panel][ui] · [用户目录][用户] · [账户资料][账户]
- **显示身份或展开局部详情。** 上游 `Avatar` 对应 Web 的名称头像，参考账户页和页眉。
  上游 `Accordion` 提供一组折叠项的设计参考，报告页的原生 `details` 适合独立展开步骤详情。
  [上游 Avatar][u-avatar] · [上游 Accordion][u-accordion] · [Web Avatar][avatar] ·
  [账户资料][账户] · [报告详情][报告]
- **查看按日期安排的事件。** 上游候选。TailAdmin 的 `CalendarPage` 在主内容区装配 `Calendar`，
  适合作为日期网格和事件安排的布局参考。若未来采用该交互，按本地依赖与授权规则适配。
  [上游 CalendarPage][u-calendar]

[官方]: https://tailadmin.com/docs/components/react
[声明]: ../../../../THIRD_PARTY_NOTICES.md#tailadmin-react-free-界面来源
[ADR]: ../../../../docs/decisions/0024-网页界面依赖.md
[规范]: ui-standards.md
[数据表格]: ui-standards.md#数据表格
[select]: ../../../../apps/web/src/components/Select.tsx
[tooltip]: ../../../../apps/web/src/components/Tooltip.tsx
[sheet]: ../../../../apps/web/src/components/Sheet.tsx
[field]: ../../../../apps/web/src/components/Field.tsx
[input]: ../../../../apps/web/src/components/Input.tsx
[button]: ../../../../apps/web/src/components/Button.tsx
[avatar]: ../../../../apps/web/src/components/Avatar.tsx
[table-view]: ../../../../apps/web/src/table-view.tsx
[locale-ui]: ../../../../apps/web/src/locale-ui.tsx
[shared-ui]: ../../../../packages/ui/src/index.tsx
[ui]: ../../../../apps/web/src/ui.tsx
[反馈]: ../../../../apps/web/src/operation-feedback.tsx
[布局]: ../../../../apps/web/src/layout.tsx
[登录布局]: ../../../../apps/web/src/auth-layout.tsx
[路由]: ../../../../apps/web/src/main.tsx
[账户]: ../../../../apps/web/src/pages/account.tsx
[用户]: ../../../../apps/web/src/pages/users.tsx
[Agent]: ../../../../apps/web/src/features/agent/AgentWorkspaceView.tsx
[资源]: ../../../../apps/web/src/features/resources/ResourcePage.tsx
[执行计划]: ../../../../apps/web/src/features/runs/ExecutionPlansPage.tsx
[管理样式]: ../../../../apps/web/src/admin.css
[工作区]: ../../../../apps/web/src/features/workspaces/WorkspacePage.tsx
[工作区菜单]: ../../../../apps/web/src/features/workspaces/WorkspaceControls.tsx
[页签]: ../../../../apps/web/src/features/workspaces/SettingsTabs.tsx
[供应商]: ../../../../apps/web/src/features/ai/ProviderControls.tsx
[报告]: ../../../../apps/web/src/features/reports/ReportPage.tsx
[上游包]:
    https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/486ed748b21e032a4432effeca4ef3684fa223d3/package.json
[MIT]:
    https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/486ed748b21e032a4432effeca4ef3684fa223d3/LICENSE.md
[u-layout]:
    https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/486ed748b21e032a4432effeca4ef3684fa223d3/src/components/layout/app-layout/index.tsx
[u-header]:
    https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/486ed748b21e032a4432effeca4ef3684fa223d3/src/components/layout/app-layout/header/index.tsx
[u-breadcrumb]:
    https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/486ed748b21e032a4432effeca4ef3684fa223d3/src/components/shared/page-breadcrumb.tsx
[u-component-card]:
    https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/486ed748b21e032a4432effeca4ef3684fa223d3/src/components/shared/component-card.tsx
[u-calendar]:
    https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/486ed748b21e032a4432effeca4ef3684fa223d3/src/pages/main/calendar/index.tsx
[u-select]:
    https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/486ed748b21e032a4432effeca4ef3684fa223d3/src/components/ui/select.tsx
[u-dropdown]:
    https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/486ed748b21e032a4432effeca4ef3684fa223d3/src/components/ui/dropdown.tsx
[u-popover]:
    https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/486ed748b21e032a4432effeca4ef3684fa223d3/src/components/ui/popover.tsx
[u-badge]:
    https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/486ed748b21e032a4432effeca4ef3684fa223d3/src/components/ui/badge.tsx
[u-dialog]:
    https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/486ed748b21e032a4432effeca4ef3684fa223d3/src/components/ui/dialog.tsx
[u-alert]:
    https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/486ed748b21e032a4432effeca4ef3684fa223d3/src/components/ui/alert.tsx
[u-skeleton]:
    https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/486ed748b21e032a4432effeca4ef3684fa223d3/src/components/ui/skeleton.tsx
[u-progress-bar]:
    https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/486ed748b21e032a4432effeca4ef3684fa223d3/src/components/ui/progress-bar.tsx
[u-sheet]:
    https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/486ed748b21e032a4432effeca4ef3684fa223d3/src/components/ui/sheet.tsx
[u-field]:
    https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/486ed748b21e032a4432effeca4ef3684fa223d3/src/components/ui/field.tsx
[u-input]:
    https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/486ed748b21e032a4432effeca4ef3684fa223d3/src/components/ui/input.tsx
[u-textarea]:
    https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/486ed748b21e032a4432effeca4ef3684fa223d3/src/components/ui/textarea.tsx
[u-tooltip]:
    https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/486ed748b21e032a4432effeca4ef3684fa223d3/src/components/ui/tooltip.tsx
[u-button]:
    https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/486ed748b21e032a4432effeca4ef3684fa223d3/src/components/ui/button.tsx
[u-button-group]:
    https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/486ed748b21e032a4432effeca4ef3684fa223d3/src/components/ui/button-group.tsx
[u-checkbox]:
    https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/486ed748b21e032a4432effeca4ef3684fa223d3/src/components/ui/checkbox.tsx
[u-radio-group]:
    https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/486ed748b21e032a4432effeca4ef3684fa223d3/src/components/ui/radio-group.tsx
[u-switch]:
    https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/486ed748b21e032a4432effeca4ef3684fa223d3/src/components/ui/switch.tsx
[u-sidebar]:
    https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/486ed748b21e032a4432effeca4ef3684fa223d3/src/components/ui/sidebar.tsx
[u-tabs]:
    https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/486ed748b21e032a4432effeca4ef3684fa223d3/src/components/ui/tabs.tsx
[u-card]:
    https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/486ed748b21e032a4432effeca4ef3684fa223d3/src/components/ui/card.tsx
[u-avatar]:
    https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/486ed748b21e032a4432effeca4ef3684fa223d3/src/components/ui/avatar.tsx
[u-accordion]:
    https://github.com/TailAdmin/free-react-tailwind-admin-dashboard/blob/486ed748b21e032a4432effeca4ef3684fa223d3/src/components/ui/accordion.tsx
