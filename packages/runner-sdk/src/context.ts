import type { Page, Locator } from "@playwright/test";
import {
  resolveBinding,
  type JsonObject,
  type JsonValue,
  type ElementCatalogV1,
  type EnvironmentV1,
  type CompiledAssertion,
  type AssertionResultPayloadV1,
  type StepFinishedPayloadV1,
  type ObserverResultPayloadV1,
} from "@veriq/contracts";
import {
  ObserverRegistry,
  type Exchange,
  type ObserverHandle,
} from "./observers/network.js";
export interface AssertionResult extends AssertionResultPayloadV1 {
  id: string;
  sourcePath: string;
}
export interface StepResult extends StepFinishedPayloadV1 {
  id: string;
  sourcePath: string;
  assertions: AssertionResult[];
  observers: ObserverResultPayloadV1[];
  children: StepResult[];
  events: import("./observers/events.js").EventEvidence[];
  cancelled?: boolean;
}
export type LiveStepEvent =
  | {type: "STEP_STARTED"; stepId: string}
  | {type: "STEP_FINISHED"; stepId: string; result: StepFinishedPayloadV1}
  | {type: "ASSERTION_RESULT"; stepId: string; assertionId: string; result: AssertionResultPayloadV1}
  | {type: "OBSERVER_RESULT"; stepId: string; result: ObserverResultPayloadV1};
export interface StepContextOptions {
  onBusinessRequest?: (method: string) => void;
  onEvent?: (event: LiveStepEvent) => Promise<void>;
  page: Page;
  environment: EnvironmentV1;
  catalog: ElementCatalogV1;
  data?: JsonObject;
  vars?: JsonObject;
  signal?: AbortSignal;
  deadline?: number;
  downloads?: { directory: string; maxBytes: number };
  files?: (
    paths: string[],
  ) => Promise<{ name: string; mimeType: string; buffer: Buffer }[]>;
}
export interface StepContext extends StepContextOptions {
  originalPage: Page;
  dialogObservers: Map<Page, number>;
  data: JsonObject;
  vars: JsonObject;
  registry: ObserverRegistry;
  sources: Map<string, Exchange | ObserverHandle>;
  pages: Map<string, Promise<Page>>;
  dispose(): void;
}
export type ResolvedStep = import("@veriq/contracts").CompiledStep;
export function createStepContext(options: StepContextOptions): StepContext {
  const registry = new ObserverRegistry();
  const abort = () => {
    registry.dispose();
    void options.page
      .context()
      .close()
      .catch(() => {});
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  return {
    ...options,
    originalPage: options.page,
    dialogObservers: new Map(),
    data: structuredClone(options.data ?? {}),
    vars: structuredClone(options.vars ?? {}),
    registry,
    sources: new Map(),
    pages: new Map(),
    dispose() {
      options.signal?.removeEventListener("abort", abort);
      registry.dispose();
    },
  };
}
/** A typed interruption, selected only when abort wins over operation settlement. */
export class ExecutionCancelled extends Error {
  constructor() { super("CANCELLED"); }
}
export function interruptible<T>(ctx: Pick<StepContext, "signal">, operation: () => Promise<T>): Promise<T> {
  if (ctx.signal?.aborted) return Promise.reject(new ExecutionCancelled());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (value: T | undefined, error?: unknown) => {
      if (settled) return;
      settled = true;
      ctx.signal?.removeEventListener("abort", abort);
      if (error !== undefined) reject(error); else resolve(value as T);
    };
    const abort = () => finish(undefined, new ExecutionCancelled());
    ctx.signal?.addEventListener("abort", abort, {once:true});
    try { operation().then(value => finish(value), error => finish(undefined, error)); }
    catch (error) { finish(undefined, error); }
  });
}
export function budget(ctx: StepContext, requested: number): number {
  if (ctx.signal?.aborted) throw new ExecutionCancelled();
  const n = Math.min(requested, (ctx.deadline ?? Infinity) - Date.now());
  if (n <= 0) throw new Error("BUSINESS_TIMEOUT");
  return n;
}
export function binding(value: JsonValue, ctx: StepContext): JsonValue {
  return resolveBinding(value, { data: ctx.data, vars: ctx.vars });
}
export function stringBinding(value: JsonValue, ctx: StepContext): string {
  const v = binding(value, ctx);
  if (typeof v !== "string") throw new Error("BINDING_TYPE_MISMATCH");
  return v;
}
export function assertionScope(
  item: CompiledAssertion,
  ctx: StepContext,
): StepContext {
  let result = ctx;
  for (const frame of item.parameters)
    result = {
      ...result,
      data: { ...result.data, ...(binding(frame, result) as JsonObject) },
    };
  return result;
}
export function locator(
  key: string,
  ctx: StepContext,
  seen = new Set<string>(),
): Locator {
  if (seen.has(key)) throw new Error("CATALOG_SCOPE_CYCLE");
  seen.add(key);
  const e = ctx.catalog.elements.find((x) => x.key === key);
  if (!e) throw new Error("TARGET_NOT_FOUND");
  const root = e.scope ? locator(e.scope, ctx, seen) : ctx.page;
  let result =
    e.locator.by === "testId"
      ? root.getByTestId(e.locator.value)
      : root.getByRole(e.locator.role as Parameters<Page["getByRole"]>[0], {
          ...(e.locator.name === undefined
            ? {}
            : { name: stringBinding(e.locator.name, ctx) }),
          ...(e.locator.exact === undefined ? {} : { exact: e.locator.exact }),
        });
  if (e.recordKey !== undefined)
    result = result.and(
      ctx.page.locator(
        `[data-record-key=${JSON.stringify(stringBinding(e.recordKey, ctx))}]`,
      ),
    );
  return result;
}
export async function exchange(
  source: string,
  ctx: StepContext,
): Promise<Exchange> {
  const value = ctx.sources.get(source.slice(source.indexOf(":") + 1));
  if (!value) throw new Error("SOURCE_UNAVAILABLE");
  return "waitFirst" in value ? value.waitFirst() : value;
}
