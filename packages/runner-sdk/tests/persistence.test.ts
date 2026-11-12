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
it.each([
    {
        name: "scalars",
        query: { enabled: "{{data.enabled}}", n: "{{data.n}}", nil: null },
        wire: { enabled: "true", n: "42", nil: "null" },
    },
    {
        name: "arrays",
        query: { tag: "{{data.tags}}", single: [7], empty: [] },
        wire: { tag: ["true", "42", "null", "x"], single: "7" },
    },
    {
        name: "objects",
        query: {
            filter: "{{data.filter}}",
            nested: [{ z: 2, a: true }, [1, null]],
        },
        wire: {
            filter: '{"a":true,"z":2}',
            nested: ['{"a":true,"z":2}', "[1,null]"],
        },
    },
])(
    "compiler plans correlate typed query $name through actual HTTP",
    async ({ query, wire }) => {
        const { analyze } = await import("../../compiler/src/index.js");
        const { snapshot, asset, id } =
            await import("../../compiler/tests/helpers.js");
        const data = {
            enabled: true,
            n: 42,
            tags: [true, 42, null, "x"],
            filter: { z: 2, a: true },
        };
        const source = snapshot(
            [
                {
                    id: "query",
                    action: "apiRequest",
                    method: "GET",
                    path: "/save",
                    query: { ...query, extra: "not-a-match-constraint" },
                    observers: [
                        {
                            id: "matched",
                            method: "GET",
                            path: "/save",
                            queryMatch: query,
                            timeoutMs: 500,
                            window: { mode: "UNTIL_ACTION_SETTLED", quietMs: 0 },
                        },
                    ],
                    afterAssertions: [
                        a({
                            type: "httpStatus",
                            source: "response:matched",
                            operator: "equals",
                            expected: 200,
                        }),
                    ],
                },
            ],
            [
                asset(3, "DATASET", {
                    schemaVersion: "1.0",
                    columns: {
                        enabled: "boolean",
                        n: "integer",
                        tags: "array",
                        filter: "object",
                    },
                    rows: [{ key: "one", values: data }],
                }),
            ],
            { datasetVersionId: id(3) },
        );
        const compiled = analyze(source);
        expect(compiled.issues).toEqual([]);
        const ctx = sdk.createStepContext({ ...f.options, data });
        try {
            const result = await sdk.executeStep(compiled.cases[0]!.steps[0]!, ctx);
            expect(result.status, JSON.stringify(result)).toBe("PASSED");
            expect(result.observers[0]?.matchedCount).toBe(1);
            const params = new URL(f.requests.at(-1)!.path, f.origin).searchParams;
            for (const [key, value] of Object.entries(wire))
                expect(params.getAll(key)).toEqual(
                    Array.isArray(value) ? value : [value],
                );
            expect(params.has("empty")).toBe(false);
        } finally {
            ctx.dispose();
        }
    },
);
it.each([
    { mode: "UNTIL_ACTION_SETTLED" as const, quietMs: 0 },
    { mode: "FIXED" as const, durationMs: 100 },
])(
    "ordinary $mode observers fail when a real action emits no matching request",
    async (window) => {
        const ctx = sdk.createStepContext(f.options);
        try {
            const result = await sdk.executeStep(
                step({
                    id: "no-request",
                    action: "fill",
                    target: "name",
                    value: "local-only",
                    observers: [
                        {
                            id: "required",
                            method: "POST",
                            path: "/never",
                            timeoutMs: 100,
                            window,
                        },
                    ],
                }),
                ctx,
            );
            expect(result.status).toBe("FAILED");
            expect(result.errorCode).toBe("NETWORK_TIMEOUT");
            expect(ctx.registry.activeCount()).toBe(0);
        } finally {
            ctx.dispose();
        }
    },
);
it("explicit zero-count absence remains a passing step without response consumers", async () => {
    const ctx = sdk.createStepContext(f.options);
    try {
        const result = await sdk.executeStep(
            step({
                id: "absent",
                action: "fill",
                target: "name",
                value: "local-only",
                observers: [
                    {
                        id: "absent",
                        method: "POST",
                        path: "/never",
                        expectedCount: 0,
                        timeoutMs: 200,
                        window: { mode: "FIXED", durationMs: 100 },
                    },
                ],
            }),
            ctx,
        );
        expect(result.status).toBe("PASSED");
        expect(result.observers[0]?.matchedCount).toBe(0);
        expect(ctx.registry.activeCount()).toBe(0);
    } finally {
        ctx.dispose();
    }
});
