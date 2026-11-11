import { isDeepStrictEqual } from "node:util";
import { expect } from "@playwright/test";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  resolvePointer,
  type CompiledAssertion,
  type JsonValue,
  type Presence,
  type JsonObject,
} from "@veriq/contracts";
import {
  assertionScope,
  interruptible,
  ExecutionCancelled,
  binding,
  budget,
  exchange,
  type StepContext,
  type AssertionResult,
} from "../context.js";
import { assertUI, uiActual } from "./ui.js";
import { apiRequest } from "../http.js";
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats.default(ajv);
export function fieldMatches(
  actual: Presence,
  operator: string,
  expected: JsonValue,
): boolean {
  if (operator === "exists") return actual.present === expected;
  if (!actual.present) return false;
  const value = actual.value;
  switch (operator) {
    case "equals":
      return isDeepStrictEqual(value, expected);
    case "notEquals":
      return !isDeepStrictEqual(value, expected);
    case "in":
      return (
        Array.isArray(expected) &&
        expected.some((x) => isDeepStrictEqual(x, value))
      );
    case "contains":
      return typeof value === "string" && typeof expected === "string"
        ? value.includes(expected)
        : Array.isArray(value) &&
            Array.isArray(expected) &&
            expected.every((e) => value.some((v) => isDeepStrictEqual(e, v)));
    default:
      return false;
  }
}
export async function runAssertion(
  item: CompiledAssertion,
  outer: StepContext,
  counts?: Map<string, number>,
): Promise<AssertionResult> {
  const start = Date.now(),
    a = item.assertion;
  let actual: Presence = { present: false },
    expected: JsonValue = a.expected,
    ctx = outer;
  let errorCode: string | undefined;
  try {
    budget(ctx, 1);
    ctx = { ...assertionScope(item, outer), page: outer.originalPage };
    if ("pageKey" in a && a.pageKey) {
      const page = ctx.pages.get(a.pageKey);
      if (!page) throw new Error("UNKNOWN_PAGE_KEY");
      ctx = { ...ctx, page: await interruptible(ctx, () => page) };
    }
    expected =
      a.type === "responseSchema" ? a.expected : binding(a.expected, ctx);
    let pass = false;
    if (a.type === "ui" || a.type === "url") {
      actual = await interruptible(ctx, () => assertUI(a, expected, ctx));
      pass = true;
    } else if (a.type === "eventually") {
      const timeout = budget(ctx, a.timeoutMs ?? 10000),
        deadline = Date.now() + timeout;
      const path = binding(a.query.path, ctx);
      if (typeof path !== "string" || a.query.method !== "GET")
        throw new Error("READ_ONLY_QUERY_REQUIRED");
      await interruptible(ctx, () => expect
        .poll(
          async () => {
            const x = await apiRequest(
              {
                ...ctx,
                deadline: Math.min(ctx.deadline ?? Infinity, deadline),
              },
              "GET",
              path,
              binding(a.query.query ?? {}, ctx) as JsonObject,
              undefined,
              undefined,
              timeout,
            );
            actual =
              x.response.bodyKind === "json"
                ? resolvePointer(x.response.body, a.pointer)
                : { present: false };
            return fieldMatches(actual, a.operator, expected);
          },
          { timeout, intervals: [a.intervalMs ?? 500] },
        )
        .toBe(true));
      pass = true;
    } else if (a.type === "requestCount") {
      const count = counts?.get(a.source.slice(8));
      if (count === undefined) throw new Error("OBSERVER_WINDOW_REQUIRED");
      actual = { present: true, value: count };
      pass = count === expected;
    } else {
      const x = await interruptible(ctx, () => exchange(a.source, ctx));
      switch (a.type) {
        case "httpStatus":
          actual = { present: true, value: x.response.status };
          pass = isDeepStrictEqual(x.response.status, expected);
          break;
        case "duration":
          actual = { present: true, value: x.durationMs };
          pass = x.durationMs <= Number(expected);
          break;
        case "request":
          actual = {
            present: true,
            value:
              a.operator === "methodEquals" ? x.request.method : x.request.path,
          };
          pass = isDeepStrictEqual(actual.value, expected);
          break;
        case "requestField":
          actual = resolvePointer(x.request as unknown as JsonValue, a.pointer);
          pass = fieldMatches(actual, a.operator, expected);
          break;
        case "responseField":
          actual =
            x.response.bodyKind === "json"
              ? resolvePointer(x.response.body, a.pointer)
              : { present: false };
          pass = fieldMatches(actual, a.operator, expected);
          break;
        case "responseSchema":
          actual = { present: true, value: x.response.body };
          pass =
            x.response.bodyKind === "json" &&
            ajv.compile(a.expected)(x.response.body) === true;
          break;
      }
    }
    if (!pass) errorCode = "ASSERTION_FAILED";
  } catch (e) {
    if (e instanceof ExecutionCancelled) throw e;
    errorCode = e instanceof Error && /^[A-Z_]+$/.test(e.message)
        ? e.message
        : "ASSERTION_FAILED";
    if (a.type === "ui" || a.type === "url") {
      try {
        actual = await uiActual(a, ctx);
      } catch {
        /* Preserve missing evidence when the page is unavailable. */
      }
    }
  }
  return {
    id: a.id,
    sourcePath: item.sourcePath,
    status: errorCode ? (a.severity === "WARN" ? "WARN" : "FAILED") : "PASSED",
    severity: a.severity,
    expectedSource: a.expectedSource,
    expected,
    actual,
    durationMs: Date.now() - start,
    ...(errorCode ? { errorCode } : {}),
  };
}
