/**
 * 按 ResourceKind 分发的图形表单与 newDocument 工厂，写入 content.document 供草稿保存。
 * CASE/FLOW 委托 CaseEditor；断言模板等走专用字段，不在此执行编译。
 */

import { ResourceSelectField, ResourceSelectItem, ResourceSelect } from "./ResourceSelect";
import { tx, useAppLocale } from "../../locale";
import type { ReactNode } from "react";
import type {
    ResourceDocumentV1,
    ResourceKind,
    CatalogElementV1,
    JsonValue,
    DatasetDocument,
    DatasetV2,
} from "@veriq/contracts";
import { HttpDatasetFields, newHttpDataset, type HttpPreview } from "./HttpDatasetFields";
import { DatasetFields, newStaticDataset } from "./DatasetFields";
import { CaseEditor } from "../cases/CaseEditor";
import { AssertionEditor, newAssertion } from "../assertions/AssertionEditor";
import { EnvironmentFields } from "../environments/EnvironmentFields";
import {
    Field,
    JsonField,
    JsonValueControl,
    List,
    StringList,
    TypeMap,
    VersionField,
    useValue,
    useSet,
    type VersionOption,
} from "./fields";
import { Button, Section } from "@veriq/ui";
/**
 * 创建资源下拉可用的 kind 枚举顺序，与契约 ResourceKind 对齐且不含已废弃值。顺序变更需同步创建表单测试。
 * EnvironmentPage 可子集过滤；顺序影响默认选中项。
 */
export const resourceKinds: ResourceKind[] = [
    "CASE",
    "ELEMENT_CATALOG",
    "ASSERTION_TEMPLATE",
    "DATASET",
    "FLOW",
    "FIXTURE",
    "SUITE",
    "ENVIRONMENT",
];
const placeholder = "00000000-0000-4000-8000-000000000000";
/**
 * 四种手动新建格式共用同一份展示名称、形状与来源映射，切换选项后按对应构造器填充草稿的初始字段。
 */
export const datasetCreationFormats = {
    TABLE: { label: "Static table", shape: "TABLE", source: "STATIC" },
    TREE: { label: "Static tree", shape: "TREE", source: "STATIC" },
    HTTP_TABLE: { label: "HTTP table", shape: "TABLE", source: "HTTP" },
    HTTP_TREE: { label: "HTTP tree", shape: "TREE", source: "HTTP" },
} as const;

/**
 * 格式类型由新建下拉的取值推导，表单与草稿构造函数共用此联合类型，历史版本只从存量文档读取。
 */
export type DatasetCreationFormat = keyof typeof datasetCreationFormats;

/**
 * 新建及重置表单统一回到静态表格，对已经存储的草稿则仍按其自身版本渲染对应编辑器，保留原有值。
 */
export const defaultDatasetCreationFormat = "TABLE" satisfies DatasetCreationFormat;

/**
 * 按 kind/key/name 构造空 ResourceDocumentV1，供创建表单写入草稿初始 content。各 kind 默认字段集不同。不访问网络；调用
 * 方随后 CloudResourceAdapter.create。
 */
export function newDocument(
    kind: ResourceKind,
    key: string,
    name: string,
    datasetFormat: DatasetCreationFormat = defaultDatasetCreationFormat,
): ResourceDocumentV1 {
    const base = { schemaVersion: "1.0" as const };
    switch (kind) {
        case "CASE":
            return {
                kind,
                document: {
                    ...base,
                    caseKey: key,
                    title: name,
                    kind: "READ",
                    roleKey: "reader",
                    catalogVersionId: placeholder,
                    steps: [{ id: "open", action: "goto", path: "/" }],
                },
            };
        case "ELEMENT_CATALOG":
            return {
                kind,
                document: {
                    ...base,
                    elements: [{ key: "name", locator: { by: "veriqId", value: "name" } }],
                },
            };
        case "ASSERTION_TEMPLATE":
            return { kind, document: { ...base, assertions: [newAssertion()] } };
        case "DATASET": {
            const { shape, source } = datasetCreationFormats[datasetFormat];
            return { kind, document: source === "HTTP" ? newHttpDataset(shape) : newStaticDataset(shape) };
        }
        case "FLOW":
            return {
                kind,
                document: {
                    ...base,
                    steps: [{ id: "open", action: "goto", path: "/" }],
                },
            };
        case "FIXTURE":
            return {
                kind,
                document: {
                    ...base,
                    prepare: { method: "POST", path: "/prepare" },
                    query: { method: "GET", path: "/query" },
                    cleanup: { method: "POST", path: "/cleanup" },
                    inputSchema: { type: "object" },
                    outputSchema: { type: "object" },
                    ttlSeconds: 3600,
                },
            };
        case "SUITE":
            return {
                kind,
                document: {
                    ...base,
                    cases: [{ versionId: placeholder, browsers: ["chromium"] }],
                },
            };
        case "ENVIRONMENT":
            return {
                kind,
                document: {
                    ...base,
                    baseURL: "http://localhost:3000",
                    apiBaseURL: "http://localhost:3000",
                    allowedOrigins: ["http://localhost:3000"],
                    locale: "zh-CN",
                    timezone: "Asia/Shanghai",
                    roles: [
                        {
                            roleKey: "reader",
                            authAdapterVersionId: placeholder,
                            secretRef: "business",
                            secretVersionId: placeholder,
                        },
                    ],
                },
            };
    }
}
/**
 * 按资源类型渲染草稿字段并传递固定版本选项。环境字段可以展示云端编辑器提供的管理入口，其他宿主无需配置该入口。
 * 数据集导入代次只由独立导入页签提供，图形表单据此刷新数据行并省略嵌入式导入入口。
 */
export function ResourceForms({
    kind,
    versions,
    preview,
    authenticationSettings,
    lockDatasetEdits = false,
    allowDatasetExport = false,
    datasetImportGeneration,
}: {
    kind: ResourceKind;
    versions: VersionOption[];
    preview?: HttpPreview;
    authenticationSettings?: ReactNode;
    lockDatasetEdits?: boolean;
    allowDatasetExport?: boolean;
    datasetImportGeneration?: number;
}) {
    useAppLocale();
    if (kind === "CASE" || kind === "FLOW") return <CaseEditor versions={versions} flow={kind === "FLOW"} />;
    if (kind === "ENVIRONMENT") return <EnvironmentFields authenticationSettings={authenticationSettings} />;
    if (kind === "ASSERTION_TEMPLATE")
        return (
            <>
                <TypeMap name="content.document.parameters" label={tx("模板参数类型 / Template parameter types")} />
                <AssertionEditor
                    name="content.document.assertions"
                    title={tx("断言 / Assertions")}
                    scope="ASSERTION_TEMPLATE"
                    phase="TEMPLATE"
                    versions={versions}
                />
            </>
        );
    if (kind === "ELEMENT_CATALOG")
        return (
            <List
                name="content.document.elements"
                title={tx("页面元素 / Elements")}
                initial={() => ({
                    key: "element_" + crypto.randomUUID().slice(0, 8),
                    locator: { by: "veriqId", value: "" },
                })}
            >
                {(path) => <ElementFields path={path} />}
            </List>
        );
    if (kind === "DATASET")
        return (
            <DatasetForm
                preview={preview}
                readOnly={lockDatasetEdits}
                allowTableExport={allowDatasetExport}
                importGeneration={datasetImportGeneration}
            />
        );
    if (kind === "SUITE")
        return (
            <List
                name="content.document.cases"
                title={tx("套件用例 / Suite cases")}
                initial={() => ({ versionId: "", browsers: ["chromium"] })}
            >
                {(path) => (
                    <>
                        <VersionField
                            name={`${path}.versionId`}
                            label={tx("用例固定版本 / Case version")}
                            kind="CASE"
                            versions={versions}
                        />
                        <VersionField
                            name={`${path}.datasetVersionId`}
                            label={tx("数据集固定版本 / Dataset version")}
                            kind="DATASET"
                            versions={versions}
                            optional
                        />
                        <StringList name={`${path}.roleKeys`} label={tx("角色 / Roles")} />
                        <StringList
                            name={`${path}.browsers`}
                            label={tx("浏览器 / Browsers")}
                            choices={["chromium", "firefox", "webkit"]}
                        />
                    </>
                )}
            </List>
        );
    return (
        <>
            <Field name="content.document.prepare.path" label={tx("准备 POST 路径 / Prepare path")} />
            <Field name="content.document.query.path" label={tx("只读查询 GET 路径 / Query path")} />
            <Field
                name="content.document.cleanup.method"
                label={tx("清理方法 / Cleanup method")}
                options={["POST", "DELETE"]}
            />
            <Field name="content.document.cleanup.path" label={tx("清理路径 / Cleanup path")} />
            <Field name="content.document.ttlSeconds" label={tx("TTL 秒 / TTL seconds")} number />
            <SchemaFields path="content.document.inputSchema" label={tx("输入 Schema / Input schema")} />
            <SchemaFields path="content.document.outputSchema" label={tx("输出 Schema / Output schema")} />
        </>
    );
}
function DatasetForm({
    preview,
    readOnly,
    allowTableExport,
    importGeneration,
}: {
    preview?: HttpPreview;
    readOnly: boolean;
    allowTableExport: boolean;
    importGeneration?: number;
}) {
    const dataset = useValue<DatasetDocument>("content.document");
    if (dataset?.schemaVersion === "2.0") {
        if (dataset.source.kind === "HTTP")
            return <HttpDatasetFields dataset={dataset} source={dataset.source} preview={preview} />;
        return (
            <DatasetFields
                dataset={dataset as Extract<DatasetV2, { source: { kind: "STATIC" } }>}
                readOnly={readOnly}
                allowTableExport={allowTableExport}
                externalImportGeneration={importGeneration}
            />
        );
    }
    return (
        <>
            <TypeMap name="content.document.columns" label={tx("数据列类型 / Column types")} />
            <List
                name="content.document.rows"
                title={tx("数据行 / Dataset rows")}
                initial={() => ({
                    key: "row_" + crypto.randomUUID().slice(0, 8),
                    values: {},
                })}
            >
                {(path) => (
                    <>
                        <Field name={`${path}.key`} label={tx("数据行 key / Row key")} />
                        <DatasetValues path={`${path}.values`} />
                    </>
                )}
            </List>
        </>
    );
}
function ElementFields({ path }: { path: string }) {
    useAppLocale();
    const element = useValue<CatalogElementV1>(path),
        set = useSet();
    return (
        <>
            <Field name={`${path}.key`} label={tx("元素 key / Element key")} />
            <Field name={`${path}.scope`} label={tx("父作用域 key / Parent scope")} optional />
            <Field name={`${path}.recordKey`} label={tx("记录 key / Record key")} optional />
            <ResourceSelectField
                label={tx("定位方式 / Locator")}
                required
                value={element?.locator.by ?? "veriqId"}
                onValueChange={(selection) =>
                    set(
                        `${path}.locator`,
                        selection === "veriqId"
                            ? { by: "veriqId", value: "" }
                            : { by: "role", role: "button", exact: true },
                    )
                }
            >
                <ResourceSelectItem value="veriqId">veriqId</ResourceSelectItem>
                <ResourceSelectItem value="role">role</ResourceSelectItem>
            </ResourceSelectField>
            {element?.locator.by === "role" ? (
                <>
                    <Field name={`${path}.locator.role`} label="ARIA role" />
                    <Field name={`${path}.locator.name`} label={tx("可访问名称 / Accessible name")} optional />
                    <Field name={`${path}.locator.exact`} label={tx("精确匹配 / Exact")} check />
                </>
            ) : (
                <Field name={`${path}.locator.value`} label="veriqId" />
            )}
        </>
    );
}
function DatasetValues({ path }: { path: string }) {
    useAppLocale();
    const columns = useValue<Record<string, string>>("content.document.columns") ?? {},
        value = useValue<Record<string, JsonValue>>(path) ?? {},
        set = useSet();
    const initial = (type: string): JsonValue =>
        type === "boolean"
            ? false
            : ["number", "integer"].includes(type)
              ? 0
              : type === "null"
                ? null
                : type === "object"
                  ? {}
                  : type === "array"
                    ? []
                    : "";
    return (
        <>
            {Object.entries(columns).map(([key, type]) => (
                <Section key={key} title={`${key} (${type})`}>
                    {Object.hasOwn(value, key) ? (
                        <>
                            <JsonValueControl
                                label={key}
                                value={value[key]!}
                                onChange={(v) => set(path, { ...value, [key]: v })}
                            />
                            <Button
                                tone="danger"
                                onClick={() =>
                                    set(path, Object.fromEntries(Object.entries(value).filter(([k]) => k !== key)))
                                }
                            >
                                {tx("设为缺失 / Mark missing")}
                            </Button>
                        </>
                    ) : (
                        <Button tone="secondary" onClick={() => set(path, { ...value, [key]: initial(type) })}>
                            {tx("设置值 / Set ")}
                            {key}
                        </Button>
                    )}
                </Section>
            ))}
            {Object.keys(value)
                .filter((k) => !Object.hasOwn(columns, k))
                .map((k) => (
                    <Section title={tx("未声明列 / Undeclared: {{value0}}", { value0: k })} key={k}>
                        <JsonValueControl
                            value={value[k]!}
                            label={k}
                            onChange={(v) => set(path, { ...value, [k]: v })}
                        />
                        <Button
                            tone="danger"
                            onClick={() =>
                                set(path, Object.fromEntries(Object.entries(value).filter(([key]) => key !== k)))
                            }
                        >
                            {tx("删除 / Remove")}
                        </Button>
                    </Section>
                ))}
        </>
    );
}
function SchemaFields({ path, label }: { path: string; label: string }) {
    useAppLocale();
    const schema = useValue<Record<string, JsonValue>>(path) ?? {},
        set = useSet();
    const properties =
        schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
            ? schema.properties
            : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    const add = () => {
        let index = 1;
        while (Object.hasOwn(properties, "field_" + index)) index++;
        const name = "field_" + index;
        set(path, {
            ...schema,
            type: "object",
            properties: { ...properties, [name]: { type: "string" } },
        });
    };
    return (
        <Section title={label}>
            <Field
                name={`${path}.type`}
                label={tx("根类型 / Root type")}
                options={["object", "array", "string", "number", "integer", "boolean", "null"]}
                optional
            />
            <Field name={`${path}.additionalProperties`} label={tx("允许附加字段 / Allow extra properties")} check />
            {Object.entries(properties).map(([key, def]) => (
                <div className="vq-item" key={key}>
                    <label>
                        {tx("字段名 / Property")}
                        <input
                            aria-label={tx("{{value0}} property {{value1}}", {
                                value0: label,
                                value1: key,
                            })}
                            defaultValue={key}
                            onBlur={(e) => {
                                const next = e.target.value;
                                if (
                                    next &&
                                    next !== key &&
                                    !Object.hasOwn(properties, next) &&
                                    !["__proto__", "constructor", "prototype"].includes(next)
                                )
                                    set(path, {
                                        ...schema,
                                        properties: Object.fromEntries(
                                            Object.entries(properties).map(([k, v]) => [k === key ? next : k, v]),
                                        ),
                                        required: required.map((k) => (k === key ? next : k)),
                                    });
                            }}
                        />
                    </label>
                    <ResourceSelect
                        aria-label={tx("{{value0}}.{{value1}} type", {
                            value0: label,
                            value1: key,
                        })}
                        value={
                            def !== null &&
                            typeof def === "object" &&
                            !Array.isArray(def) &&
                            typeof def.type === "string"
                                ? def.type
                                : "string"
                        }
                        onValueChange={(selection) =>
                            set(path, {
                                ...schema,
                                properties: {
                                    ...properties,
                                    [key]: {
                                        ...(def !== null && typeof def === "object" && !Array.isArray(def) ? def : {}),
                                        type: selection,
                                    },
                                },
                            })
                        }
                    >
                        {["object", "array", "string", "number", "integer", "boolean", "null"].map((t) => (
                            <ResourceSelectItem value={t} key={t}>
                                {t}
                            </ResourceSelectItem>
                        ))}
                    </ResourceSelect>
                    <label className="vq-check">
                        {tx("必需 / Required")}
                        <input
                            type="checkbox"
                            checked={required.includes(key)}
                            onChange={(e) =>
                                set(path, {
                                    ...schema,
                                    required: e.target.checked ? [...required, key] : required.filter((k) => k !== key),
                                })
                            }
                        />
                    </label>
                    <Button
                        tone="danger"
                        onClick={() =>
                            set(path, {
                                ...schema,
                                properties: Object.fromEntries(Object.entries(properties).filter(([k]) => k !== key)),
                                required: required.filter((k) => k !== key),
                            })
                        }
                    >
                        {tx("删除 / Remove")}
                    </Button>
                </div>
            ))}
            <Button tone="secondary" onClick={add}>
                {tx("添加 Schema 字段 / Add schema property")}
            </Button>
            <details>
                <summary>{tx("完整 Schema 高级字段 / Complete schema fields")}</summary>
                <JsonField name={path} label={label} />
            </details>
        </Section>
    );
}
