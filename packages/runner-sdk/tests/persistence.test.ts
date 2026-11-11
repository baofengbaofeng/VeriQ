import { beforeAll, afterAll, expect, it } from "vitest";
import * as sdk from "../src/index.js";
import { fixture, a, step } from "./helpers.js";
let f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
  f = await fixture();
});
afterAll(async () => {
  await f.close();
});
it("runs response assertions before checked extraction and dependent assertions afterwards", async () => {
  expect(sdk).toHaveProperty("executeStep");
  const ctx = sdk.createStepContext(f.options);
  const result = await sdk.executeStep(
    step(
      {
        id: "save",
        action: "apiRequest",
        method: "POST",
        path: "/save",
        body: { code: "{{data.name}}" },
        extract: [
          {
            source: "response:action",
            pointer: "/id",
            to: "id",
            valueType: "string",
            required: true,
          },
        ],
      },
      [
        a({
          type: "httpStatus",
          source: "response:action",
          operator: "equals",
          expected: 200,
        }),
        a({
          type: "responseField",
          source: "response:action",
          pointer: "/code",
          operator: "equals",
          expected: 0,
        }),
      ],
      [
        a({
          type: "responseField",
          source: "response:action",
          pointer: "/id",
          operator: "equals",
          expected: "{{vars.id}}",
        }),
      ],
    ),
    ctx,
  );
  expect(result.status).toBe("PASSED");
  expect(ctx.vars.id).toBe("saved-1");
  expect(JSON.parse(f.requests.at(-1)!.body)).toEqual({ code: "attempt-1" });
});
it("HTTP 200 with missing persistence is FAILED and eventual queries remain GET only", async () => {
  expect(sdk).toHaveProperty("executeStep");
  const ctx = sdk.createStepContext(f.options);
  const result = await sdk.executeStep(
    step(
      { id: "persist", action: "apiRequest", method: "POST", path: "/save" },
      [],
      [
        a({
          type: "eventually",
          query: { method: "GET", path: "/missing" },
          pointer: "/exists",
          operator: "equals",
          expected: true,
          timeoutMs: 150,
          intervalMs: 20,
        }),
      ],
    ),
    ctx,
  );
  expect(result.status).toBe("FAILED");
  expect(result.assertions[0]?.actual).toEqual({ present: true, value: false });
  expect(
    f.requests
      .filter((x) => x.path === "/missing")
      .every((x) => x.method === "GET"),
  ).toBe(true);
});
it("eventual consistency succeeds after read-only observations", async () => {
  expect(sdk).toHaveProperty("executeStep");
  const result = await sdk.executeStep(
    step(
      { id: "read", action: "apiRequest", method: "GET", path: "/save" },
      [],
      [
        a({
          type: "eventually",
          query: { method: "GET", path: "/eventual" },
          pointer: "/exists",
          operator: "equals",
          expected: true,
          timeoutMs: 1000,
          intervalMs: 20,
        }),
      ],
    ),
    sdk.createStepContext(f.options),
  );
  expect(result.status).toBe("PASSED");
  expect(f.requests.filter((x) => x.path === "/eventual")).toHaveLength(3);
});
it.each([
  { pointer: "/missing", valueType: "string", error: "EXTRACTION_MISSING" },
  { pointer: "/nil", valueType: "string", error: "EXTRACTION_TYPE_MISMATCH" },
])(
  "rejects invalid extraction $pointer/$valueType",
  async ({ pointer, valueType, error }) => {
    expect(sdk).toHaveProperty("executeStep");
    const ctx = sdk.createStepContext(f.options);
    const r = await sdk.executeStep(
      step({
        id: "read",
        action: "apiRequest",
        method: "GET",
        path: "/save",
        extract: [
          {
            source: "response:action",
            pointer,
            to: "id",
            valueType: valueType as "string",
            required: true,
          },
        ],
      }),
      ctx,
    );
    expect(r.errorCode).toBe(error);
    expect(ctx.vars).not.toHaveProperty("id");
  },
);
it("does not extract when a response contract fails", async () => {
  expect(sdk).toHaveProperty("executeStep");
  const ctx = sdk.createStepContext(f.options);
  const r = await sdk.executeStep(
    step(
      {
        id: "read",
        action: "apiRequest",
        method: "GET",
        path: "/save",
        extract: [
          {
            source: "response:action",
            pointer: "/id",
            to: "id",
            valueType: "string",
            required: true,
          },
        ],
      },
      [
        a({
          type: "responseField",
          source: "response:action",
          pointer: "/code",
          operator: "equals",
          expected: 99,
          severity: "CONTINUE_FAIL",
        }),
      ],
    ),
    ctx,
  );
  expect(r.status).toBe("FAILED");
  expect(ctx.vars).not.toHaveProperty("id");
});
it("cleans observers on click failure without unhandled pending waits", async () => {
  expect(sdk).toHaveProperty("executeStep");
  const ctx = sdk.createStepContext(f.options);
  const r = await sdk.executeStep(
    step({
      id: "click",
      action: "click",
      target: "disabled",
      timeoutMs: 100,
      observers: [{ id: "save", method: "POST", path: "/save" }],
    }),
    ctx,
  );
  expect(r.status).toBe("FAILED");
  expect(ctx.registry.activeCount()).toBe(0);
});
it("zero-count windows cannot manufacture a response for assertions", async () => {
  const ctx = sdk.createStepContext(f.options);
  const r = await sdk.executeStep(
    step(
      {
        id: "none",
        action: "fill",
        target: "name",
        value: "",
        observers: [
          {
            id: "none",
            method: "GET",
            path: "/never",
            expectedCount: 0,
            timeoutMs: 100,
            window: { mode: "FIXED", durationMs: 20 },
          },
        ],
      },
      [
        a({
          type: "httpStatus",
          source: "response:none",
          operator: "equals",
          expected: 200,
        }),
      ],
    ),
    ctx,
  );
  expect(r.status).toBe("FAILED");
  expect(r.assertions[0]?.errorCode).toBe("NETWORK_TIMEOUT");
  expect(ctx.registry.activeCount()).toBe(0);
  ctx.dispose();
});
