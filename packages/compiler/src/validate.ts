/**
 * 将资产快照的模式、摘要与依赖语义检查汇合为问题列表，并构造供源码发射使用的类型化执行计划。
 * 分析过程可在报告问题后继续构造计划；发射方必须先确认问题列表为空。
 */

import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
    assertionExpectedTypes,
    type DatasetDocument,
    assetSourceBytes,
    canonicalBytes,
    resolveBinding,
    validateSchema,
    type AssetSnapshotV1,
    type AssetVersionV1,
    type AssertionV1,
    type StepV1,
    type ValueType,
    type CaseDslV1,
    type ParameterTypes,
    type JsonValue,
} from "@veriq/contracts";
import { validateDataset } from "./dataset.js";
import { accepts, pointerKey, sha256, valueType, wireId, resolvePointer, type ValidationIssue } from "./dependency.js";
/**
 * 断言展开预算同时计入模板调用与叶子节点，在每个用例或独立库的分析中累计，限制重复模板图的访问量。
 */
export const MAX_EXPANDED_ASSERTIONS = 5000;
import type { CompiledAssertion, CompiledStep, CompiledCase } from "@veriq/contracts";
/**
 * 从契约包再导出编译计划类型，使编译器调用方和执行端共享步骤阶段、源路径及模板参数栈的结构定义。
 */
export type { CompiledAssertion, CompiledStep, CompiledCase } from "@veriq/contracts";
export { validateDataset };
/**
 * 符号仅描述静态类型及属性可见性，联合候选与沿路径传播的可选标记用于拒绝可能缺值或类型不兼容的绑定。
 * properties 保存可推断的对象属性；它不承载实际数据，也不替代运行时的存在性与模式校验。
 */
interface SymbolType {
    type: ValueType;
    alternatives?: ValueType[];
    optional?: boolean;
    properties?: Map<string, SymbolType>;
}
/**
 * 作用域携带数据与变量符号、目录绑定和页面名称，递归调用按各字段的可见范围复制或共享这些分析状态。
 * 参数调用复制 data，流程共享 vars 与断言预算；步骤递归另复制 pages，子流程页面声明不会回传父层。
 * 独立库通过 library 容许调用方提供外部名称，localDefinitions 仍约束库内提取变量的定义顺序。
 * externalObservers 使独立模板暂缓检查观察器来源，具体用例展开时再按当前步骤验证。
 */
interface Scope {
    pages?: Set<string>;
    data: Map<string, SymbolType>;
    vars: Map<string, SymbolType>;
    datasets?: Map<string, DatasetDocument>;
    catalog?: Set<string>;
    locatorBindings?: Map<string, unknown[]>;
    library?: boolean;
    localDefinitions?: Set<string>;
    externalObservers?: boolean;
    assertionBudget?: {
        count: number;
    };
}
/**
 * 分析结果同时保存问题与已构造的用例计划；存在问题时计划可能不完整，调用方不能据此直接发射可执行产物。
 */
export interface Analysis {
    issues: ValidationIssue[];
    cases: CompiledCase[];
}
/**
 * 先校验快照模式，再核对源码及文档摘要并分析所有资产；返回问题与执行计划，供编译发射和诊断投影共用。
 * 模式错误或源码规范化异常会提前返回；摘要不匹配则记入问题后继续收集语义错误。
 */
export function analyze(snapshot: AssetSnapshotV1): Analysis {
    const issues: ValidationIssue[] = validateSchema("AssetSnapshotV1", snapshot);
    const cases: CompiledCase[] = [];
    const jsonSchemas = new Ajv2020({ strict: false, allErrors: true });
    addFormats.default(jsonSchemas);
    const fail = (code: string, path: string, message = code) => {
        issues.push({ code, path, message });
    };
    if (issues.length) return { issues, cases };
    try {
        if (sha256(assetSourceBytes(snapshot)) !== snapshot.sourceHash) fail("SOURCE_HASH_MISMATCH", "/sourceHash");
    } catch {
        fail("INVALID_JSON", "");
        return { issues, cases };
    }
    /**
     * 源码摘要覆盖契约定义的源投影，单份文档摘要另绑定资产种类与文档；两者分别核对并保留各自的问题位置。
     */
    const assets = new Map<string, AssetVersionV1>();
    const edges = new Map<string, Set<string>>();
    const paths = new Map<string, string>();
    for (const [i, a] of snapshot.assets.entries()) {
        const p = `/assets/${i}`;
        paths.set(a.versionId, p);
        if (assets.has(a.versionId)) fail("DUPLICATE_VERSION", p);
        assets.set(a.versionId, a);
        edges.set(a.versionId, new Set());
        if (sha256(canonicalBytes({ kind: a.kind, document: a.document })) !== a.sha256)
            fail("DOCUMENT_HASH_MISMATCH", p + "/sha256");
    }
    /**
     * 引用检查同时登记有向依赖边，缺失版本或种类不符仍保留边记录，末尾据根节点判断快照中资产是否可达。
     */
    function ref(owner: string, id: string, kind: AssetVersionV1["kind"], p: string): AssetVersionV1 | undefined {
        edges.get(owner)?.add(id);
        const found = assets.get(id);
        if (!found) fail("MISSING_REFERENCE", p, id);
        else if (found.kind !== kind) fail("REFERENCE_KIND_MISMATCH", p, `Expected ${kind}`);
        else return found;
    }
    /**
     * 独立发布允许空的参考数据集。CASE 默认引用或 SUITE 覆盖真正用作矩阵时，零行会使执行任务消失，须明确拒绝。
     * 引用缺失和种类不匹配由引用校验处理，这里只报告合法数据集不能驱动矩阵这一问题。
     */
    function checkMatrixDataset(dataset: AssetVersionV1 | undefined, path: string) {
        if (
            dataset?.kind === "DATASET" &&
            dataset.document.schemaVersion === "2.0" &&
            dataset.document.source.rows.length === 0
        )
            fail("DATASET_EMPTY_MATRIX", path);
    }

    const unique = (values: string[], p: string, code = "DUPLICATE_ID") => {
        const seen = new Set<string>();
        for (const v of values) {
            if (seen.has(v)) fail(code, p, v);
            seen.add(v);
        }
    };
    unique(snapshot.entryCaseVersionIds, "/entryCaseVersionIds", "DUPLICATE_ENTRY_CASE");
    for (const id of snapshot.entryCaseVersionIds)
        if (assets.get(id)?.kind !== "CASE") fail("INVALID_ENTRY_CASE", "/entryCaseVersionIds", id);
    /**
     * 验证目标将根资源与入口集合关联起来：用例要求唯一对应入口，套件比较去重后的用例集合，库目标要求零入口。
     */
    if (snapshot.validationTarget) {
        const t = snapshot.validationTarget;
        const a = assets.get(t.versionId);
        if (
            !a ||
            a.resourceId !== t.resourceId ||
            (a.kind === "CASE" &&
                (snapshot.entryCaseVersionIds.length !== 1 || snapshot.entryCaseVersionIds[0] !== a.versionId)) ||
            (a.kind === "SUITE" &&
                (new Set(a.document.cases.map((c) => c.versionId)).size !== snapshot.entryCaseVersionIds.length ||
                    a.document.cases.some((c) => !snapshot.entryCaseVersionIds.includes(c.versionId)))) ||
            (a.kind !== "CASE" && a.kind !== "SUITE" && snapshot.entryCaseVersionIds.length !== 0)
        )
            fail("INVALID_VALIDATION_TARGET", "/validationTarget");
    }
    /**
     * 无显式验证目标时只接受一个与入口集合对应的套件根，以其变体数据分析用例；显式用例目标保留自身数据上下文。
     */
    let suiteRoot: Extract<AssetVersionV1, { kind: "SUITE" }> | undefined;
    if (snapshot.validationTarget) {
        const root = assets.get(snapshot.validationTarget.versionId);
        if (root?.kind === "SUITE") suiteRoot = root;
    } else {
        const roots = snapshot.assets.filter(
            (a): a is Extract<AssetVersionV1, { kind: "SUITE" }> =>
                a.kind === "SUITE" &&
                new Set(a.document.cases.map((c) => c.versionId)).size === snapshot.entryCaseVersionIds.length &&
                a.document.cases.every((c) => snapshot.entryCaseVersionIds.includes(c.versionId)),
        );
        if (roots.length > 1) fail("AMBIGUOUS_SUITE_ROOT", "/assets");
        else suiteRoot = roots[0];
    }
    /**
     * 预收集流程内及有界嵌套流程的提取名称，让独立库能区分尚未定义的本地变量与允许由未来调用方提供的变量。
     */
    function localDefinitions(list: StepV1[], seen = new Set<string>()): Set<string> {
        const names = new Set(list.flatMap((step) => (step.extract ?? []).map((e) => e.to)));
        if (seen.size >= 5) return names;
        for (const step of list)
            if (step.action === "callFlow" && !seen.has(step.versionId)) {
                const flow = assets.get(step.versionId);
                if (flow?.kind === "FLOW")
                    for (const name of localDefinitions(flow.document.steps, new Set([...seen, step.versionId])))
                        names.add(name);
            }
        return names;
    }
    function sym(type: ValueType): SymbolType {
        return { type };
    }
    /**
     * 从模式声明与本地引用推断值类型，保留类型联合和对象必填属性信息；未写类型时以所有候选类型表达不确定性。
     */
    function schemaSymbol(schema: unknown, root: unknown = schema, seen = new Set<string>()): SymbolType | undefined {
        if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
        const s = schema as Record<string, unknown>;
        if (typeof s.$ref === "string" && s.$ref.startsWith("#/") && !seen.has(s.$ref)) {
            const resolved = resolvePointer(root as JsonValue, s.$ref.slice(1));
            if (resolved.present) return schemaSymbol(resolved.value, root, new Set([...seen, s.$ref]));
        }
        const types = ["string", "number", "integer", "boolean", "object", "array", "null"];
        const declared = Array.isArray(s.type) ? s.type : typeof s.type === "string" ? [s.type] : types;
        if (!declared.length || declared.some((t) => typeof t !== "string" || !types.includes(t))) return;
        const out: SymbolType = {
            type: declared[0] as ValueType,
            ...(declared.length > 1 ? { alternatives: declared as ValueType[] } : {}),
        };
        if (s.type === "object" && s.properties && typeof s.properties === "object") {
            out.properties = new Map();
            for (const [k, v] of Object.entries(s.properties)) {
                const child = schemaSymbol(v, root, seen);
                if (child) {
                    child.optional = !Array.isArray(s.required) || !s.required.includes(k);
                    out.properties.set(k, child);
                }
            }
        }
        return out;
    }
    /**
     * 逐行合并数据集实际值的嵌套属性类型，并把仅部分行存在的属性标为可选，避免单行样例掩盖其它冻结行的缺值。
     */
    function dataSymbol(values: JsonValue[]): SymbolType {
        const types = [...new Set(values.map(valueType))];
        const result: SymbolType = {
            type: types[0] ?? "null",
            ...(types.length > 1 ? { alternatives: types } : {}),
        };
        if (values.every((v) => v !== null && typeof v === "object" && !Array.isArray(v))) {
            const objects = values as Record<string, JsonValue>[];
            result.properties = new Map();
            for (const key of new Set(objects.flatMap(Object.keys))) {
                const present = objects.filter((v) => Object.hasOwn(v, key));
                const child = dataSymbol(present.map((v) => v[key]!));
                child.optional = present.length !== objects.length;
                result.properties.set(key, child);
            }
        }
        return result;
    }
    /**
     * 完整占位符保留符号路径原类型，嵌入文本拒绝对象、数组与空值；可选祖先传播缺值风险，预期类型须兼容全部候选。
     * 数组与对象只递归检查显式绑定值；这里不执行表达式，也不读取运行时变量的实际内容。
     */
    function binding(v: unknown, scope: Scope, p: string, expected?: ValueType): SymbolType | undefined {
        if (typeof v === "string") {
            const matches = [
                ...v.matchAll(/\{\{(data|vars)\.([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\}\}/gu),
            ];
            let full: SymbolType | undefined;
            for (const m of matches) {
                const keys = m[2]!.split(".");
                let found = scope[m[1] as "data" | "vars"].get(keys.shift()!);
                let optional = found?.optional ?? false;
                for (const k of keys) {
                    found = found?.properties?.get(k);
                    optional ||= found?.optional ?? false;
                }
                if (!found) {
                    if (!scope.library || (m[1] === "vars" && scope.localDefinitions?.has(m[2]!.split(".")[0]!)))
                        fail(m[1] === "vars" ? "VARIABLE_USED_BEFORE_DEFINED" : "UNKNOWN_DATA_BINDING", p, m[0]);
                    continue;
                }
                if (optional) fail("POSSIBLY_MISSING_VARIABLE", p, m[0]);
                if (m[0] === v) full = found;
                else if ((found.alternatives ?? [found.type]).some((t) => ["object", "array", "null"].includes(t)))
                    fail("BINDING_TYPE_MISMATCH", p);
            }
            const result = full ?? sym("string");
            if (expected && !(result.alternatives ?? [result.type]).every((t) => accepts(expected, t)))
                fail("BINDING_TYPE_MISMATCH", p, `Expected ${expected}, got ${result.type}`);
            return result;
        }
        if (Array.isArray(v))
            v.forEach((x, i) => {
                binding(x, scope, `${p}/${i}`);
            });
        const result = sym(valueType(v));
        if (v && typeof v === "object" && !Array.isArray(v)) {
            result.properties = new Map();
            for (const [k, x] of Object.entries(v)) {
                const child = binding(x, scope, `${p}/${pointerKey(k)}`);
                if (child) result.properties.set(k, child);
            }
        }
        if (expected && !(result.alternatives ?? [result.type]).every((t) => accepts(expected, t)))
            fail("BINDING_TYPE_MISMATCH", p);
        return result;
    }
    /**
     * 夹具输入中的变量值在此尚未知，只校验可确定的类型与结构；不含变量的子树结合冻结数据行交给原模式位置验证。
     * 本地引用保留在同一模式根下；依赖未知值的完整约束留待组装与执行端使用实际值验证。
     */
    function fixtureInput(
        input: JsonValue,
        schema: JsonValue,
        data: Record<string, JsonValue>,
        scope: Scope,
        path: string,
    ): void {
        const dynamic = (value: JsonValue): boolean =>
            typeof value === "string"
                ? /\{\{vars\./u.test(value)
                : value !== null && typeof value === "object" && Object.values(value).some(dynamic);
        const schemas = new Ajv2020({ strict: false, allErrors: true });
        addFormats.default(schemas);
        const rootId = "urn:veriq:fixture-input";
        schemas.addSchema(schema as object, rootId);
        const visit = (
            value: JsonValue,
            definition: JsonValue,
            pointer: string,
            p: string,
            seen = new Set<string>(),
        ): void => {
            if (!dynamic(value)) {
                if (!schemas.compile({ $ref: rootId + "#" + pointer })(resolveBinding(value, { data, vars: {} })))
                    fail("FIXTURE_INPUT_INVALID", p);
                return;
            }
            if (definition === false) {
                fail("FIXTURE_INPUT_INVALID", p);
                return;
            }
            if (!definition || typeof definition !== "object" || Array.isArray(definition)) return;
            const expected = schemaSymbol(definition, schema);
            const actual = binding(value, scope, p);
            if (
                expected &&
                actual &&
                !(actual.alternatives ?? [actual.type]).every((t) =>
                    (expected.alternatives ?? [expected.type]).some((e) => accepts(e, t)),
                )
            )
                fail("BINDING_TYPE_MISMATCH", p);
            const ref = definition.$ref;
            if (typeof ref === "string" && ref.startsWith("#/") && !seen.has(ref)) {
                const target = resolvePointer(schema, ref.slice(1));
                if (target.present) visit(value, target.value, ref.slice(1), p, new Set([...seen, ref]));
            }
            if (Array.isArray(definition.allOf))
                definition.allOf.forEach((child, i) => {
                    visit(value, child, `${pointer}/allOf/${i}`, p, seen);
                });
            if (value !== null && typeof value === "object" && !Array.isArray(value)) {
                const properties = definition.properties;
                const declared =
                    properties && typeof properties === "object" && !Array.isArray(properties) ? properties : {};
                /**
                 * 对象键由输入字面结构确定，即使某些属性值仍依赖变量，也能立即验证必填键、属性数量和键名等结构约束。
                 */
                const shape = Object.fromEntries(
                    ["required", "minProperties", "maxProperties", "propertyNames", "dependentRequired"]
                        .filter((k) => Object.hasOwn(definition, k))
                        .map((k) => [
                            k,
                            k === "propertyNames" ? { $ref: rootId + "#" + pointer + "/propertyNames" } : definition[k],
                        ]),
                );
                /**
                 * 额外键是否允许也受模式属性匹配影响，这里交给模式校验器，并在后续递归中验证每个命中的属性值约束。
                 */
                const patterns = definition.patternProperties;
                const patternKeys =
                    patterns && typeof patterns === "object" && !Array.isArray(patterns) ? Object.keys(patterns) : [];
                if (
                    !schemas.compile({
                        ...shape,
                        type: "object",
                        properties: Object.fromEntries(Object.keys(declared).map((k) => [k, true])),
                        patternProperties: Object.fromEntries(patternKeys.map((k) => [k, true])),
                        ...(definition.additionalProperties === false ? { additionalProperties: false } : {}),
                    })(value)
                )
                    fail("FIXTURE_INPUT_INVALID", p);
                for (const [key, child] of Object.entries(value)) {
                    if (Object.hasOwn(declared, key))
                        visit(
                            child,
                            declared[key]!,
                            `${pointer}/properties/${pointerKey(key)}`,
                            `${p}/${pointerKey(key)}`,
                        );
                    for (const pattern of patternKeys)
                        if (new RegExp(pattern, "u").test(key))
                            visit(
                                child,
                                (patterns as Record<string, JsonValue>)[pattern]!,
                                `${pointer}/patternProperties/${pointerKey(pattern)}`,
                                `${p}/${pointerKey(key)}`,
                            );
                    if (
                        !Object.hasOwn(declared, key) &&
                        !patternKeys.some((pattern) => new RegExp(pattern, "u").test(key)) &&
                        typeof definition.additionalProperties === "object"
                    )
                        visit(
                            child,
                            definition.additionalProperties!,
                            `${pointer}/additionalProperties`,
                            `${p}/${pointerKey(key)}`,
                        );
                }
            } else if (Array.isArray(value)) {
                const shape = Object.fromEntries(
                    ["minItems", "maxItems"].filter((k) => Object.hasOwn(definition, k)).map((k) => [k, definition[k]]),
                );
                if (!schemas.compile({ type: "array", ...shape })(value)) fail("FIXTURE_INPUT_INVALID", p);
                value.forEach((child, i) => {
                    const prefix = definition.prefixItems;
                    if (Array.isArray(prefix) && i < prefix.length)
                        visit(child, prefix[i]!, `${pointer}/prefixItems/${i}`, `${p}/${i}`);
                    else if (definition.items !== undefined)
                        visit(child, definition.items, `${pointer}/items`, `${p}/${i}`);
                });
            }
        };
        visit(input, schema, "", path);
    }
    /**
     * 参数实参在调用方当前作用域检查，随后仅复制数据名称表并覆盖已声明参数，保留调用前的变量表和共享预算。
     */
    function params(
        declared: ParameterTypes | undefined,
        supplied: Record<string, JsonValue> | undefined,
        scope: Scope,
        p: string,
    ): Scope {
        const data = new Map(scope.data);
        for (const [key, type] of Object.entries(declared ?? {})) {
            if (!Object.hasOwn(supplied ?? {}, key)) fail("MISSING_PARAMETER", p, key);
            else {
                const found = binding(supplied![key], scope, p + "/" + pointerKey(key), type);
                data.set(key, found ?? sym(type));
            }
        }
        for (const key of Object.keys(supplied ?? {}))
            if (!Object.hasOwn(declared ?? {}, key)) fail("UNKNOWN_PARAMETER", p, key);
        return { ...scope, data };
    }
    function checkJsonSchema(schema: unknown, path: string): void {
        try {
            jsonSchemas.compile(schema as object);
        } catch (error) {
            fail("INVALID_JSON_SCHEMA", path, String(error));
        }
    }
    /**
     * 目标键先受已固定目录的可见集合约束，再校验该元素及其祖先作用域的动态记录键与角色名称都能解析为字符串。
     */
    function target(key: string, scope: Scope, p: string): void {
        if (scope.catalog && !scope.catalog.has(key)) fail("UNKNOWN_ELEMENT", p);
        for (const v of scope.locatorBindings?.get(key) ?? []) binding(v, scope, p, "string");
    }
    function source(source: string, observers: Set<string>, p: string) {
        if (source !== "page" && !observers.has(source.slice(source.indexOf(":") + 1)))
            fail("UNKNOWN_OBSERVER", p, source);
    }
    /**
     * 模板展开保留外层到内层的实参栈与叶子源路径，执行端据此恢复断言数据作用域；模板警告级别会向叶子传播。
     * 递归栈分别限制模板环与五层深度，所有调用和叶子在访问前消耗同一断言预算。
     */
    function assertions(
        list: AssertionV1[],
        owner: string,
        scope: Scope,
        observers: Set<string>,
        p: string,
        stack: string[] = [],
        bindings: Record<string, JsonValue>[] = [],
    ): CompiledAssertion[] {
        scope = {
            ...scope,
            assertionBudget: scope.assertionBudget ?? { count: 0 },
        };
        unique(
            list.map((a) => a.id),
            p,
        );
        const result: CompiledAssertion[] = [];
        for (const [i, a] of list.entries()) {
            const path = `${p}/${i}`;
            if (scope.assertionBudget!.count++ >= MAX_EXPANDED_ASSERTIONS) {
                if (scope.assertionBudget!.count === MAX_EXPANDED_ASSERTIONS + 1)
                    fail(
                        "EXPANDED_ASSERTION_LIMIT",
                        path,
                        `At most ${MAX_EXPANDED_ASSERTIONS} expanded assertion nodes per case/library`,
                    );
                break;
            }
            if (a.type === "template") {
                const t = ref(owner, a.versionId, "ASSERTION_TEMPLATE", path + "/versionId");
                if (stack.includes(a.versionId)) {
                    fail("TEMPLATE_CYCLE", path);
                    continue;
                }
                if (stack.length >= 5) {
                    fail("TEMPLATE_DEPTH_LIMIT", path);
                    continue;
                }
                if (t?.kind === "ASSERTION_TEMPLATE")
                    result.push(
                        ...assertions(
                            t.document.assertions,
                            t.versionId,
                            params(t.document.parameters, a.parameters, scope, path),
                            observers,
                            path + "/template",
                            [...stack, a.versionId],
                            [...bindings, a.parameters ?? {}],
                        ).map((x) => ({
                            ...x,
                            assertion: {
                                ...x.assertion,
                                severity: a.severity === "WARN" ? "WARN" : x.assertion.severity,
                            },
                        })),
                    );
                continue;
            }
            if ("source" in a && !scope.externalObservers) source(a.source, observers, path + "/source");
            if ("pageKey" in a && a.pageKey && !scope.pages?.has(a.pageKey) && !scope.library)
                fail("UNKNOWN_PAGE_KEY", path + "/pageKey");
            if ("target" in a) target(a.target, scope, path + "/target");
            if (a.type === "responseSchema") checkJsonSchema(a.expected, path + "/expected");
            if ("expected" in a && a.type !== "responseSchema")
                binding(
                    a.expected,
                    scope,
                    path + "/expected",
                    (a.type === "ui" && ["textEquals", "textContains", "valueEquals"].includes(a.operator)) ||
                        a.type === "url"
                        ? "string"
                        : undefined,
                );
            if ("datasetExpected" in a) {
                const q = a.datasetExpected;
                const at = path + "/datasetExpected";
                const dataset = scope.datasets?.get(q.alias);
                if (!dataset && !scope.library) fail("UNKNOWN_DATASET_ALIAS", at + "/alias");
                const argument = q.op === "filter" ? "equals" : q.op === "children" ? "parentKey" : "key";
                const input = binding(
                    q.op === "filter" ? q.equals : q.op === "children" ? q.parentKey : q.key,
                    scope,
                    at + "/" + argument,
                );
                const argumentTypes = input?.alternatives ?? (input ? [input.type] : []);
                if (
                    q.op !== "filter" &&
                    argumentTypes.some((t) => t !== "string" && !(q.op === "children" && t === "null"))
                )
                    fail("DATASET_KEY_TYPE", at + "/" + argument);
                if (dataset) {
                    const fields = dataset.schemaVersion === "1.0" ? dataset.columns : dataset.fields;
                    const types = (field: string, key: string): ValueType[] => {
                        if (!Object.hasOwn(fields, field)) {
                            fail("UNKNOWN_DATASET_FIELD", at + "/" + key);
                            return [];
                        }
                        const spec = fields[field]!;
                        return typeof spec === "string" ? [spec] : spec.nullable ? [spec.type, "null"] : [spec.type];
                    };
                    let output: ValueType[] = ["array"];
                    if (q.op === "filter") {
                        const match = types(q.field, "field");
                        types(q.select, "select");
                        if (!argumentTypes.every((t) => match.some((m) => accepts(m, t))))
                            fail("DATASET_FILTER_TYPE", at);
                    } else if (q.op === "field") output = types(q.field, "field");
                    else if (q.op === "contains") output = ["boolean"];
                    else if (dataset.schemaVersion === "1.0" || dataset.shape !== "TREE")
                        fail("DATASET_TREE_REQUIRED", at);
                    const accepted = assertionExpectedTypes(a);
                    if (!output.every((t) => accepted.some((e) => accepts(e, t)))) fail("DATASET_EXPECTED_TYPE", at);
                }
            }
            if (a.type === "eventually") binding(a.query, scope, path + "/query");
            result.push({
                assertion: { ...a, id: wireId(path) },
                sourceId: a.id,
                sourcePath: path,
                parameters: bindings,
            });
        }
        return result;
    }
    /**
     * 步骤展开为每次流程调用保留包装节点和子计划，调用边界也消耗五百步预算；流程环与五层深度另行检查。
     * 前置断言先分析，流程子步骤随后共享变量表，当前步骤提取再加入符号表，最后分析后置断言。
     */
    function steps(
        list: StepV1[],
        owner: string,
        scope: Scope,
        p: string,
        stack: string[],
        budget: {
            count: number;
        },
        write: boolean,
    ): CompiledStep[] {
        scope = {
            ...scope,
            assertionBudget: scope.assertionBudget ?? { count: 0 },
            pages: new Set(scope.pages ?? []),
        };
        unique(
            list.map((s) => s.id),
            p,
        );
        const out: CompiledStep[] = [];
        for (const [i, s] of list.entries()) {
            const path = `${p}/${i}`;
            if (++budget.count > 500) {
                fail(
                    "EXPANDED_STEP_LIMIT",
                    path,
                    `Expanded step count ${budget.count} exceeds 500 including callFlow boundaries`,
                );
                break;
            }
            /**
             * 仅网络观察器可作为请求或响应来源，事件监听器与其一起检查名称重复；前置断言使用尚未注册观察器的空集合。
             */
            const obs = new Set((s.observers ?? []).filter((o) => "method" in o).map((o) => o.id));
            unique([...(s.observers ?? []).map((o) => o.id)], path + "/observers");
            const before = assertions(s.beforeAssertions ?? [], owner, scope, new Set(), path + "/beforeAssertions");
            /**
             * 动作所选页面必须来自此前声明，当前步骤的新页面监听名称随后才加入作用域，供其后置断言及后续步骤引用。
             */
            if (s.pageKey && !scope.pages?.has(s.pageKey) && !scope.library)
                fail("UNKNOWN_PAGE_KEY", path + "/pageKey");
            for (const o of s.observers ?? [])
                if ("kind" in o && o.kind === "newPage" && typeof o.pageKey === "string") {
                    if (scope.pages!.has(o.pageKey)) fail("DUPLICATE_PAGE_KEY", path + "/observers");
                    scope.pages!.add(o.pageKey);
                }
            if ("target" in s) target(s.target, scope, path + "/target");
            for (const k of ["path", "value", "body", "query"] as const)
                if (k in s)
                    binding(
                        (s as unknown as Record<string, unknown>)[k],
                        scope,
                        path + "/" + k,
                        k === "value" &&
                            (s.action === "fill" ||
                                s.action === "press" ||
                                (s.action === "selectOption" && typeof s.value === "string"))
                            ? "string"
                            : undefined,
                    );
            if (s.action === "apiRequest")
                for (const [name, value] of Object.entries(s.headers ?? {}))
                    binding(value, scope, path + "/headers/" + pointerKey(name), "string");
            if (s.action === "selectOption" && Array.isArray(s.value))
                s.value.forEach((v, i) => {
                    binding(v, scope, path + "/value/" + i, "string");
                });
            for (const o of s.observers ?? [])
                for (const k of ["path", "bodyMatch", "queryMatch", "message", "promptText"] as const)
                    if (k in o)
                        binding(
                            (o as unknown as Record<string, unknown>)[k],
                            scope,
                            path + "/observers/" + o.id + "/" + k,
                            k === "message" || k === "promptText" ? "string" : undefined,
                        );
            let children: CompiledStep[] | undefined;
            if (s.action === "callFlow") {
                const f = ref(owner, s.versionId, "FLOW", path + "/versionId");
                if (stack.includes(s.versionId)) fail("FLOW_CYCLE", path);
                else if (stack.length >= 5) fail("FLOW_DEPTH_LIMIT", path);
                else if (f?.kind === "FLOW")
                    children = steps(
                        f.document.steps,
                        f.versionId,
                        params(f.document.parameters, s.parameters, scope, path + "/parameters"),
                        path + "/flow",
                        [...stack, s.versionId],
                        budget,
                        write,
                    );
            }
            /**
             * 流程内提取已通过共享变量表对后续分析可见，包装步骤的提取在子流程之后登记，并按必填声明标记是否可能缺值。
             */
            for (const [j, e] of (s.extract ?? []).entries()) {
                source(e.source, obs, path + "/extract/" + j);
                if (scope.vars.has(e.to)) fail("DUPLICATE_VARIABLE", path + "/extract/" + j, e.to);
                scope.vars.set(e.to, { type: e.valueType, optional: !e.required });
            }
            const after = assertions(s.afterAssertions ?? [], owner, scope, obs, path + "/afterAssertions");
            /**
             * 写用例关键步骤须有非警告响应字段业务断言，允许相等、集合归属或包含操作；状态码或界面断言不满足此处。
             */
            if (
                write &&
                s.critical &&
                !after.some(
                    (a) =>
                        a.assertion.type === "responseField" &&
                        ["equals", "in", "contains"].includes(a.assertion.operator) &&
                        a.assertion.severity !== "WARN",
                )
            )
                fail("MISSING_BUSINESS_ASSERTION", path);
            /**
             * 后置断言按是否依赖本步新变量分流；实参栈、预期值、查询及继承目录绑定都参与检查，响应模式内容保持字面值。
             * 无依赖项进入 responseAssertions，执行端先验证响应再提取；依赖项进入 after，在提取赋值后执行。
             */
            const extracts = new Set((s.extract ?? []).map((e) => e.to));
            const usesExtract = (value: unknown): boolean =>
                typeof value === "string"
                    ? [...value.matchAll(/\{\{vars\.([A-Za-z_][A-Za-z0-9_]*)/gu)].some((m) => extracts.has(m[1]!))
                    : Array.isArray(value)
                      ? value.some(usesExtract)
                      : !!value && typeof value === "object" && Object.values(value).some(usesExtract);
            const dependent = (a: CompiledAssertion): boolean =>
                usesExtract(a.parameters) ||
                ("datasetExpected" in a.assertion && usesExtract(a.assertion.datasetExpected)) ||
                (a.assertion.type !== "responseSchema" &&
                    "expected" in a.assertion &&
                    usesExtract(a.assertion.expected)) ||
                (a.assertion.type === "eventually" && usesExtract(a.assertion.query)) ||
                ("target" in a.assertion && usesExtract(scope.locatorBindings?.get(a.assertion.target) ?? []));
            /**
             * 动作载荷移除原断言列表以免执行端重复运行，步骤及断言传输标识均由展开路径派生，保留原标识供报告映射。
             */
            const { beforeAssertions: _before, afterAssertions: _after, ...action } = s;
            out.push({
                step: { ...action, id: wireId(path) },
                sourceId: s.id,
                sourcePath: path,
                before,
                responseAssertions: after.filter((a) => !dependent(a)),
                after: after.filter(dependent),
                ...(children ? { children } : {}),
            });
        }
        return out;
    }
    for (const a of snapshot.assets) {
        const p = paths.get(a.versionId)! + "/document";
        if (a.kind === "CASE") {
            const d = a.document;
            const c = ref(a.versionId, d.catalogVersionId, "ELEMENT_CATALOG", p + "/catalogVersionId");
            /**
             * 同一用例可能由套件覆盖为多种数据上下文，每种有效数据集都重新分析类型与变量；最终只保留第一份用例计划。
             */
            const variants = suiteRoot?.document.cases.filter((c) => c.versionId === a.versionId);
            if (d.datasetVersionId) {
                const inputPath = p + "/datasetVersionId";
                const dataset = ref(a.versionId, d.datasetVersionId, "DATASET", inputPath);
                if (!variants?.length || variants.some((variant) => !variant.datasetVersionId))
                    checkMatrixDataset(dataset, inputPath);
            }
            const named = new Map<string, DatasetDocument>();
            for (const [alias, id] of Object.entries(d.datasetBindings ?? {})) {
                const version = ref(a.versionId, id, "DATASET", p + "/datasetBindings/" + pointerKey(alias));
                if (version?.kind === "DATASET") named.set(alias, version.document);
            }
            const datasets = variants?.length
                ? [...new Set(variants.map((c) => c.datasetVersionId ?? d.datasetVersionId))]
                : [d.datasetVersionId];
            let compiled: CompiledCase | undefined;
            for (const datasetVersionId of datasets) {
                const scope: Scope = {
                    datasets: named,
                    data: new Map(),
                    vars: new Map(Object.entries(d.initialVariables ?? {}).map(([key, type]) => [key, { type }])),
                    ...(c?.kind === "ELEMENT_CATALOG"
                        ? { catalog: new Set(c.document.elements.map((e) => e.key)) }
                        : {}),
                };
                if (c?.kind === "ELEMENT_CATALOG") {
                    scope.locatorBindings = new Map();
                    const elements = new Map(c.document.elements.map((e) => [e.key, e]));
                    for (const e of c.document.elements) {
                        const values: unknown[] = [];
                        const seen = new Set<string>();
                        let current: typeof e | undefined = e;
                        while (current && !seen.has(current.key)) {
                            seen.add(current.key);
                            if (current.recordKey) values.push(current.recordKey);
                            if (current.locator.by === "role" && current.locator.name)
                                values.push(current.locator.name);
                            current = current.scope ? elements.get(current.scope) : undefined;
                        }
                        scope.locatorBindings.set(e.key, values);
                    }
                }
                const selected = datasetVersionId ? assets.get(datasetVersionId) : undefined;
                const dataset = selected?.kind === "DATASET" ? selected.document : undefined;
                const rows = dataset?.schemaVersion === "1.0" ? dataset.rows : dataset?.source.rows;
                if (dataset?.schemaVersion === "1.0") {
                    for (const [key, type] of Object.entries(dataset.columns)) {
                        const present = dataset.rows.filter((row) => Object.hasOwn(row.values, key));
                        scope.data.set(key, { ...dataSymbol(present.map((row) => row.values[key]!)), type });
                    }
                } else if (dataset) {
                    /**
                     * 冻结行决定矩阵中的可能值：缺失字段使绑定可缺失，显式空值保留为联合成员，声明类型仍约束取值。
                     * 按实际值收集列，避免为大量稀疏字段重复扫描整个行数组。
                     */
                    const columns = new Map<string, JsonValue[]>();
                    for (const row of dataset.source.rows)
                        for (const [key, value] of Object.entries(row.values)) {
                            const column = columns.get(key);
                            if (column) column.push(value);
                            else columns.set(key, [value]);
                        }
                    for (const [key, field] of Object.entries(dataset.fields)) {
                        const values = columns.get(key) ?? [];
                        scope.data.set(key, {
                            ...dataSymbol(values),
                            type: field.type,
                            optional: values.length !== dataset.source.rows.length,
                            ...(values.includes(null) ? { alternatives: [field.type, "null"] } : {}),
                        });
                    }
                }
                /**
                 * 夹具输入只能使用数据行和已声明的初始变量，先检查输入再引入输出属性；输出模式须能声明单一对象类型。
                 */
                if (d.fixtureVersionId) {
                    const f = ref(a.versionId, d.fixtureVersionId, "FIXTURE", p + "/fixtureVersionId");
                    if (f?.kind === "FIXTURE") {
                        binding(d.fixtureInput ?? {}, scope, p + "/fixtureInput");
                        try {
                            const values = rows?.map((row) => row.values) ?? [{}];
                            for (const data of values)
                                fixtureInput(
                                    d.fixtureInput ?? {},
                                    f.document.inputSchema,
                                    data,
                                    scope,
                                    p + "/fixtureInput",
                                );
                        } catch {
                            fail("FIXTURE_INPUT_INVALID", p + "/fixtureInput");
                        }
                        const declared = schemaSymbol(f.document.outputSchema);
                        if (!declared || declared.type !== "object" || declared.alternatives)
                            fail("FIXTURE_OUTPUT_DECLARATIONS_REQUIRED", p);
                        else
                            for (const [key, symbol] of declared.properties ?? []) {
                                if (scope.vars.has(key))
                                    fail(
                                        "DUPLICATE_VARIABLE",
                                        p + "/initialVariables/" + pointerKey(key),
                                        "Initial variable collides with fixture output: " + key,
                                    );
                                else scope.vars.set(key, symbol);
                            }
                    }
                }
                const expanded = steps(d.steps, a.versionId, scope, p + "/steps", [], { count: 0 }, d.kind === "WRITE");
                /**
                 * 持久化检查点按顶层定位，嵌套关键写入归入包装步骤排序；检查点不得早于最后写入，同位置须含最终查询。
                 * 有效证明要求非警告断言：导航或重载后的界面检查、GET 请求的响应字段，或契约限定的最终一致性查询。
                 */
                if (d.kind === "WRITE") {
                    const index = d.steps.findIndex((s) => s.id === d.persistenceCheckpointStepId);
                    const checkpoint = expanded[index];
                    const critical = (s: CompiledStep): boolean => !!s.step.critical || !!s.children?.some(critical);
                    const lastWrite = expanded.reduce((last, s, i) => (critical(s) ? i : last), -1);
                    const observed =
                        checkpoint &&
                        [...checkpoint.responseAssertions, ...checkpoint.after].some(
                            (x) =>
                                x.assertion.severity !== "WARN" &&
                                (x.assertion.type === "eventually" ||
                                    (["reload", "goto"].includes(checkpoint.step.action) &&
                                        x.assertion.type === "ui") ||
                                    (checkpoint.step.action === "apiRequest" &&
                                        checkpoint.step.method === "GET" &&
                                        x.assertion.type === "responseField")),
                        );
                    if (
                        index < 0 ||
                        index < lastWrite ||
                        (index === lastWrite &&
                            !(
                                checkpoint &&
                                [...checkpoint.responseAssertions, ...checkpoint.after].some(
                                    (x) => x.assertion.type === "eventually" && x.assertion.severity !== "WARN",
                                )
                            )) ||
                        !observed
                    )
                        fail("MISSING_PERSISTENCE_CHECKPOINT", p + "/persistenceCheckpointStepId");
                }
                const checkpoint = expanded.find((_, i) => d.steps[i]!.id === d.persistenceCheckpointStepId);
                compiled ??= {
                    caseVersionId: a.versionId,
                    document: d,
                    steps: expanded,
                    ...(checkpoint ? { persistenceCheckpointStepId: checkpoint.step.id } : {}),
                };
            }
            if (compiled) cases.push(compiled);
        } else if (a.kind === "DATASET") {
            for (const issue of validateDataset(a.document, p)) issues.push(issue);
        } else if (a.kind === "ELEMENT_CATALOG") {
            const entries = new Map(a.document.elements.map((e) => [e.key, e]));
            unique(
                a.document.elements.map((e) => e.key),
                p + "/elements",
            );
            for (const e of a.document.elements) {
                const seen = new Set<string>();
                let cursor: typeof e | undefined = e;
                while (cursor?.scope) {
                    if (seen.has(cursor.key)) {
                        fail("CATALOG_SCOPE_CYCLE", p);
                        break;
                    }
                    seen.add(cursor.key);
                    if (!entries.has(cursor.scope)) fail("UNKNOWN_ELEMENT", p, cursor.scope);
                    cursor = entries.get(cursor.scope);
                }
            }
        } else if (a.kind === "FLOW") {
            /**
             * 独立流程按声明参数建立数据符号，目录及非本地变量可来自调用方；具体用例展开时再用实际调用上下文校验。
             */
            const scope: Scope = {
                data: new Map(Object.entries(a.document.parameters ?? {}).map(([k, v]) => [k, sym(v)])),
                vars: new Map(),
                library: true,
                localDefinitions: localDefinitions(a.document.steps, new Set([a.versionId])),
            };
            steps(a.document.steps, a.versionId, scope, p + "/steps", [a.versionId], { count: 0 }, false);
        } else if (a.kind === "ASSERTION_TEMPLATE") {
            assertions(
                a.document.assertions,
                a.versionId,
                {
                    data: new Map(Object.entries(a.document.parameters ?? {}).map(([k, v]) => [k, sym(v)])),
                    vars: new Map(),
                    library: true,
                    externalObservers: true,
                },
                new Set(
                    a.document.assertions.flatMap((x) =>
                        "source" in x ? [x.source.slice(x.source.indexOf(":") + 1)] : [],
                    ),
                ),
                p + "/assertions",
                [a.versionId],
            );
        } else if (a.kind === "SUITE") {
            for (const [index, c] of a.document.cases.entries()) {
                ref(a.versionId, c.versionId, "CASE", p + "/cases");
                if (c.datasetVersionId) {
                    const dataset = ref(a.versionId, c.datasetVersionId, "DATASET", p + "/cases");
                    checkMatrixDataset(dataset, `${p}/cases/${index}/datasetVersionId`);
                }
            }
        } else if (a.kind === "ENVIRONMENT") {
            unique(
                a.document.roles.map((r) => r.roleKey),
                p + "/roles",
            );
            const allowed = new Set(a.document.allowedOrigins);
            for (const origin of allowed)
                if (new URL(origin).origin !== origin) fail("INVALID_ALLOWED_ORIGIN", p + "/allowedOrigins");
            for (const base of [a.document.baseURL, a.document.apiBaseURL, a.document.fixtureBaseURL].filter(
                (v): v is string => !!v,
            ))
                if (!allowed.has(new URL(base).origin)) fail("UNAUTHORIZED_ORIGIN", p);
            try {
                new Intl.DateTimeFormat(a.document.locale, {
                    timeZone: a.document.timezone,
                });
            } catch {
                fail("INVALID_LOCALE_TIMEZONE", p);
            }
        } else if (a.kind === "FIXTURE") {
            for (const [key, s] of [
                ["inputSchema", a.document.inputSchema],
                ["outputSchema", a.document.outputSchema],
            ] as const) {
                checkJsonSchema(s, p + "/" + key);
                if (!schemaSymbol(s)) fail("FIXTURE_SCHEMA_TYPE_REQUIRED", p + "/" + key);
            }
        }
    }
    /**
     * 身份配置库存必须精确对应环境声明的适配器版本，同时核对所属空间与配置摘要；这里不解析秘密或校验外部账户。
     */
    const expectedAdapters = new Set(
        snapshot.assets.flatMap((a) =>
            a.kind === "ENVIRONMENT"
                ? [...a.document.roles, ...(a.document.fixtureIdentity ? [a.document.fixtureIdentity] : [])].map(
                      (r) => r.authAdapterVersionId,
                  )
                : [],
        ),
    );
    const adapters = snapshot.authAdapters ?? [];
    unique(
        adapters.map((a) => a.versionId),
        "/authAdapters",
    );
    for (const adapter of adapters) {
        if (!expectedAdapters.has(adapter.versionId)) fail("UNRELATED_AUTH_ADAPTER", "/authAdapters");
        if (adapter.workspaceId !== snapshot.workspaceId) fail("AUTH_ADAPTER_WORKSPACE_MISMATCH", "/authAdapters");
        if (sha256(canonicalBytes(adapter.configuration)) !== adapter.contentHash)
            fail("AUTH_ADAPTER_HASH_MISMATCH", "/authAdapters");
    }
    for (const id of expectedAdapters)
        if (!adapters.some((a) => a.versionId === id)) fail("AUTH_ADAPTER_REQUIRED", "/authAdapters");
    /**
     * 从验证目标或所选用例入口遍历已登记引用，并纳入唯一推断的套件根；未被任何根到达的资产作为多余闭包内容报告。
     */
    const reachable = new Set<string>();
    const visit = (id: string) => {
        if (reachable.has(id)) return;
        reachable.add(id);
        for (const dep of edges.get(id) ?? []) visit(dep);
    };
    for (const id of snapshot.validationTarget ? [snapshot.validationTarget.versionId] : snapshot.entryCaseVersionIds)
        visit(id);
    if (!snapshot.validationTarget && suiteRoot) visit(suiteRoot.versionId);
    for (const a of snapshot.assets)
        if (!reachable.has(a.versionId)) fail("UNREACHABLE_ASSET", paths.get(a.versionId)!);
    return { issues, cases };
}
/**
 * 只需问题列表的调用方使用此入口，它直接返回完整分析中的问题；编译发射另取同次分析计划并拒绝任何非空问题。
 */
export function validate(snapshot: AssetSnapshotV1): ValidationIssue[] {
    return analyze(snapshot).issues;
}
