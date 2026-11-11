import type { JsonValue, ValueType } from "./types.generated.js";
export const pointerKey = (key: string): string =>
  key.replaceAll("~", "~0").replaceAll("/", "~1");
export function valueType(value: unknown): ValueType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number")
    return Number.isInteger(value) ? "integer" : "number";
  return typeof value as ValueType;
}
export function accepts(expected: ValueType, actual: ValueType): boolean {
  return expected === actual || (expected === "number" && actual === "integer");
}
export type Presence =
  | {
      present: false;
    }
  | {
      present: true;
      value: JsonValue;
    };
/** RFC6901 own-property lookup. Missing and null are deliberately different. */
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
