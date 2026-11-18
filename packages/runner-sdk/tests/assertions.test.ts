import { beforeAll, afterAll, it, expect } from "vitest";
import { executeStep, createStepContext } from "../src/index.js";
import { a, step, fixture } from "./helpers.js";
let f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
    f = await fixture();
});
afterAll(async () => {
    await f.close();
});
it.each([
    ["httpStatus", "equals", 200, undefined, true],
    ["httpStatus", "equals", 201, undefined, false],
    ["responseField", "equals", null, "/nil", true],
    ["responseField", "equals", null, "/absent", false],
    ["responseField", "notEquals", null, "/absent", false],
    ["responseField", "exists", false, "/absent", true],
    ["responseField", "exists", true, "/nil", true],
    ["responseField", "equals", "0", "/code", false],
    ["responseField", "in", [0, 1], "/code", true],
    ["responseField", "contains", [2], "/items", true],
    ["responseField", "contains", "saved", "/id", true],
    [
        "responseSchema",
        "matchesSchema",
        { type: "object", properties: { literal: { const: "{{evil()}}" } } },
        undefined,
        true,
    ],
    ["responseSchema", "matchesSchema", { type: "array" }, undefined, false],
    ["duration", "lessThanOrEqual", 10000, undefined, true],
    ["request", "methodEquals", "POST", undefined, true],
    ["request", "pathEquals", "/save", undefined, true],
    ["requestField", "equals", "attempt-1", "/body/code", true],
] as const)(
    "evaluates %s/%s with strict values and auditable evidence",
    async (type, operator, expected, pointer, pass) => {
        const r = await executeStep(
            step(
                {
                    id: "request",
                    action: "apiRequest",
                    method: "POST",
                    path: "/save",
                    body: { code: "{{data.name}}" },
                },
                [
                    a({
                        type,
                        operator,
                        expected,
                        source: type.startsWith("request") ? "request:action" : "response:action",
                        ...(pointer ? { pointer } : {}),
                    }),
                ],
            ),
            createStepContext(f.options),
        );
        expect(r.status).toBe(pass ? "PASSED" : "FAILED");
        expect(r.assertions[0]?.expectedSource).toBe("REQ-1");
    },
);
it.each(["/text", "/empty"])("accepts status assertions but rejects JSON extraction for %s", async (path) => {
    const r = await executeStep(
        step({ id: "request", action: "apiRequest", method: "GET", path }, [
            a({
                type: "httpStatus",
                source: "response:action",
                operator: "equals",
                expected: path === "/empty" ? 204 : 200,
            }),
            a({
                type: "responseField",
                source: "response:action",
                pointer: "",
                operator: "equals",
                expected: null,
            }),
        ]),
        createStepContext(f.options),
    );
    expect(r.assertions.map((x) => x.status)).toEqual(["PASSED", "FAILED"]);
    expect(r.assertions[1]?.actual).toEqual({ present: false });
});
it("WARN does not block extraction; CONTINUE_FAIL still fails the step", async () => {
    const ctx = createStepContext(f.options);
    const r = await executeStep(
        step(
            {
                id: "request",
                action: "apiRequest",
                method: "GET",
                path: "/save",
                extract: [
                    {
                        source: "response:action",
                        pointer: "/nil",
                        to: "nil",
                        valueType: "null",
                        required: true,
                    },
                    {
                        source: "response:action",
                        pointer: "/absent",
                        to: "absent",
                        valueType: "string",
                        required: false,
                    },
                ],
            },
            [
                a({
                    type: "httpStatus",
                    source: "response:action",
                    operator: "equals",
                    expected: 999,
                    severity: "WARN",
                }),
            ],
        ),
        ctx,
    );
    expect(r.status).toBe("PASSED");
    expect(r.assertions[0]?.status).toBe("WARN");
    expect(ctx.vars.nil).toBeNull();
    expect(ctx.vars).not.toHaveProperty("absent");
});
it.each([
    ["fill", "name", "A"],
    ["press", "name", "ControlOrMeta+A"],
    ["check", "check", undefined],
    ["uncheck", "check", undefined],
    ["selectOption", "select", "b"],
] as const)("executes browser action %s", async (action, target, value) => {
    const r = await executeStep(
        step({ id: action, action, target, ...(value ? { value } : {}) } as never),
        createStepContext(f.options),
    );
    expect(r.status).toBe("PASSED");
    if (action === "fill") expect(await f.page.locator('[veriq-id="name"]').inputValue()).toBe("A");
    if (action === "check" || action === "uncheck")
        expect(await f.page.locator('[veriq-id="check"]').isChecked()).toBe(action === "check");
    if (action === "selectOption") expect(await f.page.locator('[veriq-id="select"]').inputValue()).toBe("b");
});
it.each([
    ["visible", "text", true],
    ["attached", "text", true],
    ["enabled", "disabled", false],
    ["checked", "check", false],
    ["editable", "name", true],
    ["textEquals", "text", "Ready"],
    ["textContains", "text", "ead"],
    ["valueEquals", "select", "b"],
    ["countEquals", "duplicate", 2],
] as const)("runs UI operator %s", async (operator, target, expected) => {
    const p = step(
        { id: "ui", action: "apiRequest", method: "GET", path: "/save" },
        [],
        [a({ type: "ui", operator, target, expected })],
    );
    expect((await executeStep(p, createStepContext(f.options))).status).toBe("PASSED");
});
it("nested template scopes preserve caller data and inert bound text", async () => {
    const ctx = createStepContext({
            ...f.options,
            data: { outer: "saved-1", inner: "wrong" },
        }),
        p = step({ id: "get", action: "apiRequest", method: "GET", path: "/save" }, [
            a({
                type: "responseField",
                source: "response:action",
                pointer: "/id",
                operator: "equals",
                expected: "{{data.inner}}",
            }),
        ]);
    p.responseAssertions[0]!.parameters = [{ middle: "{{data.outer}}" }, { inner: "{{data.middle}}" }];
    expect((await executeStep(p, ctx)).status).toBe("PASSED");
    expect(ctx.data.inner).toBe("wrong");
});
it("callFlow wrapper observers span children and wrapper bindings keep caller data", async () => {
    const ctx = createStepContext({ ...f.options, data: { name: "caller" } }),
        p = step(
            {
                id: "wrapper",
                action: "callFlow",
                versionId: "unused",
                parameters: { name: "child" },
                observers: [
                    {
                        id: "whole",
                        method: "POST",
                        path: "/save",
                        bodyMatch: { code: "child" },
                        window: { mode: "UNTIL_ACTION_SETTLED", quietMs: 0 },
                    },
                ],
                extract: [
                    {
                        source: "response:whole",
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
                    source: "response:whole",
                    pointer: "/code",
                    operator: "equals",
                    expected: 0,
                }),
            ],
        );
    p.children = [
        step({
            id: "child",
            action: "apiRequest",
            method: "POST",
            path: "/save",
            body: { code: "{{data.name}}" },
        }),
    ];
    expect((await executeStep(p, ctx)).status).toBe("PASSED");
    expect(ctx.data.name).toBe("caller");
    expect(ctx.vars.id).toBe("saved-1");
    expect(ctx.registry.activeCount()).toBe(0);
});
it("requires an upload provider and uses actual file bytes from it", async () => {
    const p = step({
        id: "upload",
        action: "upload",
        target: "upload",
        value: ["fixture.txt"],
    });
    expect((await executeStep(p, createStepContext(f.options))).errorCode).toBe("FILE_PROVIDER_REQUIRED");
    expect(
        (
            await executeStep(
                p,
                createStepContext({
                    ...f.options,
                    files: async () => [
                        {
                            name: "fixture.txt",
                            mimeType: "text/plain",
                            buffer: Buffer.from("fixture"),
                        },
                    ],
                }),
            )
        ).status,
    ).toBe("PASSED");
    expect(await f.page.locator('[veriq-id="upload"]').evaluate((el: HTMLInputElement) => el.files?.[0]?.name)).toBe(
        "fixture.txt",
    );
});
it("blocks forbidden substituted paths and redirects before the destination request", async () => {
    for (const path of ["//evil.test/", "/\\evil.test/", "/redirect"]) {
        const r = await executeStep(
            step({ id: "request", action: "apiRequest", method: "GET", path }),
            createStepContext(f.options),
        );
        expect(r.status).toBe("FAILED");
    }
});
it.each(["/%5cevil.test/", "/%2fhost/", "/%250aheader"])(
    "rejects unsafe paths after percent decoding: %s",
    async (path) => {
        const count = f.requests.length;
        const r = await executeStep(
            step({ id: "request", action: "apiRequest", method: "GET", path }),
            createStepContext(f.options),
        );
        expect(r.status).toBe("FAILED");
        expect(f.requests).toHaveLength(count);
    },
);
it("rejects API redirects across origins even when both origins are allowlisted", async () => {
    const ctx = createStepContext({
        ...f.options,
        environment: {
            ...f.options.environment,
            allowedOrigins: [f.origin, "http://localhost:1"],
        },
    });
    const r = await executeStep(
        step({
            id: "request",
            action: "apiRequest",
            method: "GET",
            path: "/redirect",
            headers: { authorization: "test-only" },
        }),
        ctx,
    );
    expect(r.errorCode).toBe("ORIGIN_NOT_ALLOWED");
    ctx.dispose();
});
it("preserves repeated query values and scalar types at the request boundary", async () => {
    const r = await executeStep(
        step(
            {
                id: "query",
                action: "apiRequest",
                method: "GET",
                path: "/save",
                query: { tag: ["a", "b"], enabled: true },
            },
            [
                a({
                    type: "requestField",
                    source: "request:action",
                    pointer: "/query/tag",
                    operator: "equals",
                    expected: ["a", "b"],
                }),
            ],
        ),
        createStepContext(f.options),
    );
    expect(r.status).toBe("PASSED");
    expect(f.requests.at(-1)?.path).toBe("/save?tag=a&tag=b&enabled=true");
});
it("allows same-origin reads to redirect but never replays a redirected write", async () => {
    const read = await executeStep(
        step(
            {
                id: "read",
                action: "apiRequest",
                method: "GET",
                path: "/same-redirect",
            },
            [
                a({
                    type: "httpStatus",
                    source: "response:action",
                    operator: "equals",
                    expected: 200,
                }),
            ],
        ),
        createStepContext(f.options),
    );
    expect(read.status).toBe("PASSED");
    const writes = f.requests.filter((r) => r.path === "/save" && r.method === "POST").length;
    const write = await executeStep(
        step({
            id: "write",
            action: "apiRequest",
            method: "POST",
            path: "/same-redirect",
            body: { code: "never-replay" },
        }),
        createStepContext(f.options),
    );
    expect(write.errorCode).toBe("WRITE_REDIRECT_FORBIDDEN");
    expect(f.requests.filter((r) => r.path === "/save" && r.method === "POST")).toHaveLength(writes);
});
it("distinguishes empty membership, missing field, and null", async () => {
    const { staticDatasetResolver } = await import("../src/index.js");
    const resolver = staticDatasetResolver(
        new Map([
            [
                "names",
                {
                    schemaVersion: "2.0",
                    shape: "TREE",
                    fields: { name: { type: "string", required: false, nullable: true } },
                    source: {
                        kind: "STATIC",
                        rows: [
                            { key: "root", parentKey: null, order: 0, values: { name: null } },
                            { key: "b", parentKey: "root", order: 0, values: {} },
                            { key: "B", parentKey: "root", order: 0, values: { name: "{{data.input}}" } },
                        ],
                    },
                },
            ],
        ]),
    );
    const read = (query: import("@veriq/contracts").DatasetQuery) =>
        resolver.read(query, { data: { input: "root" }, vars: {} }, new AbortController().signal);
    await expect(read({ alias: "names", op: "field", key: "{{data.input}}", field: "name" })).resolves.toBeNull();
    await expect(read({ alias: "names", op: "field", key: "b", field: "name" })).rejects.toThrow(
        "DATASET_FIELD_MISSING",
    );
    await expect(read({ alias: "names", op: "field", key: "B", field: "name" })).resolves.toBe("{{data.input}}");
    await expect(read({ alias: "names", op: "contains", key: "absent" })).resolves.toBe(false);
    await expect(read({ alias: "names", op: "path", key: "B" })).resolves.toEqual(["root", "B"]);
    await expect(read({ alias: "names", op: "children", parentKey: "root" })).resolves.toEqual(["B", "b"]);
    await expect(read({ alias: "names", op: "filter", field: "name", equals: null, select: "name" })).resolves.toEqual([
        null,
    ]);
    const r = await executeStep(
        step({ id: "get", action: "apiRequest", method: "GET", path: "/save" }, [
            a({
                type: "responseField",
                source: "response:action",
                pointer: "/nil",
                operator: "equals",
                severity: "WARN",
                datasetExpected: { alias: "names", op: "field", key: "b", field: "name" },
            }),
        ]),
        createStepContext({ ...f.options, datasets: resolver }),
    );
    expect(r.status).toBe("ERROR");
    expect(r.errorCode).toBe("DATASET_FIELD_MISSING");
});

it("samples once per assertion phase across query operators and refreshes retry attempts", async () => {
    const sdk = await import("../src/index.js");
    const { default: fixture } = await import("../../contracts/fixtures/http-dataset.json", { with: { type: "json" } });
    const version = "00000000-0000-4000-8000-000000000007";
    const calls: string[] = [];
    const read = async (_version: string, args: Record<string, unknown>) => {
        calls.push(String(args.search));
        return {
            sourceVersionId: version,
            fetchedAt: "2026-01-02T03:04:05.000Z",
            rows: [{ key: "entry", values: { label: "/save" } }],
        };
    };
    const q = (search: string) =>
        a({
            type: "url",
            source: "page",
            operator: "contains",
            severity: "WARN",
            datasetExpected: { op: "field", alias: "names", key: "entry", field: "label", parameters: { search } },
        });
    const plan = step({ id: "go", action: "goto", path: "/save" }, [], [q("a"), q("a"), q("b")]);
    plan.before = plan.after.slice(0, 2);
    for (let attempt = 0; attempt < 2; attempt++) {
        const resolver = sdk.connectedDatasetResolver(
            new Map([
                ["names", { ...fixture, source: { ...fixture.source, parameters: { search: "string" } } } as never],
            ]),
            { names: version },
            fixture.source.environmentVersionId,
            read,
        );
        const ctx = createStepContext({ ...f.options, datasets: resolver, datasetProtected: true });
        const result = await executeStep(plan, ctx);
        expect(result.assertions.map((r) => r.sample?.sourceVersionId)).toEqual(Array(5).fill(version));
        expect(result.assertions.at(-1)?.status).toBe("PASSED");
        expect(JSON.stringify(result.assertions)).not.toContain("/save");
        ctx.dispose();
    }
    expect(calls).toEqual(["a", "a", "b", "a", "a", "b"]);
});

it("coalesces pending reads across aliases and query shapes and releases them on abort", async () => {
    const { connectedDatasetResolver } = await import("../src/datasets.js");
    const { default: fixture } = await import("../../contracts/fixtures/http-dataset.json", { with: { type: "json" } });
    const version = "00000000-0000-4000-8000-000000000007";
    const source = { ...fixture, source: { ...fixture.source, parameters: { a: "string", b: "boolean" } } };
    const documents = new Map([
        ["first", source as never],
        ["second", source as never],
    ]);
    const readers: AbortSignal[] = [];
    let resume!: () => void;
    const release = new Promise<void>((resolve) => {
        resume = resolve;
    });
    const resolver = connectedDatasetResolver(
        documents,
        { first: version, second: version },
        source.source.environmentVersionId,
        async (_version, _args, signal) => {
            readers.push(signal);
            await release;
            return { sourceVersionId: version, fetchedAt: "2026-01-02T03:04:05.000Z", rows: [] };
        },
    );
    const open = resolver.phase!(),
        signal = new AbortController().signal;
    const member = open.read(
        { op: "contains", alias: "first", key: "missing", parameters: { a: "one", b: false } },
        {},
        signal,
    );
    const filtered = open.read(
        {
            op: "filter",
            alias: "second",
            field: "label",
            equals: "none",
            select: "label",
            parameters: { b: false, a: "one" },
        },
        {},
        signal,
    );
    expect(readers).toHaveLength(1);
    resume();
    await expect(member).resolves.toBe(false);
    await expect(filtered).resolves.toEqual([]);
    open.close();
    expect(readers[0]!.aborted).toBe(true);
    await expect(open.read({ op: "contains", alias: "first", key: "one" }, {}, signal)).rejects.toThrow();
});

it.each(["DATASET_REQUEST_TIMEOUT", "DATASET_UPSTREAM_REJECTED", "DATASET_PAGINATION_INCOMPLETE"])(
    "preserves %s as an assertion ERROR under WARN severity",
    async (code) => {
        const ctx = createStepContext({
            ...f.options,
            datasetProtected: true,
            datasets: {
                async read() {
                    throw new Error(code);
                },
            },
        });
        const plan = step(
            { id: "go", action: "goto", path: "/save" },
            [],
            [
                a({
                    type: "url",
                    source: "page",
                    operator: "contains",
                    severity: "WARN",
                    datasetExpected: { alias: "r", op: "field", key: "row", field: "label" },
                }),
            ],
        );
        const result = await executeStep(plan, ctx);
        expect(result).toMatchObject({
            status: "ERROR",
            errorCode: code,
            assertions: [{ status: "ERROR", errorCode: code, expected: null, actual: { present: false } }],
        });
        ctx.dispose();
    },
);

it.each(["WARN", "BLOCK"] as const)("reports a pre-sampling deadline as ERROR for %s", async (severity) => {
    const { runAssertion } = await import("../src/assertions/http.js");
    const ctx = createStepContext({ ...f.options, datasetProtected: true });
    const assertion = a({
        type: "url",
        source: "page",
        operator: "contains",
        severity,
        datasetExpected: { alias: "remote", op: "field", key: "one", field: "label" },
    });
    const item = step({ id: "home", action: "goto", path: "/" }, [], [assertion]).after[0]!;
    try {
        const result = await runAssertion(item, { ...ctx, deadline: Date.now() - 1 });
        expect(result).toMatchObject({
            status: "ERROR",
            errorCode: "BUSINESS_TIMEOUT",
            expected: null,
            actual: { present: false },
            severity,
        });
        expect(result).not.toHaveProperty("sample");
        const cancelled = new AbortController();
        cancelled.abort();
        await expect(runAssertion(item, { ...ctx, signal: cancelled.signal })).rejects.toThrow("CANCELLED");
    } finally {
        ctx.dispose();
    }
});
