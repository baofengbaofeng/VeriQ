import type { AssertionV1 } from "@veriq/contracts";
import {
  Field,
  JsonField,
  List,
  VersionField,
  useValue,
  useSet,
  type VersionOption,
} from "../resources/fields";
const assertionTypes = [
  "ui",
  "url",
  "request",
  "httpStatus",
  "requestField",
  "responseField",
  "responseSchema",
  "eventually",
  "duration",
  "requestCount",
  "template",
];
const operators: Record<string, string[]> = {
  ui: [
    "visible",
    "enabled",
    "checked",
    "attached",
    "editable",
    "textEquals",
    "textContains",
    "valueEquals",
    "countEquals",
  ],
  url: ["equals", "contains"],
  request: ["methodEquals", "pathEquals"],
  httpStatus: ["equals"],
  requestField: ["equals", "notEquals", "in", "contains", "exists"],
  responseField: ["equals", "notEquals", "in", "contains", "exists"],
  responseSchema: ["matchesSchema"],
  eventually: ["equals"],
  duration: ["lessThanOrEqual"],
  requestCount: ["equals"],
};
export const newAssertion = (): AssertionV1 => ({
  id: "assertion_" + crypto.randomUUID().slice(0, 8),
  type: "ui",
  target: "name",
  operator: "visible",
  expected: true,
  severity: "BLOCK",
  expectedSource: "人工审核 / Human review",
});
function defaults(type: string, network: string[]) {
  const source =
    (type === "request" || type === "requestField" || type === "requestCount"
      ? "request:"
      : "response:") + (network[0] ?? "observer");
  if (type === "template") return { type, versionId: "" };
  const base = { type, operator: operators[type]![0] };
  if (type === "ui") return { ...base, target: "name", expected: true };
  if (type === "url") return { ...base, source: "page", expected: "/" };
  if (type === "eventually")
    return {
      ...base,
      query: { method: "GET", path: "/status" },
      pointer: "/ok",
      expected: true,
    };
  return {
    ...base,
    source,
    expected:
      type === "httpStatus"
        ? 200
        : type === "request"
          ? "GET"
          : type === "responseSchema"
            ? { type: "object" }
            : type === "requestCount" || type === "duration"
              ? 1
              : "",
    ...(["requestField", "responseField"].includes(type)
      ? { pointer: "" }
      : {}),
  };
}
export function AssertionEditor({
  name,
  title,
  network,
  versions,
  pageKeys = [],
}: {
  name: string;
  title: string;
  network?: string[];
  versions: VersionOption[];
  pageKeys?: string[];
}) {
  return (
    <List name={name} title={title} initial={newAssertion}>
      {(path) => (
        <AssertionFields
          path={path}
          network={network}
          versions={versions}
          pageKeys={pageKeys}
        />
      )}
    </List>
  );
}
function AssertionFields({
  path,
  network,
  versions,
  pageKeys,
}: {
  path: string;
  network?: string[];
  versions: VersionOption[];
  pageKeys: string[];
}) {
  const a = useValue<AssertionV1>(path),
    set = useSet();
  if (!a) return null;
  const type = a.type,
    operator = "operator" in a ? a.operator : "";
  const setType = (type: string) =>
    set(path, {
      id: a.id,
      severity: a.severity,
      expectedSource: a.expectedSource,
      ...(a.timeoutMs === undefined ? {} : { timeoutMs: a.timeoutMs }),
      ...defaults(type, network ?? []),
    });
  const number =
    ["httpStatus", "requestCount", "duration"].includes(type) ||
    operator === "countEquals";
  const boolean = [
    "visible",
    "enabled",
    "checked",
    "attached",
    "editable",
    "exists",
  ].includes(operator);
  return (
    <>
      <Field name={`${path}.id`} label="断言 ID / Assertion ID" />
      <label>
        断言类型 / Assertion type
        <select
          data-testid={`${path}.type`}
          value={type}
          onChange={(e) => setType(e.target.value)}
        >
          {assertionTypes.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </label>
      <Field
        name={`${path}.severity`}
        label="严重性 / Severity"
        options={["BLOCK", "CONTINUE_FAIL", "WARN"]}
      />
      <Field
        name={`${path}.expectedSource`}
        label="预期依据 / Expected source"
      />
      <Field
        name={`${path}.timeoutMs`}
        label="超时 ms / Timeout"
        number
        optional
      />
      {type === "template" ? (
        <>
          <VersionField
            name={`${path}.versionId`}
            label="断言模板版本 / Template version"
            kind="ASSERTION_TEMPLATE"
            versions={versions}
          />
          <JsonField
            name={`${path}.parameters`}
            label="模板实参 / Template bindings"
            allowBinding
          />
        </>
      ) : (
        <>
          <label>
            运算符 / Operator
            <select
              data-testid={`${path}.operator`}
              value={operator}
              onChange={(e) => {
                const next = e.target.value;
                set(`${path}.operator`, next);
                set(
                  `${path}.expected`,
                  [
                    "visible",
                    "enabled",
                    "checked",
                    "attached",
                    "editable",
                    "exists",
                  ].includes(next)
                    ? true
                    : next === "countEquals"
                      ? 1
                      : next === "in"
                        ? [""]
                        : next === "methodEquals"
                          ? "GET"
                          : next === "pathEquals"
                            ? "/"
                            : "",
                );
              }}
            >
              {operators[type]!.map((op) => (
                <option key={op}>{op}</option>
              ))}
            </select>
          </label>
          {type === "ui" && (
            <Field name={`${path}.target`} label="元素 key / Target" />
          )}
          {["ui", "url"].includes(type) && (
            <Field
              name={`${path}.pageKey`}
              label="页面 / Page (省略=原始页面 / original)"
              options={pageKeys}
              optional
              hint="仅显式选择；公共流程内部新页面不泄漏到调用方 / Explicit lexical page scope"
            />
          )}
          {!["ui", "url", "eventually"].includes(type) && (
            <Field
              name={`${path}.source`}
              label="网络来源 / Network source"
              hint={
                network === undefined
                  ? "模板在调用方网络监听器作用域内解析，例如 response:save / Symbolic observer reference resolved in caller scope."
                  : undefined
              }
              options={network?.flatMap((id) =>
                type.startsWith("request")
                  ? [`request:${id}`]
                  : type === "duration"
                    ? [`request:${id}`, `response:${id}`]
                    : [`response:${id}`],
              )}
            />
          )}
          {["requestField", "responseField", "eventually"].includes(type) && (
            <Field name={`${path}.pointer`} label="JSON Pointer (RFC6901)" />
          )}
          {type === "eventually" && (
            <>
              <Field
                name={`${path}.query.path`}
                label="只读 GET 路径 / Read-only query path"
              />
              <JsonField
                name={`${path}.query.query`}
                label="查询参数 / Query parameters"
                allowBinding
              />
              <Field
                name={`${path}.intervalMs`}
                label="轮询间隔 ms / Interval"
                number
                optional
              />
              <small>GET 只读轮询，不重放写操作 / Read-only polling</small>
            </>
          )}
          {boolean ? (
            <Field name={`${path}.expected`} label="预期 / Expected" check />
          ) : number ? (
            <Field name={`${path}.expected`} label="预期 / Expected" number />
          ) : ["ui", "url", "request"].includes(type) ? (
            <Field name={`${path}.expected`} label="预期 / Expected" />
          ) : (
            <JsonField
              name={`${path}.expected`}
              label={
                type === "responseSchema"
                  ? "预期 JSON Schema / Expected schema"
                  : "预期值 / Expected value"
              }
              allowBinding={type !== "responseSchema"}
            />
          )}
        </>
      )}
    </>
  );
}
