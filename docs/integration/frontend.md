# VeriQ 前端接入规范

本文面向被测业务系统的 React 18 / Vite 前端。VeriQ 的定位器契约以[公共 Schema](../../packages/contracts/schemas/platform-v1.schema.json)为准；测试目录、用例和断言发布后固定版本。前端团队维护可观察的业务界面，测试团队将这些锚点登记为 `ELEMENT_CATALOG`，再使用相同编译器和 SDK 执行回归。

## 接入交付清单

| 交付物 | 前端要求 | 验证方式 |
| --- | --- | --- |
| 稳定锚点 | 关键输入、操作、结果、错误、加载和空态提供 `data-testid` | 使用 Playwright `getByTestId` 检查实际 DOM |
| 重复记录 | 行使用稳定业务标识 `data-record-key`，行内按钮保留统一 testId | 改变排序、分页和筛选后仍定位同一记录 |
| 目录 | 记录元素 key、定位方式、作用域及变更负责人 | 目录通过 Schema 和用例编译校验 |
| 状态语义 | 正确使用 label、role、disabled、checked、aria 属性 | 同时验证可访问名称、键盘和真实行为 |
| 确定性环境 | 固定 locale、时区、测试数据和应用 build SHA | 同一输入可重复断言日期、金额和状态 |
| 网络关联 | 提供可识别的业务主键、请求参数和稳定接口契约 | 操作观察器能区分后台刷新与目标提交 |
| 登录和权限 | 使用真实业务认证与角色授权 | GUI 显示与后端权限分别验证 |
| 测试环境 | 控制第三方依赖、动画和初始数据，通过配置记录差异 | Runtime 实际可访问被测地址及相关 API |

## testId 与重复行

统一使用 `data-testid` 属性。推荐采用 `employee.create`、`employee.name`、`employee.save`、`employee.error` 等业务语义名称；稳定的名称可跨文案、CSS 和组件重构复用。目录的 `key` 及 testId 值符合 `^[A-Za-z_][A-Za-z0-9_.-]*$`，最多 160 字符。

数组下标、随机数、翻译后的文案和 CSS 类名不能承担记录身份。React 的 `key` 用于协调渲染，仍需显式输出 `data-record-key` 到 DOM。该值使用非敏感、稳定的记录标识，不能携带 token、密码或个人敏感字段。

```tsx
<table data-testid="employee.table">
    <tbody>
        {employees.map((employee) => (
            <tr
                key={employee.id}
                data-testid="employee.row"
                data-record-key={employee.id}
            >
                <td data-testid="employee.name">{employee.name}</td>
                <td>
                    <button
                        type="button"
                        data-testid="employee.edit"
                        onClick={() => editEmployee(employee.id)}
                    >
                        {t("employee.edit")}
                    </button>
                </td>
            </tr>
        ))}
    </tbody>
</table>
```

对应的目录文档如下。`recordKey` 匹配的是该元素自身的 `data-record-key`；先定位目标行，再用 `scope` 查找行内按钮。`{{vars.employeeId}}` 必须来自已声明的初始变量、受控 fixture 输出或已验证的响应提取。

```json
{
    "schemaVersion": "1.0",
    "elements": [
        {
            "key": "employee.table",
            "locator": { "by": "testId", "value": "employee.table" }
        },
        {
            "key": "employee.row",
            "locator": { "by": "testId", "value": "employee.row" },
            "scope": "employee.table",
            "recordKey": "{{vars.employeeId}}"
        },
        {
            "key": "employee.edit",
            "locator": { "by": "testId", "value": "employee.edit" },
            "scope": "employee.row"
        }
    ]
}
```

当前 DSL 支持 `testId` 和 `role` 两种目录定位方式；role 名称可以配合 `name`、`exact`。平台动作要求目标唯一，重复匹配会失败。目录作用域不能形成环；已发布目录改动需创建新版本并检查依赖用例。移动到新版目录后重新编译和审核用例，既有 Run 继续使用其冻结版本。

## 组件库要求

| 技术 | 接入要求 | 需要覆盖的场景 |
| --- | --- | --- |
| 自写 UI / CVA | 将 `data-*`、`aria-*`、事件、disabled 和 ref 透传到真实交互元素；variant 只影响展示 | 按钮禁用、表单错误、不同 variant 均可定位 |
| Radix / asChild | 确认属性落在最终 DOM；Trigger 和 Portal Content 分别设置锚点 | 打开、关闭、Escape、焦点恢复、弹层内选择 |
| Portal | 目录作用域按实际 DOM 定义；挂到 body 的内容使用独立根锚点 | 同屏多个弹层、隐藏旧实例及卸载 |
| TanStack Query | 展示提交中、成功和失败状态；观察器区分 mutation 与后台 refetch | 乐观更新随后失败、缓存失效、旧响应晚到 |
| react-router | 使用实际导航和 URL 状态；页面就绪由业务内容体现 | 深链接、返回、路由参数、无权限和不存在页面 |
| i18next | 测试环境固定语言并记录；需要文案断言时使用对应语言的受控预期 | 中文、英文及切换后的错误和日期 |
| dnd-kit | 给拖动项及目标稳定身份，优先提供正常键盘交互 | 键盘移动、取消、顺序持久化和刷新后结果 |
| DOMPurify | 保持正常清洗配置；在清洗内容外层提供业务锚点 | 危险内容被清除、允许的富文本正确呈现 |
| 虚拟表格 | 通过分页、搜索、滚动等真实操作使目标进入已渲染范围 | 离屏记录、排序变化和重新挂载 |

保留用户实际可感知的加载、空态与错误态，不向测试提供绕过表单校验、权限或提交逻辑的专用点击入口。敏感数据仍适用正常隐藏与脱敏规则。

## 将点击与断言关联

一个保存步骤通常需要以下证据：操作前输入合法且按钮可用；操作触发了预期请求；响应 HTTP 状态、业务码和字段正确；界面显示结果；只读业务查询证明数据已持久化。成功 toast 只说明界面收到一个结果，不能独立证明数据已经落库。

| 断言层 | 推荐检查 | 预期依据 |
| --- | --- | --- |
| UI | 唯一元素、可见性、enabled、文本、值、数量 | 需求、设计和受控数据 |
| 请求 | API origin、method、path、关联 query/body | 固定 OpenAPI 与当前 fixture |
| 响应 | HTTP 状态、业务码、RFC6901 JSON Pointer、JSON Schema | 已审核的接口契约 |
| 业务结果 | 以返回 ID 或幂等键做只读查询 | 原始测试输入及业务规则 |
| 持久化 | 刷新或重新查询后仍保持正确值 | 独立查询结果与受控预期 |
| 最终一致 | 在限定总时间内只读轮询到预期状态 | 明确的异步业务时限 |

VeriQ 在动作前安装该步骤的观察器，避免快速响应先于监听。对于 TanStack Query，单独匹配一个 GET 路径可能捕获背景刷新；应追加该次操作的业务标识和参数。以下是网络观察器片段，需放入实际步骤的 `observers`，不是完整用例：

```json
{
    "id": "employee.saveRequest",
    "method": "PUT",
    "path": "/api/employees/{{vars.employeeId}}",
    "bodyMatch": { "name": "{{data.name}}" },
    "timeoutMs": 10000,
    "retryPolicy": "FORBID"
}
```

请求数量必须绑定观察窗口；当前契约要求 `expectedCount` 配合 `FIXED` 窗口，不能用一步的局部观察宣称整个 Run 没有重复请求。接口存在合法重试时，应明确允许匹配重试并保留幂等策略。写入结果未知时先查询业务结果，不能通过再次点击使测试变绿。

Playwright 自动等待用于正常可交互状态。最终一致由有限的只读查询处理；默认每 500ms 检查、总限 10 秒，可按用例配置。不要用固定 sleep、force click、移除 disabled 或修改 DOM 替代业务就绪。截图和 Trace 是故障证据，访问权限、脱敏和保留期仍由平台管理。

## 前端变更与回归

提交 UI 变更时，列出受影响的 testId、recordKey、Portal 结构、目录版本和用例。纯文案/样式变动仍应检查 role 名称与可见性断言；接口变更同步通知后端和测试资产负责人。

接入验收至少覆盖：稳定唯一定位、表单成功与失败、后台刷新关联、重复行排序、Portal、中文/英文、键盘、真实权限、乐观更新回滚，以及写入后的独立查询。企业业务系统需要用自己的环境和身份执行这些检查；仓库示例通过不能替代客户系统验收。

## Implementation references

The current contract supports stable test IDs, role locators, nested catalog scopes and exact `data-record-key` filtering. See [locator resolution](../../packages/runner-sdk/src/context.ts), [action execution](../../packages/runner-sdk/src/execute-step.ts), [UI assertions](../../packages/runner-sdk/src/assertions/ui.ts), [network observers](../../packages/runner-sdk/src/observers/network.ts) and the [backend integration contract](backend.md). Examples above describe integration patterns; final full-product and installed-platform acceptance remains tracked in the [milestone ledger](../plans/milestones.md).
