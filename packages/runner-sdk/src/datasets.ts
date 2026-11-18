/**
 * 按用例固定的别名读取已经加载的静态文档，仅解析查询参数里的显式绑定；返回值保持原有 JSON 字面类型和内容。
 */
import { isDeepStrictEqual } from "node:util";
import {
    canonicalBytes,
    resolveBinding,
    validateSchema,
    type HttpDatasetSample,
    type HttpDatasetResponse,
    type DatasetDocument,
    type DatasetQuery,
    type JsonObject,
    type JsonValue,
} from "@veriq/contracts";

/**
 * 每次读取接收当前断言展开后的参数与取消信号，使运行时按执行阶段解析预期值，并将错误交给统一结果路径。
 */
export interface DatasetResolver {
    read(
        query: DatasetQuery,
        parameters: JsonObject,
        signal: AbortSignal,
        sampled?: (sample: HttpDatasetSample) => void,
    ): Promise<JsonValue>;
    phase?(): DatasetPhase;
}

/**
 * 每次开启一个独立且可关闭的采样阶段，清除本阶段全部映射行并中断未完成读取后，任何后续读取均被拒绝。
 */
export interface DatasetPhase extends DatasetResolver {
    close(): void;
}

/**
 * 调用者完成版本闭包与文档校验后注入数据；树按父键读取，稳定排序只作用于返回的兄弟节点，不修改冻结行。
 */
export function staticDatasetResolver(documents: ReadonlyMap<string, DatasetDocument>): DatasetResolver {
    return {
        async read(q, parameters, signal) {
            signal.throwIfAborted();
            const doc = documents.get(q.alias);
            if (!doc) throw new Error("UNKNOWN_DATASET_ALIAS");
            return evaluate(doc, q, parameters);
        },
    };
}

function evaluate(doc: DatasetDocument, q: DatasetQuery, parameters: JsonObject): JsonValue {
    const rows = doc.schemaVersion === "1.0" ? doc.rows : doc.source.kind === "STATIC" ? doc.source.rows : undefined;
    if (!rows) throw new Error("DATASET_REMOTE_REQUIRED");
    const fields = doc.schemaVersion === "1.0" ? doc.columns : doc.fields;
    const resolve = (v: JsonValue) => resolveBinding(v, { data: parameters.data ?? {}, vars: parameters.vars ?? {} });
    const field = (values: JsonObject, key: string) => {
        if (!Object.hasOwn(values, key)) throw new Error("DATASET_FIELD_MISSING");
        return structuredClone(values[key]!);
    };
    if ("field" in q && (!Object.hasOwn(fields, q.field) || (q.op === "filter" && !Object.hasOwn(fields, q.select))))
        throw new Error("UNKNOWN_DATASET_FIELD");
    if (q.op === "filter") {
        const equals = resolve(q.equals);
        return rows
            .filter((r) => Object.hasOwn(r.values, q.field) && isDeepStrictEqual(r.values[q.field], equals))
            .map((r) => field(r.values, q.select));
    }
    const key = resolve(q.op === "children" ? q.parentKey : q.key);
    if (typeof key !== "string" && !(q.op === "children" && key === null)) throw new Error("DATASET_KEY_TYPE");
    const row = rows.find((r) => r.key === key);
    if (q.op === "contains") return row !== undefined;
    if (key !== null && !row) throw new Error("DATASET_ROW_MISSING");
    if (q.op === "field") return field(row!.values, q.field);
    if (doc.schemaVersion !== "2.0" || doc.shape !== "TREE" || doc.source.kind !== "STATIC")
        throw new Error("DATASET_TREE_REQUIRED");
    if (q.op === "children")
        return doc.source.rows
            .filter((r) => r.parentKey === key)
            .sort((a, b) => a.order - b.order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
            .map((r) => r.key);
    const byKey = new Map(doc.source.rows.map((r) => [r.key, r]));
    const path = new Set<string>();
    let current = byKey.get(key as string);
    while (current) {
        if (path.has(current.key)) throw new Error("DATASET_TREE_CYCLE");
        path.add(current.key);
        if (current.parentKey === null) break;
        current = byKey.get(current.parentKey);
        if (!current) throw new Error("DATASET_ROW_MISSING");
    }
    return [...path].reverse();
}

/**
 * 平台读取回调只接收已经求值的实参和固定版本，协议没有传递地址、认证头或其它调用方自选连接属性的位置。
 */
export type HttpDatasetReader = (
    versionId: string,
    parameters: JsonObject,
    signal: AbortSignal,
) => Promise<HttpDatasetResponse>;

/**
 * 一个执行上下文绑定单次 Attempt，每个步骤在进入自己的前后断言时创建阶段；同阶段共享整组映射行，再执行各自查询。
 */
export function connectedDatasetResolver(
    documents: ReadonlyMap<string, DatasetDocument>,
    bindings: Record<string, string>,
    environmentVersionId: string,
    fetch?: HttpDatasetReader,
): DatasetResolver {
    const local = staticDatasetResolver(documents);
    if (![...documents.values()].some((doc) => doc.schemaVersion === "2.0" && doc.source.kind === "HTTP")) return local;
    return {
        ...local,
        phase() {
            const controller = new AbortController();
            const samples = new Map<string, Promise<{ document: DatasetDocument; metadata: HttpDatasetSample }>>();
            let bytes = 0;
            return {
                close() {
                    controller.abort();
                    samples.clear();
                },
                async read(query, scope, signal, sampled) {
                    signal.throwIfAborted();
                    controller.signal.throwIfAborted();
                    const doc = documents.get(query.alias);
                    if (!doc || doc.schemaVersion === "1.0" || doc.source.kind === "STATIC")
                        return local.read(query, scope, signal);
                    const versionId = Object.hasOwn(bindings, query.alias) ? bindings[query.alias] : undefined;
                    if (!versionId || !fetch || doc.source.environmentVersionId !== environmentVersionId)
                        throw new Error("DATASET_PROVIDER_REQUIRED");
                    const parameters = resolveBinding(query.parameters ?? {}, {
                        data: scope.data ?? {},
                        vars: scope.vars ?? {},
                    }) as JsonObject;
                    const key = Buffer.from(canonicalBytes([versionId, environmentVersionId, parameters])).toString(
                        "utf8",
                    );
                    let pending = samples.get(key);
                    if (!pending) {
                        if (samples.size >= 256 || Buffer.byteLength(key) > 60000)
                            throw new Error("DATASET_TRANSFER_LIMIT");
                        const sampling = AbortSignal.any([controller.signal, signal]);
                        pending = fetch(versionId, parameters, sampling).then((response) => {
                            sampling.throwIfAborted();
                            const { sourceVersionId, fetchedAt, rows } = response;
                            const metadata = { sourceVersionId, fetchedAt };
                            const document = { ...doc, source: { kind: "STATIC" as const, rows } };
                            if (
                                sourceVersionId !== versionId ||
                                validateSchema("HttpDatasetSample", metadata).length ||
                                validateSchema("DatasetV2", document).length
                            )
                                throw new Error("DATASET_RESPONSE_INVALID");
                            bytes += Buffer.byteLength(key) + canonicalBytes(rows).length;
                            if (bytes > 16 * 1024 * 1024) throw new Error("DATASET_TRANSFER_LIMIT");
                            return { metadata, document: document as DatasetDocument };
                        });
                        samples.set(key, pending);
                    }
                    const { metadata, document } = await pending;
                    controller.signal.throwIfAborted();
                    signal.throwIfAborted();
                    sampled?.(metadata);
                    return evaluate(document, query, scope);
                },
            };
        },
    };
}
