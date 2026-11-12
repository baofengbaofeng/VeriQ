/**
 * 用例/流程步骤编辑器：动作参数、观察者、前后断言与数据集/变量绑定。callFlow 只引用已发布流程版本；callFlow 动作只允许引用已发布的流程版本。
 * flow=true 时编辑参数声明而非 caseKey；版本引用保持固定 UUID。
 */

import type { StepV1, ObserverV1 } from "@veriq/contracts";
import {
    Field,
    JsonField,
    List,
    TypeMap,
    StringList,
    VersionField,
    methods,
    types,
    useSet,
    useValue,
    type VersionOption,
} from "../resources/fields";
import { AssertionEditor } from "../assertions/AssertionEditor";
const actions = [
    "goto",
    "click",
    "fill",
    "check",
    "uncheck",
    "press",
    "selectOption",
    "upload",
    "reload",
    "apiRequest",
    "callFlow",
];
const actionDefaults = (action: string) =>
    action === "goto"
        ? { path: "/" }
        : ["click", "check", "uncheck"].includes(action)
          ? { target: "name" }
          : ["fill", "press"].includes(action)
            ? { target: "name", value: "" }
            : action === "selectOption"
              ? { target: "name", value: "" }
              : action === "upload"
                ? { target: "name", value: ["files/example.txt"] }
                : action === "apiRequest"
                  ? { method: "GET", path: "/" }
                  : action === "callFlow"
                    ? { versionId: "" }
                    : {};
/**
 * 工厂：默认 goto / 的步骤，id 含短 UUID，供步骤 List 新增行。后续由 action 切换填充默认参数。
 * actionDefaults 在类型切换时填充，避免缺字段导致保存失败。
 */
export const newStep = (): StepV1 => ({
    id: "step_" + crypto.randomUUID().slice(0, 8),
    action: "goto",
    path: "/",
});
/**
 * 拥有 steps/initialVariables/dataset 绑定 UI，并嵌入 AssertionEditor。
 * fixtureBindings 合并数据集列与变量供填充提示；不发起 Workspace API。
 */
export function CaseEditor({
    versions,
    flow = false,
}: {
    versions: VersionOption[];
    flow?: boolean;
}) {
    const steps = useValue<StepV1[]>("content.document.steps") ?? [];
    const initialVariables =
        useValue<Record<string, string> | undefined>("content.document.initialVariables") ?? {};
    const datasetVersionId = useValue<string | undefined>("content.document.datasetVersionId");
    const dataset = versions.find((v) => v.id === datasetVersionId)?.content;
    const fixtureBindings = [
        ...(dataset?.kind === "DATASET"
            ? Object.keys(dataset.document.columns).map((key) => "{{data." + key + "}}")
            : []),
        ...Object.keys(initialVariables).map((key) => "{{vars." + key + "}}"),
    ];
    return (
        <>
            {flow ? (
                <TypeMap
                    name="content.document.parameters"
                    label="流程参数声明 / Flow parameters"
                />
            ) : (
                <>
                    <Field name="content.document.caseKey" label="用例 key / Case key" />
                    <Field name="content.document.title" label="标题 / Title" />
                    <Field
                        name="content.document.kind"
                        label="读写类型 / Case kind"
                        options={["READ", "WRITE"]}
                    />
                    <Field name="content.document.roleKey" label="业务角色 / Business role" />
                    <VersionField
                        name="content.document.catalogVersionId"
                        label="元素目录版本 / Catalog version"
                        kind="ELEMENT_CATALOG"
                        versions={versions}
                    />
                    <VersionField
                        name="content.document.fixtureVersionId"
                        label="Fixture 版本 / Fixture version"
                        kind="FIXTURE"
                        versions={versions}
                        optional
                    />
                    <VersionField
                        name="content.document.datasetVersionId"
                        label="数据集版本 / Dataset version"
                        kind="DATASET"
                        versions={versions}
                        optional
                    />
                    <Field
                        name="content.document.persistenceCheckpointStepId"
                        label="持久化检查点 / Persistence checkpoint"
                        options={steps.map((s) => s.id)}
                        optional
                    />
                    <TypeMap
                        name="content.document.initialVariables"
                        label="初始变量类型声明 / Initial variable declarations"
                    />
                    <small>
                        这里只声明类型；实际值在执行时冻结，不写入生成源码 / Types only; values
                        belong to execution snapshots.
                    </small>
                    <small>
                        准备前只能引用所选数据集和已声明初始变量，不包含未来 Fixture 输出或提取值 /
                        Before prepare: selected data columns and declared initial variables only.
                    </small>
                    <JsonField
                        name="content.document.fixtureInput"
                        label="Fixture 输入绑定 / Fixture input bindings"
                        bindings={fixtureBindings}
                        allowBinding
                    />
                </>
            )}
            <List name="content.document.steps" title="步骤 / Steps" initial={newStep}>
                {(path, index) => (
                    <StepFields
                        path={path}
                        versions={versions}
                        preceding={steps.slice(0, index)}
                        scope={flow ? "FLOW" : "CASE"}
                    />
                )}
            </List>
        </>
    );
}
function StepFields({
    path,
    versions,
    preceding,
    scope,
}: {
    path: string;
    versions: VersionOption[];
    preceding: StepV1[];
    scope: "CASE" | "FLOW";
}) {
    const step = useValue<StepV1>(path),
        set = useSet();
    if (!step) return null;
    const observers = step.observers ?? [],
        network = observers.filter((o) => !("kind" in o)).map((o) => o.id);
    const inheritedPages = preceding
        .flatMap((s) => s.observers ?? [])
        .filter((o) => "kind" in o && o.kind === "newPage")
        .map((o) => ("pageKey" in o ? String(o.pageKey) : ""));
    const afterPages = [
        ...inheritedPages,
        ...observers
            .filter((o) => "kind" in o && o.kind === "newPage")
            .map((o) => ("pageKey" in o ? String(o.pageKey) : "")),
    ];
    return (
        <>
            <Field name={`${path}.id`} label="步骤 ID / Step ID" />
            <label>
                动作 / Action
                <select
                    data-testid={`${path}.action`}
                    value={step.action}
                    onChange={(e) => {
                        const { action: _action, ...rest } = step;
                        const shared = Object.fromEntries(
                            Object.entries(rest).filter(([k]) =>
                                [
                                    "id",
                                    "critical",
                                    "beforeAssertions",
                                    "observers",
                                    "afterAssertions",
                                    "extract",
                                    "timeoutMs",
                                    "failurePolicy",
                                    "pageKey",
                                ].includes(k),
                            ),
                        );
                        set(path, {
                            ...shared,
                            action: e.target.value,
                            ...actionDefaults(e.target.value),
                        });
                    }}
                >
                    {actions.map((x) => (
                        <option key={x}>{x}</option>
                    ))}
                </select>
            </label>
            <Field name={`${path}.critical`} label="关键步骤 / Critical" check />
            <Field name={`${path}.timeoutMs`} label="超时 ms / Timeout" optional number />
            <Field
                name={`${path}.failurePolicy`}
                label="失败策略 / Failure policy"
                options={["STOP_CASE", "CONTINUE"]}
                optional
            />
            <Field
                name={`${path}.pageKey`}
                label="动作页面 / Action page"
                options={scope === "CASE" ? inheritedPages : undefined}
                showUnlistedValue={scope === "CASE"}
                optional
                hint={
                    scope === "FLOW"
                        ? "可填写调用方或流程内先前捕获的页面 key；实际调用时检查词法作用域。流程内部页面不会泄漏给调用方。 / Caller or preceding flow page key; resolved in the calling case. Flow-local pages do not escape."
                        : "省略=原始页面；本步骤捕获的新页面只供之后的断言和步骤使用 / Omitted means original page; new pages become available after capture."
                }
            />
            {["goto", "apiRequest"].includes(step.action) && (
                <Field name={`${path}.path`} label="相对路径 / Origin-relative path" />
            )}
            {["click", "check", "uncheck", "fill", "press", "selectOption", "upload"].includes(
                step.action,
            ) && <Field name={`${path}.target`} label="元素 key / Target" />}
            {["fill", "press"].includes(step.action) && (
                <Field name={`${path}.value`} label="值 / Value (bindings allowed)" />
            )}
            {step.action === "selectOption" && (
                <JsonField
                    name={`${path}.value`}
                    label="选项 / String or string array"
                    allowBinding
                />
            )}
            {step.action === "upload" && (
                <StringList
                    name={`${path}.value`}
                    label="包内相对文件路径 / Bundle relative files"
                />
            )}
            {step.action === "apiRequest" && (
                <>
                    <Field name={`${path}.method`} label="HTTP 方法 / Method" options={methods} />
                    <JsonField
                        name={`${path}.query`}
                        label="请求查询 / Request query"
                        allowBinding
                    />
                    <JsonField
                        name={`${path}.headers`}
                        label="请求头 / Request headers"
                        allowBinding
                    />
                    <JsonField name={`${path}.body`} label="请求体 / Request body" allowBinding />
                </>
            )}
            {step.action === "callFlow" && (
                <>
                    <VersionField
                        name={`${path}.versionId`}
                        label="固定流程版本 / Pinned flow"
                        kind="FLOW"
                        versions={versions}
                    />
                    <JsonField
                        name={`${path}.parameters`}
                        label="流程实参 / Flow bindings"
                        allowBinding
                    />
                </>
            )}
            <AssertionEditor
                name={`${path}.beforeAssertions`}
                title="前置断言 / Before assertions"
                phase="BEFORE"
                scope={scope}
                network={[]}
                versions={versions}
                pageKeys={inheritedPages}
            />
            <List
                name={`${path}.observers`}
                title="监听器 / Observers"
                initial={() => ({
                    id: "observer_" + crypto.randomUUID().slice(0, 8),
                    method: "GET",
                    path: "/",
                })}
            >
                {(observer) => <ObserverFields path={observer} />}
            </List>
            <List
                name={`${path}.extract`}
                title="变量提取 / Extractions"
                initial={() => ({
                    source: `response:${network[0] ?? "observer"}`,
                    pointer: "",
                    to: "variable",
                    valueType: "string",
                    required: true,
                })}
            >
                {(extract) => (
                    <>
                        <Field
                            name={`${extract}.source`}
                            label="网络来源 / Network source"
                            options={network.flatMap((id) => [`request:${id}`, `response:${id}`])}
                        />
                        <Field name={`${extract}.pointer`} label="JSON Pointer" />
                        <Field name={`${extract}.to`} label="变量名 / Variable name" />
                        <Field
                            name={`${extract}.valueType`}
                            label="变量类型 / Variable type"
                            options={types}
                        />
                        <Field name={`${extract}.required`} label="必需 / Required" check />
                    </>
                )}
            </List>
            <AssertionEditor
                name={`${path}.afterAssertions`}
                title="后置断言 / After assertions"
                phase="AFTER"
                scope={scope}
                network={network}
                versions={versions}
                pageKeys={afterPages}
            />
        </>
    );
}
function ObserverFields({ path }: { path: string }) {
    const o = useValue<ObserverV1>(path),
        set = useSet();
    const window = useValue<{ mode: string } | undefined>(`${path}.window`);
    if (!o) return null;
    const kind = "kind" in o ? String(o.kind) : "network";
    const dialog = kind === "dialog" ? (o as { dialogType: string; handling: string }) : undefined;
    return (
        <>
            <Field name={`${path}.id`} label="监听器 ID / Observer ID" />
            <label>
                监听类型 / Observer kind
                <select
                    data-testid={`${path}.kind`}
                    value={kind}
                    onChange={(e) =>
                        set(path, {
                            id: o.id,
                            ...(e.target.value === "network"
                                ? { method: "GET", path: "/" }
                                : e.target.value === "dialog"
                                  ? {
                                        kind: "dialog",
                                        dialogType: "confirm",
                                        message: "",
                                        handling: "dismiss",
                                    }
                                  : e.target.value === "newPage"
                                    ? { kind: "newPage", pageKey: "detail" }
                                    : { kind: "download" }),
                        })
                    }
                >
                    {["network", "dialog", "newPage", "download"].map((k) => (
                        <option key={k}>{k}</option>
                    ))}
                </select>
            </label>
            <Field name={`${path}.timeoutMs`} label="超时 ms / Timeout" optional number />
            {kind === "network" && (
                <>
                    <Field name={`${path}.method`} label="HTTP 方法 / Method" options={methods} />
                    <Field name={`${path}.path`} label="精确相对路径 / Exact path" />
                    <JsonField
                        name={`${path}.queryMatch`}
                        label="查询匹配 / Query match"
                        allowBinding
                    />
                    <JsonField
                        name={`${path}.bodyMatch`}
                        label="请求体匹配 / Body match"
                        allowBinding
                    />
                    <Field
                        name={`${path}.retryPolicy`}
                        label="重试策略 / Retry policy"
                        options={["FORBID", "ALLOW_MATCHING_RETRIES"]}
                        optional
                    />
                    <label>
                        观测窗口 / Window
                        <select
                            data-testid={`${path}.window.mode`}
                            value={window?.mode ?? ""}
                            onChange={(e) => {
                                set(
                                    `${path}.window`,
                                    e.target.value === ""
                                        ? undefined
                                        : e.target.value === "FIXED"
                                          ? { mode: "FIXED", durationMs: 1000 }
                                          : { mode: "UNTIL_ACTION_SETTLED", quietMs: 500 },
                                );
                                if (e.target.value !== "FIXED")
                                    set(`${path}.expectedCount`, undefined);
                            }}
                        >
                            <option value="">默认 / Default</option>
                            <option>UNTIL_ACTION_SETTLED</option>
                            <option>FIXED</option>
                        </select>
                    </label>
                    {window?.mode === "FIXED" ? (
                        <>
                            <Field
                                name={`${path}.window.durationMs`}
                                label="窗口时长 ms / Duration"
                                number
                            />
                            <Field
                                name={`${path}.expectedCount`}
                                label="精确次数 / Exact count"
                                optional
                                number
                            />
                        </>
                    ) : (
                        window?.mode === "UNTIL_ACTION_SETTLED" && (
                            <Field
                                name={`${path}.window.quietMs`}
                                label="静默时长 ms / Quiet time"
                                number
                                optional
                            />
                        )
                    )}
                </>
            )}
            {kind === "dialog" && (
                <>
                    <label>
                        对话框类型 / Dialog type
                        <select
                            data-testid={`${path}.dialogType`}
                            value={dialog!.dialogType}
                            onChange={(e) => {
                                set(`${path}.dialogType`, e.target.value);
                                if (e.target.value !== "prompt")
                                    set(`${path}.promptText`, undefined);
                            }}
                        >
                            {["alert", "beforeunload", "confirm", "prompt"].map((x) => (
                                <option key={x}>{x}</option>
                            ))}
                        </select>
                    </label>
                    <Field name={`${path}.message`} label="精确消息 / Exact message" />
                    <label>
                        处理方式 / Handling
                        <select
                            data-testid={`${path}.handling`}
                            value={dialog!.handling}
                            onChange={(e) => {
                                set(`${path}.handling`, e.target.value);
                                if (e.target.value !== "accept")
                                    set(`${path}.promptText`, undefined);
                            }}
                        >
                            <option>accept</option>
                            <option>dismiss</option>
                        </select>
                    </label>
                    {dialog!.dialogType === "prompt" && dialog!.handling === "accept" && (
                        <Field
                            name={`${path}.promptText`}
                            label="Prompt 输入 / Prompt text"
                            optional
                        />
                    )}
                    <small>
                        仅接受的 prompt 可填写 promptText / Prompt input only when accepting a
                        prompt.
                    </small>
                </>
            )}
            {kind === "newPage" && (
                <>
                    <Field name={`${path}.pageKey`} label="捕获页面 key / Captured page key" />
                    <small>
                        显式词法作用域，无全局活动页切换 / Explicit lexical scope, no implicit
                        active page.
                    </small>
                </>
            )}
            {kind === "download" && (
                <small>
                    下载路径由 Runtime 安全分配，此处不能指定路径 / Runtime owns safe download
                    destinations.
                </small>
            )}
        </>
    );
}
