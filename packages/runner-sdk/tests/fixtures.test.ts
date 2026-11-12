import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture } from "./helpers.js";
import { id, hash } from "../../compiler/tests/helpers.js";
import { canonicalBytes, type ExecutionSnapshotV1 } from "@veriq/contracts";
let f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
    f = await fixture();
});
afterAll(async () => {
    await f.close();
});
export function execution(origin: string): ExecutionSnapshotV1 {
    const configuration = {
        kind: "HTTP_BEARER" as const,
        identityPath: "/me",
        identityPointer: "/id",
    };
    return {
        schemaVersion: "1.0",
        workspaceId: id(99),
        runId: id(10),
        caseExecutionId: id(11),
        caseVersionId: id(1),
        assetSourceHash: "a".repeat(64),
        environmentVersionId: id(12),
        environment: {
            schemaVersion: "1.0",
            baseURL: origin,
            apiBaseURL: origin,
            fixtureBaseURL: origin,
            allowedOrigins: [origin],
            locale: "en",
            timezone: "UTC",
            roles: [
                {
                    roleKey: "editor",
                    authAdapterVersionId: id(13),
                    secretRef: "business",
                    secretVersionId: id(14),
                    allowedIdentityIds: ["editor"],
                },
            ],
            fixtureIdentity: {
                authAdapterVersionId: id(13),
                secretRef: "fixture",
                secretVersionId: id(15),
                allowedIdentityIds: ["fixture-service"],
            },
        },
        roleKey: "editor",
        browser: "chromium",
        variables: {},
        secretVersions: [
            { secretRef: "business", versionId: id(14) },
            { secretRef: "fixture", versionId: id(15) },
        ],
        namespace: "attempt-a",
        attemptNo: 1,
        authAdapters: [
            {
                workspaceId: id(99),
                versionId: id(13),
                configuration,
                contentHash: hash(canonicalBytes(configuration)),
            },
        ],
    };
}
export const definition = {
    schemaVersion: "1.0" as const,
    prepare: { method: "POST" as const, path: "/prepare" },
    query: { method: "GET" as const, path: "/query" },
    cleanup: { method: "POST" as const, path: "/cleanup" },
    inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
    },
    outputSchema: {
        type: "object",
        properties: { code: { type: "string" } },
        required: ["code"],
        additionalProperties: false,
    },
    ttlSeconds: 60,
};
test("fixture client rejects invalid explicit input before any request", async () => {
    const sdk = await import("../src/fixtures/client.js");
    const before = f.requests.length;
    await expect(
        sdk.prepareFixture({
            fixture: definition,
            context: {
                page: f.page,
                execution: execution(f.origin),
                signal: new AbortController().signal,
                fixtureInput: { name: 42 },
            },
        }),
    ).rejects.toThrow("FIXTURE_INPUT_INVALID");
    expect(f.requests.length).toBe(before);
});
test("auth uses verified ordinary identity and scopes bearer to exact API origin", async () => {
    const sdk = await import("../src/fixtures/auth.js");
    const seen: string[] = [];
    const target = createServer((req, res) => {
        seen.push(req.headers.authorization ?? "");
        if (req.url === "/redirect") {
            res.writeHead(302, { location: f.origin });
            res.end();
            return;
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: "editor" }));
    });
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(target.address() as { port: number }).port}`;
    try {
        const e = execution(origin);
        e.environment.allowedOrigins.push(f.origin);
        const context = {
            page: f.page,
            execution: e,
            signal: new AbortController().signal,
            fixtureInput: {},
            credentials: {
                resolve: async () => ({ token: "synthetic-bearer-secret" }),
            },
        };
        const auth = await sdk.authenticateBusiness(context);
        expect(auth.identityId).toBe("editor");
        await f.page.goto(origin);
        await f.page.goto(f.origin);
        await f.page.goto(origin + "/redirect");
        expect(seen.every((v) => v === "Bearer synthetic-bearer-secret")).toBe(
            true,
        );
        expect(sdk.businessHeaders(f.page.context(), f.origin)).toEqual({});
        expect(f.requests.every((r) => r.authorization === undefined)).toBe(true);
        const { apiRequest } = await import("../src/http.js");
        const { createStepContext } = await import("../src/context.js");
        const stepContext = createStepContext({
            ...f.options,
            environment: { ...e.environment, apiBaseURL: f.origin },
        });
        try {
            await apiRequest(stepContext, "GET", "/api-check");
            expect(f.requests.at(-1)!.authorization).toBeUndefined();
        } finally {
            stepContext.dispose();
        }
        await auth.dispose();
    } finally {
        target.closeAllConnections();
        await new Promise<void>((r) => target.close(() => r()));
    }
});
test("sample backend isolates Attempts, cleans UI resources and rejects a concurrent late commit", async () => {
    const { startDemo } = await import("../../../fixtures/test-support/demo.mjs");
    const { prepareFixture, cleanupFixture } =
        await import("../src/fixtures/client.js");
    const { authenticateBusiness } = await import("../src/fixtures/auth.js");
    const demo = await startDemo();
    const e = execution(demo.origin);
    const context = {
        page: f.page,
        execution: e,
        signal: new AbortController().signal,
        fixtureInput: { name: "Ada" },
        credentials: {
            resolve: async (ref: { secretRef: string }) => ({
                token:
                    ref.secretRef === "fixture" ? demo.fixtureToken : demo.businessToken,
            }),
        },
    };
    try {
        const first = await prepareFixture({ fixture: definition, context });
        const second = await prepareFixture({ fixture: definition, context });
        expect(second.fixtureId).toBe(first.fixtureId);
        await expect(
            prepareFixture({
                fixture: definition,
                context: { ...context, fixtureInput: { name: "Different" } },
            }),
        ).rejects.toThrow("FIXTURE_CONFLICT");
        const other = await prepareFixture({
            fixture: definition,
            context: {
                ...context,
                execution: { ...e, attemptNo: 2, namespace: "attempt-b" },
            },
        });
        expect(other.namespace).not.toBe(first.namespace);
        const business = await authenticateBusiness(context);
        await f.page.goto(demo.origin + `/?namespace=${first.namespace}`);
        await f.page.getByTestId("name").fill("UI-created");
        await f.page.getByTestId("save").click();
        await f.page
            .getByTestId("result")
            .getByText("CREATED", { exact: true })
            .waitFor();
        const listed = await f.page.request.get(
            demo.origin + `/employees?namespace=${first.namespace}`,
            { headers: { authorization: `Bearer ${demo.businessToken}` } },
        );
        expect((await listed.json()).items).toHaveLength(1);
        const late = fetch(demo.origin + "/employees", {
            method: "POST",
            headers: {
                authorization: `Bearer ${demo.businessToken}`,
                "content-type": "application/json",
            },
            body: JSON.stringify({
                namespace: first.namespace,
                name: "controlled-late",
            }),
        });
        await demo.waitAccepted();
        expect(await cleanupFixture(first)).toMatchObject({ status: "CLEANED" });
        await demo.release();
        expect((await late).status).toBe(409);
        expect(await cleanupFixture(first)).toMatchObject({
            status: "ALREADY_CLEANED",
        });
        expect(
            (
                await fetch(demo.origin + `/employees?namespace=${other.namespace}`, {
                    headers: { authorization: `Bearer ${demo.businessToken}` },
                })
            ).status,
        ).toBe(200);
        await demo.expire(other.namespace);
        expect(await demo.reconcile()).toMatchObject({
            processed: 1,
            hasMore: false,
        });
        expect(await demo.reconcile()).toMatchObject({
            processed: 0,
            hasMore: false,
        });
        await business.dispose();
    } finally {
        await demo.close();
    }
});
test("session business login transfers only verified cookies and fixture session stays isolated", async () => {
    const { startDemo } = await import("../../../fixtures/test-support/demo.mjs");
    const { authenticateBusiness, authenticatedRequest } =
        await import("../src/fixtures/auth.js");
    const demo = await startDemo();
    const page = await f.page.context().browser()!.newPage();
    try {
        const e = execution(demo.origin),
            configuration = {
                kind: "HTTP_SESSION" as const,
                loginPath: "/login",
                identityPath: "/me",
                identityPointer: "/id",
            };
        e.authAdapters![0]!.configuration = configuration;
        e.authAdapters![0]!.contentHash = hash(canonicalBytes(configuration));
        const context = {
            page,
            execution: e,
            signal: new AbortController().signal,
            credentials: {
                resolve: async (ref: { secretRef: string }) => ({
                    token:
                        ref.secretRef === "fixture"
                            ? demo.fixtureToken
                            : demo.businessToken,
                }),
            },
        };
        const fixtureAuth = await authenticatedRequest(
            context,
            e.environment.fixtureIdentity!,
            demo.origin,
        );
        expect(fixtureAuth.identityId).toBe("fixture-service");
        expect(await page.context().cookies()).toEqual([]);
        await fixtureAuth.dispose();
        const auth = await authenticateBusiness(context);
        expect(auth.identityId).toBe("editor");
        expect(
            (await (await page.request.get(demo.origin + "/me")).json()).id,
        ).toBe("editor");
        await auth.dispose();
        expect(await page.context().cookies()).toEqual([]);
    } finally {
        await page.context().close();
        await demo.close();
    }
});
test("personal local credential provider requires an exact local version mapping", async () => {
    const { LocalCredentialProvider } = await import("../src/fixtures/local.js");
    const provider = new LocalCredentialProvider([
        {
            workspaceId: id(99),
            secretRef: "business",
            versionId: id(14),
            value: { token: "local-synthetic" },
        },
    ]);
    expect(
        await provider.resolve(
            { workspaceId: id(99), secretRef: "business", versionId: id(14) },
            new AbortController().signal,
        ),
    ).toEqual({ token: "local-synthetic" });
    await expect(
        provider.resolve(
            { workspaceId: id(99), secretRef: "business", versionId: id(15) },
            new AbortController().signal,
        ),
    ).rejects.toThrow("LOCAL_CREDENTIAL_REQUIRED");
});
test("partial preparation and a SIGKILL worker leave precisely reclaimable fixture ownership", async () => {
    const { startDemo } = await import("../../../fixtures/test-support/demo.mjs");
    const { prepareFixture, cleanupFixture } =
        await import("../src/fixtures/client.js");
    const { spawn } = await import("node:child_process");
    const demo = await startDemo();
    const e = execution(demo.origin);
    const context = {
        page: f.page,
        execution: e,
        signal: new AbortController().signal,
        fixtureInput: { name: "partial" },
        credentials: { resolve: async () => ({ token: demo.fixtureToken }) },
    };
    try {
        const incompatible = {
            ...definition,
            outputSchema: { type: "object", required: ["missing"] },
        };
        await expect(
            prepareFixture({ fixture: incompatible, context }),
        ).rejects.toThrow("FIXTURE_OUTPUT_INVALID");
        expect(
            await cleanupFixture({ fixture: incompatible, context }),
        ).toMatchObject({ status: "CLEANED" });
        const body = {
            workspaceId: e.workspaceId,
            caseExecutionId: e.caseExecutionId,
            attemptNo: 2,
            namespace: "killed-attempt",
            idempotencyKey: `${e.workspaceId}:${e.caseExecutionId}:2`,
            input: { name: "killed" },
            ttlSeconds: 60,
        };
        const child = spawn(
            process.execPath,
            [
                "--input-type=module",
                "-e",
                "const response=await fetch(process.env.TARGET,{method:'POST',headers:{authorization:'Bearer '+process.env.FIXTURE_TOKEN,'content-type':'application/json'},body:process.env.PREPARE_BODY});if(!response.ok)process.exit(2);console.log('PREPARED');process.stdin.resume();",
            ],
            {
                env: {
                    ...process.env,
                    TARGET: demo.origin + "/prepare",
                    FIXTURE_TOKEN: demo.fixtureToken,
                    PREPARE_BODY: JSON.stringify(body),
                },
                stdio: ["pipe", "pipe", "pipe"],
            },
        );
        await new Promise<void>((resolve, reject) => {
            child.stdout.once("data", (data) =>
                String(data).trim() === "PREPARED"
                    ? resolve()
                    : reject(Error("WORKER_PREPARE_FAILED")),
            );
            child.once("error", reject);
            child.once("exit", (code) => {
                if (code !== null) reject(Error("WORKER_EXITED"));
            });
        });
        child.kill("SIGKILL");
        expect(
            await new Promise<string | null>((resolve) =>
                child.once("exit", (_code, signal) => resolve(signal)),
            ),
        ).toBe("SIGKILL");
        await demo.expire(body.namespace);
        expect(await demo.reconcile()).toMatchObject({
            processed: 1,
            hasMore: false,
        });
        expect(await demo.reconcile()).toMatchObject({
            processed: 0,
            hasMore: false,
        });
    } finally {
        await demo.close();
    }
});
test("built-in lifecycle compensates after cancellation closes the business browser", async () => {
    const { startDemo } = await import("../../../fixtures/test-support/demo.mjs");
    const { createHttpLifecycle } = await import("../src/fixtures/client.js");
    const { executeCase } = await import("../src/register-case.js");
    const { snapshot, asset, rehash } =
        await import("../../compiler/tests/helpers.js");
    const { analyze } = await import("../../compiler/src/index.js");
    const demo = await startDemo(),
        page = await f.page.context().browser()!.newPage();
    const source = snapshot(
        [
            { id: "open", action: "goto", path: "/?namespace=attempt-a" },
            { id: "name", action: "fill", target: "name", value: "controlled-late" },
            {
                id: "save",
                action: "click",
                target: "save",
                observers: [
                    {
                        id: "saved",
                        method: "POST",
                        path: "/employees",
                        window: { mode: "UNTIL_ACTION_SETTLED", quietMs: 0 },
                    },
                ],
                afterAssertions: [
                    {
                        id: "created",
                        type: "httpStatus",
                        source: "response:saved",
                        operator: "equals",
                        expected: 200,
                        severity: "BLOCK",
                        expectedSource: "REQ-cancel",
                    },
                ],
            },
        ],
        [asset(3, "FIXTURE", definition)],
        {
            roleKey: "editor",
            fixtureVersionId: id(3),
            fixtureInput: { name: "Ada" },
        },
    );
    const catalog = source.assets.find((a) => a.kind === "ELEMENT_CATALOG")!;
    if (catalog.kind !== "ELEMENT_CATALOG") throw Error();
    catalog.document.elements.push({
        key: "save",
        locator: { by: "testId", value: "save" },
    });
    rehash(source);
    const e = execution(demo.origin);
    e.assetSourceHash = source.sourceHash;
    const controller = new AbortController();
    try {
        const running = executeCase(analyze(source).cases[0]!, source, {
            page,
            execution: e,
            lifecycle: createHttpLifecycle(),
            credentials: {
                resolve: async (ref) => ({
                    token:
                        ref.secretRef === "fixture"
                            ? demo.fixtureToken
                            : demo.businessToken,
                }),
            },
            signal: controller.signal,
        });
        await demo.waitAccepted();
        controller.abort();
        const result = await running;
        expect(result.outcome).toBe("CANCELLED");
        expect(result.cleanupStatus).toBe("SUCCEEDED");
        await demo.release();
        const closed = await fetch(
            demo.origin +
                "/query?idempotencyKey=" +
                encodeURIComponent(`${e.workspaceId}:${e.caseExecutionId}:1`),
            { headers: { authorization: `Bearer ${demo.fixtureToken}` } },
        );
        expect((await closed.json()).state).toBe("CLOSED");
    } finally {
        await page.context().close();
        await demo.close();
    }
});
test("fixture transport failures never expose protected headers in thrown errors", async () => {
    const { prepareFixture } = await import("../src/fixtures/client.js");
    const target = createServer((req, res) => {
        if (req.url === "/me") {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ id: "fixture-service" }));
        } else {
            req.socket.destroy();
        }
    });
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(target.address() as { port: number }).port}`;
    try {
        let error: unknown;
        try {
            await prepareFixture({
                fixture: definition,
                context: {
                    page: f.page,
                    execution: execution(origin),
                    signal: new AbortController().signal,
                    fixtureInput: { name: "Ada" },
                    credentials: {
                        resolve: async () => ({ token: "synthetic-transport-secret" }),
                    },
                },
            });
        } catch (e) {
            error = e;
        }
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("FIXTURE_REQUEST_FAILED");
        expect(String((error as Error).stack)).not.toContain(
            "synthetic-transport-secret",
        );
    } finally {
        target.closeAllConnections();
        await new Promise<void>((r) => target.close(() => r()));
    }
});
