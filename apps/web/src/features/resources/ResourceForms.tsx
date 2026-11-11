import type {
  ResourceDocumentV1,
  ResourceKind,
  CatalogElementV1,
  JsonValue,
} from "@veriq/contracts";
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
export function newDocument(
  kind: ResourceKind,
  key: string,
  name: string,
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
          elements: [{ key: "name", locator: { by: "testId", value: "name" } }],
        },
      };
    case "ASSERTION_TEMPLATE":
      return { kind, document: { ...base, assertions: [newAssertion()] } };
    case "DATASET":
      return {
        kind,
        document: {
          ...base,
          columns: { name: "string" },
          rows: [{ key: "row_1", values: { name: "" } }],
        },
      };
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
export function ResourceForms({
  kind,
  versions,
}: {
  kind: ResourceKind;
  versions: VersionOption[];
}) {
  if (kind === "CASE" || kind === "FLOW")
    return <CaseEditor versions={versions} flow={kind === "FLOW"} />;
  if (kind === "ENVIRONMENT") return <EnvironmentFields />;
  if (kind === "ASSERTION_TEMPLATE")
    return (
      <>
        <TypeMap
          name="content.document.parameters"
          label="模板参数类型 / Template parameter types"
        />
        <AssertionEditor
          name="content.document.assertions"
          title="断言 / Assertions"
          versions={versions}
        />
      </>
    );
  if (kind === "ELEMENT_CATALOG")
    return (
      <List
        name="content.document.elements"
        title="页面元素 / Elements"
        initial={() => ({
          key: "element_" + crypto.randomUUID().slice(0, 8),
          locator: { by: "testId", value: "" },
        })}
      >
        {(path) => <ElementFields path={path} />}
      </List>
    );
  if (kind === "DATASET")
    return (
      <>
        <TypeMap
          name="content.document.columns"
          label="数据列类型 / Column types"
        />
        <List
          name="content.document.rows"
          title="数据行 / Dataset rows"
          initial={() => ({
            key: "row_" + crypto.randomUUID().slice(0, 8),
            values: {},
          })}
        >
          {(path) => (
            <>
              <Field name={`${path}.key`} label="数据行 key / Row key" />
              <DatasetValues path={`${path}.values`} />
            </>
          )}
        </List>
      </>
    );
  if (kind === "SUITE")
    return (
      <List
        name="content.document.cases"
        title="套件用例 / Suite cases"
        initial={() => ({ versionId: "", browsers: ["chromium"] })}
      >
        {(path) => (
          <>
            <VersionField
              name={`${path}.versionId`}
              label="用例固定版本 / Case version"
              kind="CASE"
              versions={versions}
            />
            <VersionField
              name={`${path}.datasetVersionId`}
              label="数据集固定版本 / Dataset version"
              kind="DATASET"
              versions={versions}
              optional
            />
            <StringList name={`${path}.roleKeys`} label="角色 / Roles" />
            <StringList
              name={`${path}.browsers`}
              label="浏览器 / Browsers"
              choices={["chromium", "firefox", "webkit"]}
            />
          </>
        )}
      </List>
    );
  return (
    <>
      <Field
        name="content.document.prepare.path"
        label="准备 POST 路径 / Prepare path"
      />
      <Field
        name="content.document.query.path"
        label="只读查询 GET 路径 / Query path"
      />
      <Field
        name="content.document.cleanup.method"
        label="清理方法 / Cleanup method"
        options={["POST", "DELETE"]}
      />
      <Field
        name="content.document.cleanup.path"
        label="清理路径 / Cleanup path"
      />
      <Field
        name="content.document.ttlSeconds"
        label="TTL 秒 / TTL seconds"
        number
      />
      <SchemaFields
        path="content.document.inputSchema"
        label="输入 Schema / Input schema"
      />
      <SchemaFields
        path="content.document.outputSchema"
        label="输出 Schema / Output schema"
      />
    </>
  );
}
function ElementFields({ path }: { path: string }) {
  const element = useValue<CatalogElementV1>(path),
    set = useSet();
  return (
    <>
      <Field name={`${path}.key`} label="元素 key / Element key" />
      <Field
        name={`${path}.scope`}
        label="父作用域 key / Parent scope"
        optional
      />
      <Field
        name={`${path}.recordKey`}
        label="记录 key / Record key"
        optional
      />
      <label>
        定位方式 / Locator
        <select
          data-testid={`${path}.locator.by`}
          value={element?.locator.by ?? "testId"}
          onChange={(e) =>
            set(
              `${path}.locator`,
              e.target.value === "testId"
                ? { by: "testId", value: "" }
                : { by: "role", role: "button", exact: true },
            )
          }
        >
          <option>testId</option>
          <option>role</option>
        </select>
      </label>
      {element?.locator.by === "role" ? (
        <>
          <Field name={`${path}.locator.role`} label="ARIA role" />
          <Field
            name={`${path}.locator.name`}
            label="可访问名称 / Accessible name"
            optional
          />
          <Field
            name={`${path}.locator.exact`}
            label="精确匹配 / Exact"
            check
          />
        </>
      ) : (
        <Field name={`${path}.locator.value`} label="testId" />
      )}
    </>
  );
}
function DatasetValues({ path }: { path: string }) {
  const columns =
      useValue<Record<string, string>>("content.document.columns") ?? {},
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
                  set(
                    path,
                    Object.fromEntries(
                      Object.entries(value).filter(([k]) => k !== key),
                    ),
                  )
                }
              >
                设为缺失 / Mark missing
              </Button>
            </>
          ) : (
            <Button
              tone="secondary"
              onClick={() => set(path, { ...value, [key]: initial(type) })}
            >
              设置值 / Set {key}
            </Button>
          )}
        </Section>
      ))}
      {Object.keys(value)
        .filter((k) => !Object.hasOwn(columns, k))
        .map((k) => (
          <Section title={`未声明列 / Undeclared: ${k}`} key={k}>
            <JsonValueControl
              value={value[k]!}
              label={k}
              onChange={(v) => set(path, { ...value, [k]: v })}
            />
            <Button
              tone="danger"
              onClick={() =>
                set(
                  path,
                  Object.fromEntries(
                    Object.entries(value).filter(([key]) => key !== k),
                  ),
                )
              }
            >
              删除 / Remove
            </Button>
          </Section>
        ))}
    </>
  );
}
function SchemaFields({ path, label }: { path: string; label: string }) {
  const schema = useValue<Record<string, JsonValue>>(path) ?? {},
    set = useSet();
  const properties =
    schema.properties &&
    typeof schema.properties === "object" &&
    !Array.isArray(schema.properties)
      ? schema.properties
      : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const add = () => {
    const name = "field_" + (Object.keys(properties).length + 1);
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
        label="根类型 / Root type"
        options={[
          "object",
          "array",
          "string",
          "number",
          "integer",
          "boolean",
          "null",
        ]}
        optional
      />
      <Field
        name={`${path}.additionalProperties`}
        label="允许附加字段 / Allow extra properties"
        check
      />
      {Object.entries(properties).map(([key, def]) => (
        <div className="vq-item" key={key}>
          <label>
            字段名 / Property
            <input
              aria-label={`${label} property ${key}`}
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
                      Object.entries(properties).map(([k, v]) => [
                        k === key ? next : k,
                        v,
                      ]),
                    ),
                    required: required.map((k) => (k === key ? next : k)),
                  });
              }}
            />
          </label>
          <select
            aria-label={`${label}.${key} type`}
            value={
              def !== null &&
              typeof def === "object" &&
              !Array.isArray(def) &&
              typeof def.type === "string"
                ? def.type
                : "string"
            }
            onChange={(e) =>
              set(path, {
                ...schema,
                properties: {
                  ...properties,
                  [key]: {
                    ...(def !== null &&
                    typeof def === "object" &&
                    !Array.isArray(def)
                      ? def
                      : {}),
                    type: e.target.value,
                  },
                },
              })
            }
          >
            {[
              "object",
              "array",
              "string",
              "number",
              "integer",
              "boolean",
              "null",
            ].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <label className="vq-check">
            必需 / Required
            <input
              type="checkbox"
              checked={required.includes(key)}
              onChange={(e) =>
                set(path, {
                  ...schema,
                  required: e.target.checked
                    ? [...required, key]
                    : required.filter((k) => k !== key),
                })
              }
            />
          </label>
          <Button
            tone="danger"
            onClick={() =>
              set(path, {
                ...schema,
                properties: Object.fromEntries(
                  Object.entries(properties).filter(([k]) => k !== key),
                ),
                required: required.filter((k) => k !== key),
              })
            }
          >
            删除 / Remove
          </Button>
        </div>
      ))}
      <Button tone="secondary" onClick={add}>
        添加 Schema 字段 / Add schema property
      </Button>
      <details>
        <summary>完整 Schema 高级字段 / Complete schema fields</summary>
        <JsonField name={path} label={label} />
      </details>
    </Section>
  );
}
