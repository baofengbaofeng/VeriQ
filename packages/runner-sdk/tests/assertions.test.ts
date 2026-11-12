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
                        source: type.startsWith("request")
                            ? "request:action"
                            : "response:action",
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
it.each(["/text", "/empty"])(
    "accepts status assertions but rejects JSON extraction for %s",
    async (path) => {
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
    },
);
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
    if (action === "fill")
        expect(await f.page.getByTestId("name").inputValue()).toBe("A");
    if (action === "check" || action === "uncheck")
        expect(await f.page.getByTestId("check").isChecked()).toBe(
            action === "check",
        );
    if (action === "selectOption")
        expect(await f.page.getByTestId("select").inputValue()).toBe("b");
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
    expect((await executeStep(p, createStepContext(f.options))).status).toBe(
        "PASSED",
    );
});
it("nested template scopes preserve caller data and inert bound text", async () => {
    const ctx = createStepContext({
            ...f.options,
            data: { outer: "saved-1", inner: "wrong" },
        }),
        p = step(
            { id: "get", action: "apiRequest", method: "GET", path: "/save" },
            [
                a({
                    type: "responseField",
                    source: "response:action",
                    pointer: "/id",
                    operator: "equals",
                    expected: "{{data.inner}}",
                }),
            ],
        );
    p.responseAssertions[0]!.parameters = [
        { middle: "{{data.outer}}" },
        { inner: "{{data.middle}}" },
    ];
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
    expect((await executeStep(p, createStepContext(f.options))).errorCode).toBe(
        "FILE_PROVIDER_REQUIRED",
    );
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
    expect(
        await f.page
            .getByTestId("upload")
            .evaluate((el: HTMLInputElement) => el.files?.[0]?.name),
    ).toBe("fixture.txt");
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
    const writes = f.requests.filter(
        (r) => r.path === "/save" && r.method === "POST",
    ).length;
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
    expect(
        f.requests.filter((r) => r.path === "/save" && r.method === "POST"),
    ).toHaveLength(writes);
});
