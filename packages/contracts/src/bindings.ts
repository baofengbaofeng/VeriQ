/**
 * 本文件实现 DSL 绑定与 JSON Pointer 解析：刻意区分缺失与 null：并校验初始变量声明类型（bindings）。
 */

import type {
    JsonValue,
    JsonObject,
    ParameterTypes,
    ValueType,
} from "./types.generated.js";
/**
 * 公开常量函数 pointerKey 按 RFC6901 转义键中的 ~ 与 /：供拼装 JSON Pointer 路径段。
 */
export const pointerKey = (key: string): string =>
    key.replaceAll("~", "~0").replaceAll("/", "~1");
/**
 * 公开函数 valueType 把运行时值映射为契约 ValueType：整数与普通 number 分开识别（valueType/INVALID_POINTER）。
 */
export function valueType(value: unknown): ValueType {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    if (typeof value === "number")
        return Number.isInteger(value) ? "integer" : "number";
    return typeof value as ValueType;
}
/**
 * 公开函数 accepts 判断期望类型是否接受实际类型：number 期望可接受 integer 实际值（accepts/INVALID_POINTER）。
 */
export function accepts(expected: ValueType, actual: ValueType): boolean {
    return expected === actual || (expected === "number" && actual === "integer");
}
/**
 * 公开类型 Presence 表示指针查找结果：present:false 与 present:true 且值为 null 必须区分。
 */
export type Presence =
    | {
            present: false;
        }
    | {
            present: true;
            value: JsonValue;
        };
/**
 * RFC6901 自有属性查找；缺失与 null 必须区分，禁止把二者当成同一语义。
 * 公开函数 resolvePointer 按 RFC6901 只读自有属性查找：非法指针抛错：缺失返回 present:false。
 */
export function resolvePointer(value: JsonValue, pointer: string): Presence {
    if (
        pointer !== "" &&
        (!pointer.startsWith("/") || /~(?![01])/u.test(pointer))
    )
        throw new Error("INVALID_POINTER");
    let current: JsonValue = value;
    for (const token of pointer === "" ? [] : pointer.slice(1).split("/")) {
        const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
        if (
            current === null ||
            typeof current !== "object" ||
            !Object.hasOwn(current, key) ||
            (Array.isArray(current) && !/^(0|[1-9][0-9]*)$/u.test(key))
        )
            return { present: false };
        current = (current as Record<string, JsonValue>)[key]!;
    }
    return { present: true, value: current };
}
/**
 * 公开函数 resolveBinding 展开 {{data|vars.x}} 绑定：拒绝不安全表达式：对象结果不得嵌入字符串插值。
 */
export function resolveBinding(
    value: JsonValue,
    context: {
        data: JsonValue;
        vars: JsonValue;
    },
): JsonValue {
    if (typeof value === "string") {
        const pattern =
            /\{\{(data|vars)\.([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\}\}/gu;
        const matches = [...value.matchAll(pattern)];
        if (
            value.replace(pattern, "").includes("{{") ||
            value.replace(pattern, "").includes("}}")
        )
            throw new Error("UNSAFE_EXPRESSION");
        const read = (m: RegExpMatchArray): JsonValue => {
            const found = resolvePointer(
                context[m[1] as "data" | "vars"],
                "/" + m[2]!.split(".").map(pointerKey).join("/"),
            );
            if (!found.present) throw new Error("MISSING_BINDING");
            return found.value;
        };
        if (matches.length === 1 && matches[0]![0] === value)
            return read(matches[0]!);
        return value.replace(pattern, (...args: unknown[]) => {
            const v = read(args as RegExpMatchArray);
            if (typeof v === "object") throw new Error("BINDING_TYPE_MISMATCH");
            return String(v);
        });
    }
    if (Array.isArray(value)) return value.map((v) => resolveBinding(v, context));
    if (value !== null && typeof value === "object")
        return Object.fromEntries(
            Object.entries(value).map(([k, v]) => [k, resolveBinding(v, context)]),
        );
    return value;
}

/**
 * 校验必需变量声明，并只暴露 prepare 之前的绑定作用域给后续步骤。
 * 公开函数 resolveInitialVariables 校验声明类型后只暴露预准备绑定作用域：缺键或类型不符即失败（resolveInitialVariables/INITIAL_VARIABLES_INVALID）。
 */
export function resolveInitialVariables(
    declarations: ParameterTypes | undefined,
    values: JsonObject,
): JsonObject {
    const entries = Object.entries(declarations ?? {});
    for (const [key, type] of entries)
        if (!Object.hasOwn(values, key) || !accepts(type, valueType(values[key])))
            throw new Error("INITIAL_VARIABLES_INVALID");
    return Object.fromEntries(entries.map(([key]) => [key, values[key]!]));
}
