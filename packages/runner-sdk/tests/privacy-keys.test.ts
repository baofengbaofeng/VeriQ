import { test, expect } from "vitest";
import { EvidencePolicy } from "../src/evidence.js";

test("local secrets in dynamic JSON member names withhold the object without collisions", () => {
    const policy = new EvidencePolicy();
    const secret = "private local/ref version+secret";
    policy.protect(secret);
    for (const key of [
        secret,
        encodeURIComponent(secret),
        Buffer.from(secret).toString("base64"),
    ]) {
        expect(policy.redact({ [key]: "value", "[REDACTED]": "collision" })).toBe(
            "[REDACTED]",
        );
        expect(policy.redact({ safe: { [key]: "value" } })).toEqual({
            safe: "[REDACTED]",
        });
    }
});

test("protocol identifiers and enums survive coincidental secret strings while assertion JSON is private", async () => {
    const { validateSchema } = await import("@veriq/contracts");
    const policy = new EvidencePolicy();
    for (const value of ["sequence", "PASSED", "ASSERTION_RESULT", "read"])
        policy.protect(value);
    const event = {
        schemaVersion: "1.0",
        attemptId: "00000000-0000-4000-8000-000000000001",
        sequence: 1,
        timestamp: new Date().toISOString(),
        type: "ASSERTION_RESULT",
        stepId: "read",
        assertionId: "read",
        payload: {
            status: "PASSED",
            severity: "BLOCK",
            expectedSource: "REQ-test",
            expected: { sequence: 1 },
            actual: { present: true, value: { read: "value" } },
            durationMs: 1,
        },
    };
    const projected = policy.redactProtocol(event);
    expect(projected).toMatchObject({
        sequence: 1,
        type: "ASSERTION_RESULT",
        stepId: "read",
        payload: {
            status: "PASSED",
            expected: "[REDACTED]",
            actual: { present: true, value: "[REDACTED]" },
        },
    });
    expect(validateSchema("ExecutionEventV1", projected)).toEqual([]);
});

test("real SDK HTTP assertion and event boundary withhold local credential keys without breaking wire shape", async () => {
    const { createServer } = await import("node:http");
    const { fixture } = await import("./helpers.js");
    const { snapshot, id } = await import("../../compiler/tests/helpers.js");
    const { analyze } = await import("../../compiler/src/index.js");
    const { executeCase } = await import("../src/register-case.js");
    const { EventBuffer } = await import(
        new URL("../../../apps/runtime/src/execution/events.ts", import.meta.url)
            .href
    );
    const secret = "private local/ref version+secret",
        ref = "privateLocalRef",
        version = id(14),
        actual = {
            [secret]: "private",
            [encodeURIComponent(secret)]: "encoded",
            [Buffer.from(secret).toString("base64")]: "base64",
            [ref]: version,
        };
    const server = createServer((_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(actual));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const f = await fixture(),
        wire: unknown[] = [];
    try {
        const source = snapshot([
            {
                id: "sequence",
                action: "apiRequest",
                method: "GET",
                path: "/",
                observers: [
                    {
                        id: "action",
                        method: "GET",
                        path: "/",
                        window: { mode: "UNTIL_ACTION_SETTLED", quietMs: 0 },
                    },
                ],
                afterAssertions: [
                    {
                        id: "read",
                        type: "responseField",
                        source: "response:action",
                        pointer: "",
                        operator: "equals",
                        expected: actual,
                        severity: "BLOCK",
                        expectedSource: "REQ-private",
                    },
                ],
            },
        ]);
        const client = {
            request: async (
                _path: string,
                _method: string,
                body: { events: { sequence: number }[] },
            ) => {
                wire.push(...body.events);
                return { acceptedThrough: body.events.at(-1)!.sequence };
            },
        };
        const events = new EventBuffer(
            { attemptId: id(20), leaseToken: "synthetic", fencingToken: 1 } as never,
            client as never,
        );
        const analysis = analyze(source);
        expect(analysis.issues).toEqual([]);
        const result = await executeCase(analysis.cases[0]!, source, {
            page: f.page,
            execution: {
                schemaVersion: "1.0",
                workspaceId: source.workspaceId,
                runId: id(10),
                caseExecutionId: id(11),
                caseVersionId: id(1),
                assetSourceHash: source.sourceHash,
                environmentVersionId: id(12),
                environment: {
                    ...f.options.environment,
                    baseURL: origin,
                    apiBaseURL: origin,
                    allowedOrigins: [origin],
                    roles: [
                        {
                            roleKey: "reader",
                            authAdapterVersionId: id(13),
                            secretRef: ref,
                            secretVersionId: version,
                        },
                    ],
                },
                roleKey: "reader",
                browser: "chromium",
                variables: {},
                secretVersions: [{ secretRef: ref, versionId: version }],
                namespace: "private",
                attemptNo: 1,
            },
            credentials: {
                resolve: async () => ({
                    token: secret,
                    protocolWord: "sequence",
                    enumWord: "PASSED",
                }),
            },
            lifecycle: {
                authenticate: async (ctx) => {
                    await ctx.credentials!.resolve(
                        {
                            workspaceId: source.workspaceId,
                            secretRef: ref,
                            versionId: version,
                        },
                        ctx.signal,
                    );
                    return { identityId: "reader" };
                },
            },
            redact: (value) => value,
            onEvent: (event) => events.sdk(event),
        });
        await events.flush();
        expect(result, JSON.stringify(result)).toMatchObject({ outcome: "PASSED" });
        expect(wire.length).toBeGreaterThan(3);
        const text = JSON.stringify({ result, wire });
        for (const value of [
            secret,
            encodeURIComponent(secret),
            Buffer.from(secret).toString("base64"),
            ref,
            version,
        ])
            expect(text).not.toContain(value);
        expect(wire).toContainEqual(
            expect.objectContaining({
                type: "ASSERTION_RESULT",
                stepId: analysis.cases[0]!.steps[0]!.step.id,
                sequence: 2,
                payload: expect.objectContaining({
                    status: "PASSED",
                    expected: "[REDACTED]",
                    actual: { present: true, value: "[REDACTED]" },
                }),
            }),
        );
    } finally {
        await f.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
