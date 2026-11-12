import { afterAll, beforeAll, expect, it } from "vitest";
import { executeCase } from "../src/index.js";
import { analyze } from "../../compiler/src/index.js";
import { asset, id, snapshot } from "../../compiler/tests/helpers.js";
import { fixture } from "./helpers.js";
import type { LifecycleProvider } from "../src/index.js";
import type { ExecutionSnapshotV1 } from "@veriq/contracts";
let f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
    f = await fixture();
});
afterAll(async () => {
    await f.close();
});
const fixtureAsset = () =>
    asset(3, "FIXTURE", {
        schemaVersion: "1.0",
        prepare: { method: "POST", path: "/prepare" },
        query: { method: "GET", path: "/query" },
        cleanup: { method: "POST", path: "/cleanup" },
        inputSchema: { type: "object" },
        outputSchema: {
            type: "object",
            required: ["code"],
            properties: { code: { type: "string" } },
            additionalProperties: false,
        },
        ttlSeconds: 60,
    });
function input() {
    const source = snapshot(
        [{ id: "open", action: "goto", path: "/" }],
        [fixtureAsset()],
        { fixtureVersionId: id(3) },
    );
    const execution = {
        schemaVersion: "1.0",
        workspaceId: source.workspaceId,
        runId: id(11),
        caseExecutionId: id(12),
        caseVersionId: id(1),
        assetSourceHash: source.sourceHash,
        environmentVersionId: id(13),
        environment: {
            ...f.options.environment,
            roles: [
                {
                    roleKey: "reader",
                    authAdapterVersionId: id(14),
                    secretRef: "reader",
                    secretVersionId: id(15),
                },
            ],
        },
        roleKey: "reader",
        browser: "chromium",
        variables: {},
        secretVersions: [{ secretRef: "reader", versionId: id(15) }],
        namespace: "attempt",
        attemptNo: 1,
    } satisfies ExecutionSnapshotV1;
    return { source, plan: analyze(source).cases[0]!, execution };
}
it("requires both fixture lifecycle operations before authentication or business execution", async () => {
    const { source, plan, execution } = input();
    let authenticated = false;
    const r = await executeCase(plan, source, {
        page: f.page,
        execution,
        lifecycle: {
            authenticate: async () => {
                authenticated = true;
                return { identityId: "test" };
            },
        },
    });
    expect(r.errorCode).toBe("FIXTURE_PROVIDER_REQUIRED");
    expect(authenticated).toBe(false);
    expect(r.steps).toEqual([]);
});
it.each([
    "success",
    "prepare-failure",
    "invalid-output",
    "cleanup-failure",
] as const)(
    "records real lifecycle boundaries and compensates %s",
    async (mode) => {
        const { source, plan, execution } = input();
        let cleaned = false,
            cleanupToken: unknown;
        const lifecycle: LifecycleProvider = {
            authenticate: async () => ({ identityId: "test" }),
            prepare: async () => {
                if (mode === "prepare-failure") throw new Error("PREPARE_FAILED");
                return {
                    variables: { code: mode === "invalid-output" ? 12 : "attempt" },
                    cleanupToken: "cleanup-1",
                };
            },
            cleanup: async (_fixture, token) => {
                cleaned = true;
                cleanupToken = token;
                if (mode === "cleanup-failure") throw new Error("CLEANUP_FAILED");
            },
        };
        const r = await executeCase(plan, source, {
            page: f.page,
            execution,
            lifecycle,
        });
        expect(cleaned).toBe(true);
        expect(cleanupToken).toBe(
            mode === "prepare-failure" ? undefined : "cleanup-1",
        );
        expect(r.outcome).toBe(mode === "success" ? "PASSED" : "ERROR");
        expect(r.cleanupStatus).toBe(
            mode === "cleanup-failure" ? "FAILED" : "SUCCEEDED",
        );
        if (mode === "invalid-output") {
            expect(r.errorCode).toBe("FIXTURE_OUTPUT_INVALID");
            expect(r.steps).toEqual([]);
        }
    },
);
it("cancelled business action settles observers and still runs fixture cleanup", async () => {
    const other = await fixture();
    try {
        const { source, plan, execution } = input();
        plan.steps = [
            {
                step: {
                    id: "blocked",
                    action: "click",
                    target: "name",
                    observers: [
                        { id: "missing", method: "POST", path: "/never", timeoutMs: 10000 },
                    ],
                    afterAssertions: [],
                },
                sourcePath: "/steps/0",
                before: [],
                responseAssertions: [
                    {
                        assertion: {
                            id: "status",
                            type: "httpStatus",
                            source: "response:missing",
                            operator: "equals",
                            expected: 200,
                            severity: "BLOCK",
                            expectedSource: "REQ",
                        },
                        parameters: [],
                        sourcePath: "/assert",
                    },
                ],
                after: [],
            },
        ];
        execution.environment = {
            ...execution.environment,
            baseURL: other.origin,
            apiBaseURL: other.origin,
            allowedOrigins: [other.origin],
        };
        const controller = new AbortController();
        let cleaned = false;
        const emitter = other.page as unknown as import("node:events").EventEmitter;
        const running = executeCase(plan, source, {
            page: other.page,
            execution,
            signal: controller.signal,
            lifecycle: {
                authenticate: async () => ({ identityId: "test" }),
                prepare: async () => ({
                    variables: { code: "x" },
                    cleanupToken: "token",
                }),
                cleanup: async () => {
                    cleaned = true;
                },
            },
        });
        await expect
            .poll(() => emitter.listenerCount("response"))
            .toBeGreaterThan(0);
        controller.abort();
        const r = await running;
        expect(r.outcome).toBe("CANCELLED");
        expect(cleaned).toBe(true);
        expect(r.cleanupStatus).toBe("SUCCEEDED");
        expect(emitter.listenerCount("response")).toBe(0);
    } finally {
        await other.close();
    }
});
it("rejects resolved fixture input before authentication and passes explicit input separately", async () => {
    const { source, plan, execution } = input();
    const fixture = source.assets.find((a) => a.kind === "FIXTURE")!;
    if (fixture.kind !== "FIXTURE") throw Error();
    fixture.document.inputSchema = {
        type: "object",
        properties: { name: { type: "string", minLength: 2 } },
        required: ["name"],
        additionalProperties: false,
    };
    plan.document.initialVariables = { private: "string" };
    plan.document.fixtureInput = { name: "{{vars.private}}" };
    const { rehash } = await import("../../compiler/tests/helpers.js");
    rehash(source);
    execution.assetSourceHash = source.sourceHash;
    expect(analyze(source).issues).toEqual([]);
    execution.variables = { private: 42 };
    let authenticated = false;
    const lifecycle: LifecycleProvider = {
        authenticate: async () => {
            authenticated = true;
            return { identityId: "test" };
        },
        prepare: async (_fixture, context) => {
            expect(context.fixtureInput).toEqual({ name: "Ada" });
            expect(context.execution.variables).toEqual({ private: "Ada" });
            return { variables: { code: "ok" }, cleanupToken: "secret-cleanup" };
        },
        cleanup: async () => {},
    };
    const invalid = await executeCase(plan, source, {
        page: f.page,
        execution,
        lifecycle,
    });
    expect(invalid.errorCode).toBe("INITIAL_VARIABLES_INVALID");
    execution.variables = {};
    expect(
        (await executeCase(plan, source, { page: f.page, execution, lifecycle }))
            .errorCode,
    ).toBe("INITIAL_VARIABLES_INVALID");
    expect(authenticated).toBe(false);
    execution.variables = { private: "A" };
    expect(
        (await executeCase(plan, source, { page: f.page, execution, lifecycle }))
            .errorCode,
    ).toBe("FIXTURE_INPUT_INVALID");
    expect(authenticated).toBe(false);
    execution.variables = { private: "Ada" };
    expect(
        (await executeCase(plan, source, { page: f.page, execution, lifecycle }))
            .outcome,
    ).toBe("PASSED");
});
it.each([false, true])(
    "core protects generic cleanup tokens before ordinary projection (invalid output: %s)",
    async (invalidOutput) => {
        const { source, execution } = input();
        const secret = "generic-cleanup-token-protected";
        f.responses.set("/cleanup-echo", { token: secret });
        const caseAsset = source.assets.find((a) => a.kind === "CASE")!;
        if (caseAsset.kind !== "CASE") throw Error();
        caseAsset.document.steps = [
            {
                id: "echo",
                action: "apiRequest",
                method: "GET",
                path: "/cleanup-echo",
                observers: [
                    {
                        id: "echoed",
                        method: "GET",
                        path: "/cleanup-echo",
                        window: { mode: "UNTIL_ACTION_SETTLED", quietMs: 0 },
                    },
                ],
                afterAssertions: [
                    {
                        id: "token",
                        type: "responseField",
                        source: "response:echoed",
                        pointer: "/token",
                        operator: "notEquals",
                        expected: "public",
                        severity: "BLOCK",
                        expectedSource: "REQ-cleanup-secret",
                    },
                ],
            },
        ];
        const { rehash } = await import("../../compiler/tests/helpers.js");
        rehash(source);
        execution.assetSourceHash = source.sourceHash;
        const analysis = analyze(source);
        expect(analysis.issues).toEqual([]);
        const events: unknown[] = [];
        let cleaned: unknown;
        const result = await executeCase(analysis.cases[0]!, source, {
            page: f.page,
            execution,
            redact: (value) => value,
            emit: async (event) => {
                events.push(event);
            },
            lifecycle: {
                authenticate: async () => ({ identityId: "reader" }),
                prepare: async () => ({
                    variables: { code: invalidOutput ? 42 : "ok" },
                    cleanupToken: secret,
                }),
                cleanup: async (_fixture, token) => {
                    cleaned = token;
                },
            },
        });
        expect(cleaned).toBe(secret);
        expect(result.cleanupStatus).toBe("SUCCEEDED");
        expect(result.outcome).toBe(invalidOutput ? "ERROR" : "PASSED");
        expect(JSON.stringify(result)).not.toContain(secret);
        expect(JSON.stringify(events)).not.toContain(secret);
        if (invalidOutput) {
            expect(result.errorCode).toBe("FIXTURE_OUTPUT_INVALID");
            expect(result.steps).toEqual([]);
        } else {
            expect(result.steps[0]!.assertions[0]!.actual).toEqual({
                present: true,
                value: "[REDACTED]",
            });
        }
    },
);
