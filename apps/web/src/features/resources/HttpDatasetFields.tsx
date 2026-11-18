/**
 * HTTP 数据集编辑器只处理声明、凭证引用和脱敏的预览结果；浏览器不参与出站签名、目标解析或原始响应读取。
 */
import { useState } from "react";
import { useFieldArray } from "react-hook-form";
import type { DatasetHttpSource, DatasetV2, PlatformComponents, JsonValue } from "@veriq/contracts";
import { Button, Section } from "@veriq/ui";
import { ApiError } from "../../api";
import { tx } from "../../locale";
import { Field, JsonField, JsonValueControl, TypeMap, useSet } from "./fields";

type Api = PlatformComponents["schemas"];
/**
 * 预览回调由当前资源页绑定 Workspace、资源和取消信号，组件仅提交可公开的声明与本次输入。
 */
export type HttpPreview = (data: Api["HttpDatasetPreviewRequest"]) => Promise<Api["HttpDatasetPreviewResult"]>;

/**
 * 新建 HTTP 草稿时保留明确的未绑定状态，编辑者可以先配置映射与请求，再选目标工作区的连接及身份。
 */
export function newHttpDataset(shape: DatasetV2["shape"]): DatasetV2 {
    return {
        schemaVersion: "2.0",
        shape,
        fields: { name: { type: "string", required: true, nullable: false } },
        source: {
            kind: "HTTP",
            connectionRef: null,
            environmentVersionId: null,
            method: "GET",
            path: "/items",
            query: [],
            headers: {},
            parameters: {},
            body: null,
            auth: { kind: "NONE" },
            mapping: {
                rows: "/items",
                key: "/id",
                values: { name: "/name" },
                ...(shape === "TREE" ? { parentKey: "/parent", order: "/order" } : {}),
            },
        },
    };
}

/**
 * 参数行独立保存值或引用，重复名称保持插入顺序。签名验证和分页预览都调用当前资源所属的服务器接口。
 */
export function HttpDatasetFields({
    dataset,
    source,
    preview,
}: {
    dataset: DatasetV2;
    source: DatasetHttpSource;
    preview?: HttpPreview;
}) {
    const set = useSet();
    const base = "content.document.source";
    const [args, setArgs] = useState<Record<string, JsonValue>>({});
    const [at, setAt] = useState("2024-01-01T00:00:00Z");
    const [expected, setExpected] = useState("");
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState<{ baseline: string; text: string }>();
    const defaults: Record<string, JsonValue> = {
        string: "",
        number: 0,
        integer: 0,
        null: null,
        object: {},
        array: [],
        boolean: false,
    };
    const arguments_ = Object.fromEntries(
        Object.entries(source.parameters).map(([k, type]) => [k, Object.hasOwn(args, k) ? args[k] : defaults[type]]),
    ) as Record<string, JsonValue>;
    const parameters = Object.keys(source.parameters);
    const baseline = JSON.stringify([dataset, arguments_, at, expected]);
    const auth = source.auth;
    const nullableRef = (path: string, label: string, value: string | null) => (
        <label>
            {tx(label)}
            <input value={value ?? ""} onChange={(e) => set(base + path, e.target.value || null)} />
        </label>
    );
    const body = source.body;
    const bodyKind = !body
        ? "NONE"
        : "form" in body
          ? "FORM"
          : "raw" in body
            ? "RAW"
            : "parameter" in body
              ? "JSON_PARAMETER"
              : "JSON";
    async function run(verify: boolean) {
        if (!preview) return;
        setBusy(true);
        setFeedback(undefined);
        try {
            const result = await preview({
                document: dataset,
                arguments: arguments_,
                ...(verify ? { verifySignature: { at, expected } } : {}),
            });
            const text =
                "signatureMatches" in result
                    ? tx(result.signatureMatches ? "Signature matches" : "Signature differs")
                    : [
                          tx("Mapped rows") + " · " + result.rowCount,
                          ...result.sample.map((row) => row.fields.join(", ")),
                      ].join("\n");
            setFeedback({ baseline, text });
        } catch (error) {
            setFeedback({ baseline, text: error instanceof ApiError ? error.code : "DATASET_PREVIEW_FAILED" });
        } finally {
            setBusy(false);
        }
    }
    return (
        <>
            <Section title={tx("HTTP request")}>
                {nullableRef(".connectionRef", "Connection version", source.connectionRef)}
                {nullableRef(".environmentVersionId", "Environment version", source.environmentVersionId)}
                <label>
                    {tx("HTTP method")}
                    <select
                        value={source.method}
                        onChange={(e) => {
                            set(base, {
                                ...source,
                                method: e.target.value,
                                ...(e.target.value === "GET" ? { body: null } : {}),
                            });
                        }}
                    >
                        <option>GET</option>
                        <option>POST</option>
                    </select>
                </label>
                <Field name={base + ".path"} label={tx("HTTP path")} />
                <TypeMap name={base + ".parameters"} label={tx("Declared parameters")} />
                <OrderedEntries name={base + ".query"} pairs={source.query} form={false} parameters={parameters} />
                <JsonField name={base + ".headers"} label={tx("Request headers")} />
                {source.method === "POST" && (
                    <>
                        <label>
                            {tx("Body format")}
                            <select
                                value={bodyKind}
                                onChange={(e) => {
                                    const kind = e.target.value;
                                    set(
                                        base + ".body",
                                        kind === "FORM"
                                            ? { form: [] }
                                            : kind === "RAW"
                                              ? { raw: "" }
                                              : kind === "JSON_PARAMETER"
                                                ? { parameter: parameters[0] ?? "" }
                                                : kind === "JSON"
                                                  ? { json: {} }
                                                  : null,
                                    );
                                }}
                            >
                                {["NONE", "JSON", "JSON_PARAMETER", "FORM", "RAW"].map((k) => (
                                    <option key={k}>{k}</option>
                                ))}
                            </select>
                        </label>
                        {body && "json" in body && <JsonField name={base + ".body.json"} label={tx("JSON body")} />}
                        {body && "parameter" in body && (
                            <Field name={base + ".body.parameter"} label={tx("Body parameter")} options={parameters} />
                        )}
                        {body && "form" in body && (
                            <OrderedEntries name={base + ".body.form"} pairs={body.form} form parameters={parameters} />
                        )}
                        {body && "raw" in body && (
                            <>
                                <label>
                                    {tx("Raw input")}
                                    <select
                                        value={typeof body.raw === "string" ? "literal" : "parameter"}
                                        onChange={(e) =>
                                            set(
                                                base + ".body.raw",
                                                e.target.value === "literal" ? "" : { parameter: parameters[0] ?? "" },
                                            )
                                        }
                                    >
                                        <option value="literal">{tx("Literal")}</option>
                                        <option value="parameter">{tx("Parameter")}</option>
                                    </select>
                                </label>
                                {typeof body.raw === "string" ? (
                                    <label>
                                        {tx("Raw UTF-8 body")}
                                        <textarea
                                            value={body.raw}
                                            onChange={(e) => set(base + ".body.raw", e.target.value)}
                                        />
                                    </label>
                                ) : (
                                    <Field
                                        name={base + ".body.raw.parameter"}
                                        label={tx("Body parameter")}
                                        options={parameters}
                                    />
                                )}
                            </>
                        )}
                    </>
                )}
            </Section>
            <Section title={tx("Authentication")}>
                <label>
                    {tx("Authentication mode")}
                    <select
                        value={auth.kind}
                        onChange={(e) => {
                            const kind = e.target.value;
                            set(
                                base + ".auth",
                                kind === "NONE"
                                    ? { kind }
                                    : {
                                          kind,
                                          secretRef: null,
                                          secretVersionId: null,
                                          ...(kind === "API_KEY" ? { header: "X-Api-Key" } : {}),
                                          ...(kind === "SIGNED"
                                              ? {
                                                    algorithm: "HMAC_SHA256",
                                                    header: "X-Signature",
                                                    input: { op: "QUERY" },
                                                }
                                              : {}),
                                      },
                            );
                        }}
                    >
                        {["NONE", "BASIC", "BEARER", "API_KEY", "SIGNED"].map((kind) => (
                            <option key={kind}>{kind}</option>
                        ))}
                    </select>
                </label>
                {auth.kind !== "NONE" && (
                    <>
                        {nullableRef(".auth.secretRef", "Credential reference", auth.secretRef)}
                        {nullableRef(".auth.secretVersionId", "Credential version", auth.secretVersionId)}
                    </>
                )}
                {auth.kind === "API_KEY" && <Field name={base + ".auth.header"} label={tx("API key header")} />}
                {auth.kind === "SIGNED" && (
                    <>
                        <Field
                            name={base + ".auth.algorithm"}
                            label={tx("Algorithm")}
                            options={["HMAC_SHA256", "AES256_GCM"]}
                        />
                        <Field name={base + ".auth.header"} label={tx("Signature header")} />
                        <JsonField name={base + ".auth.input"} label={tx("Signature input expression")} />
                    </>
                )}
            </Section>
            <Section title={tx("Response mapping")}>
                <JsonField name="content.document.fields" label={tx("Field declarations")} />
                <Field name={base + ".mapping.rows"} label={tx("Rows pointer")} />
                <Field name={base + ".mapping.key"} label={tx("Row key pointer")} />
                <JsonField name={base + ".mapping.values"} label={tx("Field pointers")} />
                {dataset.shape === "TREE" && (
                    <>
                        <Field name={base + ".mapping.parentKey"} label={tx("Parent key pointer")} />
                        <Field name={base + ".mapping.order"} label={tx("Sibling order pointer")} />
                    </>
                )}
                <label>
                    {tx("Pagination")}
                    <select
                        value={source.pagination?.kind ?? "NONE"}
                        onChange={(e) =>
                            set(
                                base + ".pagination",
                                e.target.value === "NONE"
                                    ? undefined
                                    : {
                                          kind: e.target.value,
                                          parameter: e.target.value === "PAGE" ? "page" : "cursor",
                                          next: "/next",
                                          maxPages: 8,
                                      },
                            )
                        }
                    >
                        {["NONE", "PAGE", "CURSOR"].map((v) => (
                            <option key={v}>{v}</option>
                        ))}
                    </select>
                </label>
                {source.pagination && (
                    <>
                        <Field name={base + ".pagination.parameter"} label={tx("Pagination query parameter")} />
                        <Field name={base + ".pagination.next"} label={tx("Continuation pointer")} />
                        <Field name={base + ".pagination.maxPages"} label={tx("Maximum pages")} number />
                    </>
                )}
            </Section>
            {preview && (
                <Section title={tx("Masked preview")}>
                    {parameters.map((name) => (
                        <JsonValueControl
                            key={name}
                            label={name}
                            value={arguments_[name]!}
                            onChange={(value) => setArgs({ ...args, [name]: value })}
                        />
                    ))}
                    <Button disabled={busy} onClick={() => void run(false)}>
                        {tx("Preview mapped rows")}
                    </Button>
                    {auth.kind === "SIGNED" && auth.algorithm === "HMAC_SHA256" && (
                        <>
                            <label>
                                {tx("Fixed request time")}
                                <input value={at} onChange={(e) => setAt(e.target.value)} />
                            </label>
                            <label>
                                {tx("Expected HMAC (hex)")}
                                <input value={expected} onChange={(e) => setExpected(e.target.value)} />
                            </label>
                            <Button disabled={busy || !/^[a-f0-9]{64}$/.test(expected)} onClick={() => void run(true)}>
                                {tx("Verify signature")}
                            </Button>
                        </>
                    )}
                    {feedback?.baseline === baseline && <pre role="status">{feedback.text}</pre>}
                </Section>
            )}
        </>
    );
}

function OrderedEntries({
    name,
    pairs,
    form,
    parameters,
}: {
    name: string;
    pairs: DatasetHttpSource["query"];
    form: boolean;
    parameters: string[];
}) {
    const set = useSet();
    const array = useFieldArray({ name });
    return (
        <>
            {pairs.map((pair, index) => {
                const path = name + "." + index;
                return (
                    <fieldset key={array.fields[index]?.id}>
                        <Field name={path + ".name"} label={tx(form ? "Form name" : "Query name")} />
                        <label>
                            {tx("Query input")}
                            <select
                                value={typeof pair.value === "string" ? "literal" : "parameter"}
                                onChange={(e) =>
                                    set(
                                        path + ".value",
                                        e.target.value === "literal" ? "" : { parameter: parameters[0] ?? "" },
                                    )
                                }
                            >
                                <option value="literal">{tx("Literal")}</option>
                                <option value="parameter">{tx("Parameter")}</option>
                            </select>
                        </label>
                        {typeof pair.value === "string" ? (
                            <Field name={path + ".value"} label={tx(form ? "Form value" : "Query value")} />
                        ) : (
                            <Field name={path + ".value.parameter"} label={tx("Parameter name")} options={parameters} />
                        )}
                        <Button tone="secondary" disabled={index === 0} onClick={() => array.move(index, index - 1)}>
                            {tx("Move up")}
                        </Button>
                        <Button tone="secondary" onClick={() => array.remove(index)}>
                            {tx(form ? "Remove form parameter" : "Remove query parameter")}
                        </Button>
                    </fieldset>
                );
            })}
            <Button tone="secondary" onClick={() => array.append({ name: "", value: "" })}>
                {tx(form ? "Add form parameter" : "Add query parameter")}
            </Button>
        </>
    );
}
