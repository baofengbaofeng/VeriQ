# 0024 Web UI Dependencies

- 状态：用户已选定；本记录补充现有 Web 界面更新的依赖选型。
- 日期：2026-11-17。
- 许可：VeriQ 保留 AGPL-3.0；上游许可和署名义务继续适用。

保留侧边栏、账户菜单、右侧编辑抽屉、配色与可访问控件方向。Web 基础组件复用 Radix 和 CVA，避免另行实现焦点、菜单或提示框架。本决策不向已经安装并冻结的锁文件增加包或改变版本。

| 包                            | 精确版本 | 已安装包声明许可 | 用途与边界                                       |
| ----------------------------- | -------- | ---------------- | ------------------------------------------------ |
| @radix-ui/react-dropdown-menu | 2.2.1    | MIT              | 账户菜单的键盘导航、关闭与焦点管理               |
| @radix-ui/react-select        | 2.4.1    | MIT              | 可复用受控选择组件；既有原生控件继续保持原生实现 |
| @radix-ui/react-tooltip       | 1.4.1    | MIT              | 悬停和键盘聚焦时展示字段长建议                   |
| @radix-ui/react-dialog        | 1.3.1    | MIT              | 既有共享确认框和 Web 编辑抽屉                    |
| class-variance-authority      | 0.7.1    | Apache-2.0       | 既有共享及 Web 按钮的样式变体                    |

已核对上述直接依赖精确版本的安装许可元数据，以及新增解析的 19 个包的元数据；这 19 个包均为 MIT，且包含三个新增直接控件，并非在它们之外又新增 19 个传递依赖。其余新增项提供 Floating UI 定位、Radix 菜单与集合、方向、游走焦点、弹层与箭头、尺寸与矩形钩子、数值辅助和视觉隐藏内容。

既有解析版本没有漂移。React 18.3.1 下的严格 peer 安装已成功；共享与 Web Dialog 解析到相同版本和 peer 实例，因此不以重复依赖实例解释抽屉缺陷。

MIT 允许此用途，但必须保留版权与许可文本；CVA 继续履行 Apache-2.0 义务。分发物必须保留这些包及其解析依赖闭包实际提供的上游 LICENSE 文件，以及任何 NOTICE 或署名声明。包元数据不能替代这些许可原文或最终发行 SBOM，详见[第三方声明](../../THIRD_PARTY_NOTICES.md)。

协调者于 2026-11-17 执行 `pnpm audit --prod --json`，退出码为 0，info、low、moderate、high、critical 各级均未报告发现。这仅是当时生产依赖图的公告查询结果，不保证将来没有漏洞，也不等同于完整开发依赖图审计或平台验收。

精确安装元数据与命令证据保留在 `.superpowers/sdd/mvp-validation-20261117/resume-b0899f2/` 下的 `new-direct-licenses.json`、`new-transitive-licenses.json`、`lock-semantic-diff.json` 和 `dependency-audit.{json,log}`。

后续升级继续遵守精确钉死、冻结安装、严格 peer 检查、最短发布时间、完整性验证和重新许可与安全审查。封装层负责样式和本地化，Radix 负责焦点圈定及最上层关闭行为。浏览器回归仍须实际证明嵌套确认的指针点击、精确入口焦点恢复、键盘帮助和当前语言控件行为。这些 UI 库不引入后端、Schema、Runtime、凭据或原生平台保证。

[ADR 0023](0023-veriq-id-element-locator.md) 继续有效：`veriq-id` 属于被测系统；VeriQ 自身前端使用可访问名称、角色和标签，不引入测试定位标记。
