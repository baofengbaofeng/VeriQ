/**
 * 断言列表编辑器：按类型切换算子/期望值，并支持模板版本引用与网络观察源。模板类型只保存 versionId；模板类型断言只持久
 * 化 versionId 引用。
 * 写入资源草稿 RHF 路径；不直接调用校验 API。
 */

import { tx, useAppLocale } from "../../locale";
import type { AssertionV1, DatasetQuery } from "@veriq/contracts";
import {
    Field,
    JsonField,
    List,
    VersionField,
    useValue,
    useSet,
    type VersionOption,
    type PageReferenceScope,
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
const networkAssertionTypes = new Set([
    "request",
    "httpStatus",
    "requestField",
    "responseField",
    "responseSchema",
    "duration",
    "requestCount",
]);
type AssertionPhase = "BEFORE" | "AFTER" | "TEMPLATE";
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
/**
 * 工厂：生成带短 UUID 的默认 ui/visible/BLOCK 断言，expectedSource 标明人工审核。severity 默认 BLOCK。供 List 的 add
 * 回调使用，避免空对象未通过契约。
 */
export const newAssertion = (): AssertionV1 => ({
    id: "assertion_" + crypto.randomUUID().slice(0, 8),
    type: "ui",
    target: "name",
    operator: "visible",
    expected: true,
    severity: "BLOCK",
    expectedSource: "人工审核 / Human review",
});
function literalDefault(type: string, operator: string) {
    if (["visible", "enabled", "checked", "attached", "editable", "exists"].includes(operator)) return true;
    if (operator === "countEquals" || type === "duration" || type === "requestCount") return 1;
    if (type === "httpStatus") return 200;
    if (operator === "in") return [""];
    if (operator === "methodEquals") return "GET";
    if (operator === "pathEquals" || type === "url") return "/";
    return "";
}
function defaults(type: string, network: string[]) {
    const source =
        (type === "request" || type === "requestField" || type === "requestCount" ? "request:" : "response:") +
        (network[0] ?? "observer");
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
        ...(["requestField", "responseField"].includes(type) ? { pointer: "" } : {}),
    };
}
/**
 * 拥有断言数组 UI：类型切换重置 defaults，网络类断言绑定 observer 名列表。pageKeys 限制 UI 目标候选。phase 区分
 * BEFORE/AFTER/TEMPLATE；scope
 * 限制可引用的页面/模板版本。
 */
export function AssertionEditor({
    name,
    title,
    network,
    versions,
    pageKeys = [],
    phase = "TEMPLATE",
    scope,
}: {
    name: string;
    title: string;
    network?: string[];
    versions: VersionOption[];
    pageKeys?: string[];
    phase?: AssertionPhase;
    scope: PageReferenceScope;
}) {
    useAppLocale();
    return (
        <>
            {phase === "BEFORE" && (
                <p>
                    {tx(
                        "前置断言先于本步骤监听器安装；网络响应、计数与耗时断言应放在后置阶段。模板同" +
                            "样受调用阶段约束。 / BEFORE runs before step observers are arm" +
                            "ed; network assertions belong AFTER. Templates inherit the calling phase.",
                    )}
                </p>
            )}
            <List name={name} title={title} initial={newAssertion}>
                {(path) => (
                    <AssertionFields
                        path={path}
                        network={network}
                        versions={versions}
                        pageKeys={pageKeys}
                        phase={phase}
                        scope={scope}
                    />
                )}
            </List>
        </>
    );
}
/**
 * 五种受限查询使用独立字段和类型化 JSON 参数控件，切换操作时重建节点，防止遗留参数混入另一个分支。
 */
function DatasetQueryEditor({ path, query }: { path: string; query: DatasetQuery }) {
    const set = useSet();
    return (
        <>
            <Field name={path + ".alias"} label={tx("查询别名 / Query alias")} />
            <label>
                {tx("查询操作 / Query operation")}
                <select
                    value={query.op}
                    onChange={(e) => {
                        const op = e.target.value;
                        const args =
                            op === "children"
                                ? { parentKey: null }
                                : op === "filter"
                                  ? { field: "value", equals: null, select: "value" }
                                  : op === "field"
                                    ? { key: "row", field: "value" }
                                    : { key: "row" };
                        set(path, { alias: query.alias, op, ...args });
                    }}
                >
                    {["field", "contains", "filter", "path", "children"].map((op) => (
                        <option key={op}>{op}</option>
                    ))}
                </select>
            </label>
            {"field" in query && <Field name={path + ".field"} label={tx("查询字段 / Query field")} />}
            {query.op === "filter" && <Field name={path + ".select"} label={tx("返回字段 / Selected field")} />}
            <JsonField
                key={query.op}
                name={path + (query.op === "filter" ? ".equals" : query.op === "children" ? ".parentKey" : ".key")}
                label={tx("查询参数 / Query argument")}
                allowBinding
            />
        </>
    );
}

function AssertionFields({
    path,
    network,
    versions,
    pageKeys,
    phase,
    scope,
}: {
    path: string;
    network?: string[];
    versions: VersionOption[];
    pageKeys: string[];
    phase: AssertionPhase;
    scope: PageReferenceScope;
}) {
    useAppLocale();
    const a = useValue<AssertionV1>(path),
        set = useSet();
    if (!a) return null;
    const type = a.type,
        operator = "operator" in a ? a.operator : "";
    const offeredTypes = assertionTypes.filter((type) => phase !== "BEFORE" || !networkAssertionTypes.has(type));
    const setType = (type: string) =>
        set(path, {
            id: a.id,
            severity: a.severity,
            expectedSource: a.expectedSource,
            ...(a.timeoutMs === undefined ? {} : { timeoutMs: a.timeoutMs }),
            ...defaults(type, phase === "BEFORE" ? [] : (network ?? [])),
        });
    const number = ["httpStatus", "requestCount", "duration"].includes(type) || operator === "countEquals";
    const boolean = ["visible", "enabled", "checked", "attached", "editable", "exists"].includes(operator);
    return (
        <>
            <Field name={`${path}.id`} label={tx("断言 ID / Assertion ID")} />
            <label>
                {tx("断言类型 / Assertion type")}
                <select value={type} onChange={(e) => setType(e.target.value)}>
                    {!offeredTypes.includes(type) && (
                        <option value={type} disabled>
                            {type} {tx(" · 不适用于前置阶段 / Not available BEFORE")}
                        </option>
                    )}
                    {offeredTypes.map((t) => (
                        <option key={t}>{t}</option>
                    ))}
                </select>
            </label>
            <Field
                name={`${path}.severity`}
                label={tx("严重性 / Severity")}
                options={["BLOCK", "CONTINUE_FAIL", "WARN"]}
            />
            <Field name={`${path}.expectedSource`} label={tx("预期依据 / Expected source")} />
            <Field name={`${path}.timeoutMs`} label={tx("超时 ms / Timeout")} number optional />
            {type === "template" ? (
                <>
                    <VersionField
                        name={`${path}.versionId`}
                        label={tx("断言模板版本 / Template version")}
                        kind="ASSERTION_TEMPLATE"
                        versions={versions}
                    />
                    <JsonField name={`${path}.parameters`} label={tx("模板实参 / Template bindings")} allowBinding />
                </>
            ) : (
                <>
                    <label>
                        {tx("运算符 / Operator")}
                        <select
                            value={operator}
                            onChange={(e) => {
                                const next = e.target.value;
                                set(`${path}.operator`, next);
                                if ("datasetExpected" in a) return;
                                set(`${path}.expected`, literalDefault(type, next));
                            }}
                        >
                            {operators[type]!.map((op) => (
                                <option key={op}>{op}</option>
                            ))}
                        </select>
                    </label>
                    {type === "ui" && <Field name={`${path}.target`} label={tx("元素 key / Target")} />}
                    {["ui", "url"].includes(type) && (
                        <Field
                            name={`${path}.pageKey`}
                            label={tx("页面 / Page (省略=原始页面 / original)")}
                            options={scope === "CASE" ? pageKeys : undefined}
                            showUnlistedValue={scope === "CASE"}
                            optional
                            hint={
                                scope === "CASE"
                                    ? tx("仅显式选择；公共流程内部新页面不泄漏到调用方 / Explicit lexical page scope")
                                    : tx(
                                          "可填写调用方页面 key；实际调用时验证作用域，省略仍为原始页面。 /" +
                                              " Symbolic caller page key; checked at " +
                                              "the calling case. Omission means original page.",
                                      )
                            }
                        />
                    )}
                    {!["ui", "url", "eventually"].includes(type) && (
                        <Field
                            name={`${path}.source`}
                            label={tx("网络来源 / Network source")}
                            hint={
                                network === undefined
                                    ? tx(
                                          "模板在调用方网络监听器作用域内解析，例如 response:save / Symboli" +
                                              "c observer reference resolved" +
                                              " in caller scope.",
                                      )
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
                            <Field name={`${path}.query.path`} label={tx("只读 GET 路径 / Read-only query path")} />
                            <JsonField
                                name={`${path}.query.query`}
                                label={tx("查询参数 / Query parameters")}
                                allowBinding
                            />
                            <Field name={`${path}.intervalMs`} label={tx("轮询间隔 ms / Interval")} number optional />
                            <small>{tx("GET 只读轮询，不重放写操作 / Read-only polling")}</small>
                        </>
                    )}
                    {type !== "responseSchema" && (
                        <label>
                            {tx("预期值方式 / Expected value mode")}
                            <select
                                value={"datasetExpected" in a ? "dataset" : "literal"}
                                onChange={(e) => {
                                    if ("expected" in a && e.target.value === "dataset") {
                                        const { expected: _expected, ...rest } = a;
                                        set(path, {
                                            ...rest,
                                            datasetExpected: {
                                                alias: "dataset",
                                                op: "field",
                                                key: "row",
                                                field: "value",
                                            },
                                        });
                                    } else if ("datasetExpected" in a && e.target.value === "literal") {
                                        const { datasetExpected: _query, ...rest } = a;
                                        set(path, { ...rest, expected: literalDefault(type, operator) });
                                    }
                                }}
                            >
                                <option value="literal">{tx("字面预期值 / Literal value")}</option>
                                <option value="dataset">{tx("数据集查询 / Dataset query")}</option>
                            </select>
                        </label>
                    )}
                    {"datasetExpected" in a ? (
                        <DatasetQueryEditor path={path + ".datasetExpected"} query={a.datasetExpected} />
                    ) : boolean ? (
                        <Field name={`${path}.expected`} label={tx("预期 / Expected")} check />
                    ) : number ? (
                        <Field name={`${path}.expected`} label={tx("预期 / Expected")} number />
                    ) : ["ui", "url", "request"].includes(type) ? (
                        <Field name={`${path}.expected`} label={tx("预期 / Expected")} />
                    ) : (
                        <JsonField
                            name={`${path}.expected`}
                            label={
                                type === "responseSchema"
                                    ? tx("预期 JSON Schema / Expected schema")
                                    : tx("预期值 / Expected value")
                            }
                            allowBinding={type !== "responseSchema"}
                        />
                    )}
                </>
            )}
        </>
    );
}
