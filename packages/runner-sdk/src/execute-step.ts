import { armEvent, type EventHandle } from "./observers/events.js";
import type { Dialog } from "@playwright/test";
import { expect } from "@playwright/test";
import {
  accepts,
  resolvePointer,
  valueType,
  type JsonObject,
  type JsonValue,
  type CompiledAssertion,
} from "@veriq/contracts";
import { armObserver, type ObserverHandle } from "./observers/network.js";
import {
  binding,
  interruptible,
  ExecutionCancelled,
  budget,
  exchange,
  locator,
  stringBinding,
  type ResolvedStep,
  type StepContext,
  type StepResult,
} from "./context.js";
import { apiRequest, authorizedURL } from "./http.js";
import { runAssertion } from "./assertions/http.js";
export async function executeStep(
  plan: ResolvedStep,
  outer: StepContext,
): Promise<StepResult> {
  let ctx = {
      ...outer,
      page: outer.originalPage,
      sources: new Map(outer.sources),
    },
    s = plan.step,
    start = Date.now(),
    handles: ObserverHandle[] = [];
  const eventHandles: EventHandle[] = [];
  let unexpected = false;
  const dismiss = (d: Dialog) => {
    unexpected = true;
    void d.dismiss().catch(() => {});
  };
  const result: StepResult = {
    id: s.id,
    sourcePath: plan.sourcePath,
    status: "PASSED",
    durationMs: 0,
    assertions: [],
    observers: [],
    children: [],
    events: [],
  };
  const deferred: CompiledAssertion[] = [];
  let blocker: string | undefined;
  await ctx.onEvent?.({type: "STEP_STARTED", stepId: s.id});
  async function assertions(
    items: CompiledAssertion[],
    counts?: Map<string, number>,
  ): Promise<void> {
    for (const item of items) {
      if (item.assertion.type === "requestCount" && !counts) {
        deferred.push(item);
        continue;
      }
      const r = await runAssertion(item, ctx, counts);
      result.assertions.push(r);
      const {id, sourcePath: _, ...payload} = r;
      await ctx.onEvent?.({type: "ASSERTION_RESULT", stepId: s.id, assertionId: id, result: payload});
      if (r.status === "FAILED") {
        result.status = "FAILED";
        if (r.severity === "BLOCK") {
          blocker = r.id;
          throw new Error(r.errorCode ?? "ASSERTION_FAILED");
        }
      }
    }
  }
  try {
    budget(ctx, 1);
    if (s.pageKey) {
      const page = ctx.pages.get(s.pageKey);
      if (!page) throw new Error("UNKNOWN_PAGE_KEY");
      ctx = { ...ctx, page: await interruptible(ctx, () => page) };
    }
    await assertions(plan.before);
    if (
      s.action !== "callFlow" &&
      !ctx.dialogObservers.has(ctx.page) &&
      !(s.observers ?? []).some((o) => "kind" in o && o.kind === "dialog")
    )
      ctx.page.on("dialog", dismiss);
    const target = "target" in s ? locator(s.target, ctx) : undefined;
    const timeout = budget(ctx, s.timeoutMs ?? 10000);
    if (target) await interruptible(ctx, () => expect(target).toHaveCount(1, { timeout }));
    for (const observer of s.observers ?? []) {
      if ("kind" in observer && typeof observer.kind === "string") {
        eventHandles.push(
          armEvent(
            observer as
              | import("@veriq/contracts").DialogObserverV1
              | import("@veriq/contracts").NewPageObserverV1
              | import("@veriq/contracts").DownloadObserverV1,
            ctx,
          ),
        );
        continue;
      }
      if (!("method" in observer)) throw new Error("INVALID_OBSERVER");
      const network = observer as import("@veriq/contracts").NetworkObserverV1;
      const spec = {
        ...network,
        path: stringBinding(network.path, ctx),
        ...(network.queryMatch
          ? { queryMatch: binding(network.queryMatch, ctx) as JsonObject }
          : {}),
        ...(network.bodyMatch
          ? { bodyMatch: binding(network.bodyMatch, ctx) as JsonObject }
          : {}),
      };
      authorizedURL(
        spec.path,
        ctx.environment.apiBaseURL,
        ctx.environment.allowedOrigins,
      );
      const h = armObserver(spec, {
        page: ctx.page,
        apiBaseURL: ctx.environment.apiBaseURL,
        allowedOrigins: ctx.environment.allowedOrigins,
        registry: ctx.registry,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...(ctx.deadline ? { deadline: ctx.deadline } : {}),
      });
      handles.push(h);
      ctx.sources.set(spec.id, h);
    }
    switch (s.action) {
      case "goto":
        await interruptible(ctx, () => ctx.page.goto(
          authorizedURL(
            stringBinding(s.path, ctx),
            ctx.environment.baseURL,
            ctx.environment.allowedOrigins,
          ).href,
          { timeout },
        ));
        break;
      case "reload":
        await interruptible(ctx, () => ctx.page.reload({ timeout }));
        break;
      case "click":
        await interruptible(ctx, () => target!.click({ timeout }));
        break;
      case "fill":
        await interruptible(ctx, () => target!.fill(stringBinding(s.value, ctx), { timeout }));
        break;
      case "press":
        await interruptible(ctx, () => target!.press(stringBinding(s.value, ctx), { timeout }));
        break;
      case "check":
        await interruptible(ctx, () => target!.check({ timeout }));
        break;
      case "uncheck":
        await interruptible(ctx, () => target!.uncheck({ timeout }));
        break;
      case "selectOption": {
        const value = binding(s.value, ctx);
        if (
          typeof value !== "string" &&
          (!Array.isArray(value) || value.some((x) => typeof x !== "string"))
        )
          throw new Error("BINDING_TYPE_MISMATCH");
        await interruptible(ctx, () => target!.selectOption(value as string | string[], { timeout }));
        break;
      }
      case "upload":
        if (!ctx.files) throw new Error("FILE_PROVIDER_REQUIRED");
        await interruptible(ctx, async () => target!.setInputFiles(await ctx.files!(s.value), { timeout }));
        break;
      case "apiRequest": {
        const headers = Object.fromEntries(
          Object.entries(s.headers ?? {}).map(([k, v]) => [
            k,
            stringBinding(v, ctx),
          ]),
        );
        await interruptible(ctx, () => apiRequest(
          ctx,
          s.method,
          stringBinding(s.path, ctx),
          binding(s.query ?? {}, ctx) as JsonObject,
          s.body === undefined ? undefined : binding(s.body, ctx),
          headers,
          timeout,
        ));
        break;
      }
      case "callFlow": {
        if (!plan.children) throw new Error("COMPILED_CHILDREN_REQUIRED");
        const childCtx = {
          ...ctx,
          pages: new Map(ctx.pages),
          data: {
            ...ctx.data,
            ...(binding(s.parameters ?? {}, ctx) as JsonObject),
          },
        };
        for (const child of plan.children) {
          const r = await executeStep(child, childCtx);
          result.children.push(r);
          if (r.cancelled) {
            if (r.status === "FAILED") result.status = "FAILED";
            throw new ExecutionCancelled();
          }
          if (r.status !== "PASSED") {
            result.status = r.status;
            if (child.step.failurePolicy !== "CONTINUE") {
              for (const remaining of plan.children.slice(plan.children.indexOf(child) + 1)) await skipStep(remaining, ctx, child.step.id);
              throw new Error("CHILD_STEP_FAILED");
            }
          }
        }
        break;
      }
    }
    if (unexpected) throw new Error("UNEXPECTED_DIALOG");
    for (const handle of eventHandles) {
      const event = await interruptible(ctx, () => handle.finalize());
      result.events.push(event);
      await ctx.onEvent?.({type: "OBSERVER_RESULT", stepId: s.id, result: {observerId: event.observerId, matchedCount: 1, windowMode: "UNTIL_ACTION_SETTLED", durationMs: Date.now() - start, ambiguous: false, requests: []}});
    }
    await assertions(plan.responseAssertions);
    if (result.assertions.some((a) => a.status === "FAILED"))
      throw new Error("RESPONSE_ASSERTION_FAILED");
    const extracted: JsonObject = {};
    for (const extraction of s.extract ?? []) {
      const x = await interruptible(ctx, () => exchange(extraction.source, ctx));
      const found = extraction.source.startsWith("request:")
        ? resolvePointer(x.request as unknown as JsonValue, extraction.pointer)
        : x.response.bodyKind === "json"
          ? resolvePointer(x.response.body, extraction.pointer)
          : { present: false as const };
      if (!found.present) {
        if (extraction.required) throw new Error("EXTRACTION_MISSING");
        delete ctx.vars[extraction.to];
        continue;
      }
      if (!accepts(extraction.valueType, valueType(found.value)))
        throw new Error("EXTRACTION_TYPE_MISMATCH");
      extracted[extraction.to] = found.value;
    }
    Object.assign(ctx.vars, extracted);
    await assertions(plan.after);
    for (const handle of handles) {
      const observed = await interruptible(ctx, () => handle.finalize());
      result.observers.push(observed);
      await ctx.onEvent?.({type: "OBSERVER_RESULT", stepId: s.id, result: observed});
    }
    await assertions(
      deferred,
      new Map(result.observers.map((o) => [o.observerId, o.matchedCount])),
    );
    for (const handle of eventHandles) await interruptible(ctx, () => handle.finalize());
    if (unexpected) throw new Error("UNEXPECTED_DIALOG");
  } catch (e) {
    const cancelled = e instanceof ExecutionCancelled;
    const failed = result.status === "FAILED" || result.assertions.some(a => a.status === "FAILED") || result.children.some(child => ["FAILED", "ERROR"].includes(child.status));
    result.status = cancelled && !failed ? "CANCELLED" : "FAILED";
    result.errorCode = cancelled && !failed
      ? "CANCELLED"
      : e instanceof Error && /^[A-Z][A-Z_]+$/.test(e.message)
        ? e.message
        : "ACTION_FAILED";
    if (cancelled) result.cancelled = true;
    if (blocker) {
      result.blockedByStepId = s.id;
      result.blockedByAssertionId = blocker;
      const all = [...plan.before, ...plan.responseAssertions, ...plan.after];
      // requestCount is executed only after observer finalization.
      const ordered = [...all.filter(a => a.assertion.type !== "requestCount"), ...all.filter(a => a.assertion.type === "requestCount")];
      const blockedIndex = ordered.findIndex(a => a.assertion.id === blocker);
      for (const item of ordered.slice(blockedIndex + 1)) {
        if (result.assertions.some(a => a.id === item.assertion.id)) continue;
        const skipped = {id: item.assertion.id, sourcePath: item.sourcePath, status: "SKIPPED" as const, severity: item.assertion.severity,
          expectedSource: item.assertion.expectedSource, expected: null, actual: {present: false as const}, durationMs: 0,
          blockedByStepId: s.id, blockedByAssertionId: blocker};
        result.assertions.push(skipped);
        const {id, sourcePath: _, ...payload} = skipped;
        await ctx.onEvent?.({type: "ASSERTION_RESULT", stepId: s.id, assertionId: id, result: payload});
      }
      if (plan.before.some(a => a.assertion.id === blocker))
        for (const child of plan.children ?? []) await skipStep(child, ctx, s.id, blocker);
    }
  } finally {
    ctx.page.off("dialog", dismiss);
    await Promise.all(eventHandles.map((h) => h.dispose()));
    for (const h of handles) h.dispose();
    result.durationMs = Date.now() - start;
  }
  const {id, sourcePath: _, assertions: _a, observers: _o, children: _c, events: _e, cancelled: _x, ...payload} = result;
  await ctx.onEvent?.({type: "STEP_FINISHED", stepId: id, result: payload});
  return result;
}

/** Called only at an actual STOP/BLOCK branch for work that has not started. */
export async function skipStep(plan: ResolvedStep, ctx: Pick<StepContext, "onEvent">, blockedByStepId: string, blockedByAssertionId?: string): Promise<void> {
  await ctx.onEvent?.({type: "STEP_FINISHED", stepId: plan.step.id, result: {status: "SKIPPED", durationMs: 0, blockedByStepId, ...(blockedByAssertionId ? {blockedByAssertionId} : {})}});
  for (const child of plan.children ?? []) await skipStep(child, ctx, blockedByStepId, blockedByAssertionId);
}
