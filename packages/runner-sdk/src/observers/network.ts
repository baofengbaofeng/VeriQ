import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Page, Request, Response, APIResponse } from "@playwright/test";
import type {
  JsonValue,
  NetworkObserverV1,
  ObserverResultPayloadV1,
} from "@veriq/contracts";

export interface Exchange {
  requestId: string;
  request: {
    method: string;
    path: string;
    query: Record<string, JsonValue>;
    body: JsonValue;
    headers: Record<string, string>;
  };
  response: {
    status: number;
    body: JsonValue;
    bodyKind: "json" | "text" | "empty";
    headers: Record<string, string>;
  };
  durationMs: number;
}
export interface ObserverHandle {
  waitFirst(): Promise<Exchange>;
  finalize(): Promise<ObserverResultPayloadV1>;
  dispose(): void;
  captureRequest?(
    url: string,
    data: Exchange["request"],
  ): ((response: Exchange["response"] | Error) => void) | undefined;
}
export class ObserverRegistry {
  private handles = new Set<
    Pick<ObserverHandle, "dispose" | "captureRequest">
  >();
  add(handle: Pick<ObserverHandle, "dispose" | "captureRequest">): void {
    this.handles.add(handle);
  }
  remove(handle: Pick<ObserverHandle, "dispose" | "captureRequest">): void {
    this.handles.delete(handle);
  }
  captureRequest(
    url: string,
    data: Exchange["request"],
  ): (response: Exchange["response"] | Error) => void {
    const callbacks = [...this.handles].map((h) =>
      h.captureRequest?.(url, data),
    );
    return (response) => {
      for (const cb of callbacks) cb?.(response);
    };
  }
  activeCount(): number {
    return this.handles.size;
  }
  dispose(): void {
    for (const h of this.handles) h.dispose();
  }
}
export interface NetworkContext {
  page: Page;
  apiBaseURL: string;
  allowedOrigins: string[];
  registry: ObserverRegistry;
  signal?: AbortSignal;
  deadline?: number;
}
export async function responseData(
  response: Response | APIResponse,
): Promise<Exchange["response"]> {
  const text = await response.text();
  let body: JsonValue = text,
    bodyKind: Exchange["response"]["bodyKind"] = text ? "text" : "empty";
  if (text) {
    try {
      body = JSON.parse(text) as JsonValue;
      bodyKind = "json";
    } catch {
      /* Non-JSON remains evidence, never a JSON null. */
    }
  }
  return {
    status: response.status(),
    body,
    bodyKind,
    headers: response.headers(),
  };
}
export function requestData(request: Request): Exchange["request"] {
  const url = new URL(request.url());
  let body: JsonValue = request.postData();
  if (body !== null) {
    try {
      body = JSON.parse(body) as JsonValue;
    } catch {
      /* Preserve non-JSON body. */
    }
  }
  return {
    method: request.method(),
    path: url.pathname,
    query: queryData(url),
    body,
    headers: request.headers(),
  };
}
export function queryData(url: URL): Record<string, JsonValue> {
  return Object.fromEntries(
    [...new Set(url.searchParams.keys())].map((k) => {
      const v = url.searchParams.getAll(k);
      return [k, v.length === 1 ? v[0]! : v];
    }),
  );
}
function subset(actual: JsonValue, expected: JsonValue): boolean {
  if (
    expected === null ||
    typeof expected !== "object" ||
    Array.isArray(expected)
  )
    return isDeepStrictEqual(actual, expected);
  return (
    actual !== null &&
    typeof actual === "object" &&
    !Array.isArray(actual) &&
    Object.entries(expected).every(
      ([k, v]) => Object.hasOwn(actual, k) && subset(actual[k]!, v),
    )
  );
}
/** Timers express the declared observation window, never retry a browser action. */
export function armObserver(
  spec: NetworkObserverV1,
  ctx: NetworkContext,
): ObserverHandle {
  const start = Date.now(),
    timeout = Math.min(
      start + (spec.timeoutMs ?? 15000),
      ctx.deadline ?? Infinity,
    );
  const fixedEnd =
    spec.window?.mode === "FIXED" ? start + spec.window.durationMs : undefined;
  const records: {
    request?: Request;
    data: Exchange["request"];
    at: number;
    completedAt?: number;
    response?: Exchange["response"];
    error?: Error;
    id: string;
  }[] = [];
  const pending = new Set<Promise<void>>();
  const watchers = new Set<() => void>();
  let disposed = false,
    last = start;
  const notify = () => {
    for (const f of watchers) f();
  };
  function captureRequest(address: string, data: Exchange["request"]) {
    const url = new URL(address);
    if (disposed || (fixedEnd !== undefined && Date.now() > fixedEnd)) return;
    if (
      url.origin !== new URL(ctx.apiBaseURL).origin ||
      !ctx.allowedOrigins.includes(url.origin) ||
      data.method !== spec.method ||
      url.pathname !== spec.path
    )
      return;
    if (
      (spec.queryMatch && !subset(data.query, spec.queryMatch)) ||
      (spec.bodyMatch && !subset(data.body, spec.bodyMatch))
    )
      return;
    const record: (typeof records)[number] = {
      data,
      at: Date.now(),
      id: randomUUID(),
    };
    records.push(record);
    last = Date.now();
    notify();
    return record;
  }
  const onRequest = (request: Request) => {
    const r = captureRequest(request.url(), requestData(request));
    if (r) r.request = request;
  };
  const onResponse = (response: Response) => {
    const record = records.find((r) => r.request === response.request());
    if (!record) return;
    const work = responseData(response)
      .then(
        (data) => {
          record.response = data;
          record.completedAt = Date.now();
        },
        (e) => {
          record.error = e instanceof Error ? e : new Error(String(e));
        },
      )
      .finally(() => {
        pending.delete(work);
        notify();
      });
    pending.add(work);
  };
  const onFailed = (request: Request) => {
    const r = records.find((r) => r.request === request);
    if (r) {
      r.error = new Error("NETWORK_REQUEST_FAILED");
      notify();
    }
  };
  function check(): void {
    if (ctx.signal?.aborted) throw new Error("CANCELLED");
    if (disposed) throw new Error("OBSERVER_DISPOSED");
  }
  function changed(until: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        watchers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, until - Date.now()));
      watchers.add(done);
    });
  }
  const handle: ObserverHandle = {
    captureRequest(url, data) {
      const r = captureRequest(url, data);
      if (!r) return;
      return (response) => {
        if (response instanceof Error) r.error = response;
        else {
          r.response = response;
          r.completedAt = Date.now();
        }
        notify();
      };
    },
    async waitFirst() {
      while (true) {
        check();
        const r = records[0];
        if (r?.error) throw r.error;
        if (r?.response)
          return {
            requestId: r.id,
            request: r.data,
            response: r.response,
            durationMs: r.completedAt! - r.at,
          };
        if (Date.now() >= timeout) throw new Error("NETWORK_TIMEOUT");
        await changed(timeout);
      }
    },
    async finalize() {
      const settled = Date.now();
      while (true) {
        check();
        const end =
          fixedEnd ??
          Math.max(settled, last) +
            (spec.window?.mode === "UNTIL_ACTION_SETTLED"
              ? (spec.window.quietMs ?? 500)
              : 500);
        if (Date.now() >= end) break;
        if (Date.now() >= timeout) throw new Error("NETWORK_TIMEOUT");
        await changed(Math.min(end, timeout));
      }
      check();
      const first = records[0];
      const ambiguous =
        records.length > 1 &&
        (spec.retryPolicy !== "ALLOW_MATCHING_RETRIES" ||
          records.some((r) => !isDeepStrictEqual(r.data, first!.data)));
      if (ambiguous) throw new Error("AMBIGUOUS_REQUEST");
      if (
        spec.expectedCount !== undefined &&
        records.length !== spec.expectedCount
      )
        throw new Error("REQUEST_COUNT_MISMATCH");
      return {
        observerId: spec.id,
        matchedCount: records.length,
        windowMode: spec.window?.mode ?? "UNTIL_ACTION_SETTLED",
        durationMs: Date.now() - start,
        ambiguous,
        requests: records.map((r) => ({
          requestId: r.id,
          method: spec.method,
          path: r.data.path,
          ...(r.response ? { status: r.response.status } : {}),
        })),
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      ctx.page.off("request", onRequest);
      ctx.page.off("response", onResponse);
      ctx.page.off("requestfailed", onFailed);
      ctx.signal?.removeEventListener("abort", notify);
      ctx.registry.remove(handle);
      notify();
    },
  };
  ctx.page.on("request", onRequest);
  ctx.page.on("response", onResponse);
  ctx.page.on("requestfailed", onFailed);
  ctx.signal?.addEventListener("abort", notify);
  ctx.registry.add(handle);
  return handle;
}
