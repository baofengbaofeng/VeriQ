<a id="adr-0023-veriq-id-element-locator"></a>
# 0023 被测系统元素定位标记 veriq-id

- 状态：待审批（proposed）。
- 日期：2026-11-17。
- 许可：不涉及新依赖或专有框架，沿用 AGPL-3.0。

<a id="background"></a>
## 背景

VeriQ 的用例通过 `ElementCatalogV1` 目录描述被测系统元素，`locator.by` 目前支持 `"testId"` 与 `"role"` 两种定位方式。`"testId"` 对应被测系统 HTML 上的 `data-testid` 属性，运行时由 Runner SDK 用 Playwright 的 `getByTestId` 解析。

同一术语 `data-testid` 也被 VeriQ 自身后台（`apps/web`）用于它自己的 Playwright 端到端测试，两处语义叠加导致概念混淆。用户明确要求：被测系统的元素定位标记统一为 `veriq-id`；VeriQ 后台自身不再保留 `testId`/`data-testid`/`veriq-id` 这类标记。选择稳定业务标记而非 xpath，是为了在页面结构变化时仍能可靠定位操作元素，避免测试脚本因选择器漂移而失效。

<a id="decision"></a>
## 决策

1. 被测系统元素定位属性由 `data-testid` 改为 `veriq-id`；DSL `locator.by` 由 `"testId"` 改为 `"veriqId"`，`value` 仍引用目录 Key。
2. Runner SDK 的 `locator()` 不再调用 `getByTestId`，改为按 `veriq-id` 属性定位（等价于 Playwright `getByAttribute("veriq-id", value)`）。
3. VeriQ 后台自身移除全部 `data-testid`（也不引入 `testId`/`veriq-id`）；其内部端到端测试改用可访问角色、名称、label 与文本定位。
4. `data-record-key` 保持不变，重复行仍用稳定业务 id 定位。

<a id="compatibility"></a>
## 兼容性等级

破坏性变更：删除 `locator.by` 的 `"testId"` 枚举值。迁移策略如下，须经审查显式标出：

- 被测系统将 `data-testid` 改为 `veriq-id` 后重新发布目录新版本。
- 依赖旧目录的用例在新版本下重新编译、审核；已完成的 Run 继续使用其冻结的目录与引擎版本，不追溯改写。
- 目录与用例契约经 `packages/contracts` 的 Schema/OpenAPI/生成类型/样例同步生成，不保留 `testId` 别名。

<a id="consequences"></a>
## 后果

- 被测系统、目录与用例存在迁移成本；旧 `data-testid` 标记在升级后不再被定位。
- Runner SDK 与编译器的既有测试样例需从 `by: "testId"`/`data-testid` 迁到 `veriqId`/`veriq-id`。
- VeriQ 后台端到端测试需改用 role/名称定位，重写成本与回归风险较高，且本沙箱无后端需在 CI 验证。

<a id="alternatives"></a>
## 替代方案

- 仅把属性名从 `data-testid` 改为 `veriq-id`、枚举仍保留 `testId`：减少枚举破坏，但概念仍混用且违背用户决策。
- 保持现状：不消除术语混淆，也不满足稳定定位的明确要求。
