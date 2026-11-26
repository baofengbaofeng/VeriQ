import { expect, test } from "vitest";
import { validateSchema, assetSourceBytes, type BrowserSsoAuthConfigV1 } from "../src/index.js";
import source from "../fixtures/asset-source.json" with { type: "json" };
import browserSso from "../fixtures/browser-sso.json" with { type: "json" };
const id = "00000000-0000-4000-8000-000000000001";
test("fixed auth configurations accept supported handlers and reject uploaded code", () => {
    expect(
        validateSchema("AuthAdapterConfigV1", {
            kind: "HTTP_BEARER",
            identityPath: "/me",
            identityPointer: "/id",
        }),
    ).toEqual([]);
    expect(validateSchema("AuthAdapterConfigV1", { kind: "SCRIPT", source: "eval()" })).not.toEqual([]);
});

test("browser SSO requires an exact HTTPS origin and literal phase paths", () => {
    const configuration = { ...browserSso, kind: "BROWSER_SSO" } satisfies BrowserSsoAuthConfigV1;
    expect(validateSchema("AuthAdapterConfigV1", configuration)).toEqual([]);
    for (const idpOrigin of [
        "http://idp.sso.test",
        "https://idp.sso.test/",
        "https://idp.sso.test:443",
        "https://idp.sso.test:65536",
        "https://operator@idp.sso.test",
        "https://*.sso.test",
    ]) {
        expect(validateSchema("AuthAdapterConfigV1", { ...browserSso, idpOrigin })).not.toEqual([]);
    }
    for (const entryPath of ["//other.test", "/employees?next=x", "/employees#top"]) {
        expect(validateSchema("AuthAdapterConfigV1", { ...browserSso, entryPath })).not.toEqual([]);
    }
    expect(validateSchema("AuthAdapterConfigV1", { ...browserSso, submitName: "" })).not.toEqual([]);
});

test("attempt finish events accept bounded SSO results and reject unreviewed facts", () => {
    const event = {
        schemaVersion: "1.0",
        attemptId: id,
        sequence: 2,
        timestamp: "2026-11-22T00:00:00Z",
        type: "ATTEMPT_FINISHED",
        payload: { outcome: "ERROR", cleanupStatus: "NOT_REQUIRED" },
    };
    const authentication = {
        stage: "IDP",
        outcome: "FAILED",
        durationMs: 150,
        errorCode: "SSO_CHALLENGE_REQUIRED",
    };
    expect(validateSchema("ExecutionEventV1", event)).toEqual([]);
    expect(validateSchema("ExecutionEventV1", { ...event, payload: { ...event.payload, authentication } })).toEqual([]);
    expect(
        validateSchema("ExecutionEventV1", {
            ...event,
            payload: { ...event.payload, authentication: { ...authentication, rawDetails: "not allowed" } },
        }),
    ).not.toEqual([]);
});
test("source identity binds optional registry configurations", () => {
    const original = source.snapshot as never;
    const extended = {
        ...source.snapshot,
        authAdapters: [
            {
                workspaceId: id,
                versionId: id,
                contentHash: "a".repeat(64),
                configuration: {
                    kind: "HTTP_BEARER",
                    identityPath: "/me",
                    identityPointer: "/id",
                },
            },
        ],
    } as never;
    expect(assetSourceBytes(extended)).not.toEqual(assetSourceBytes(original));
});
test("fixture contracts admit explicit inputs and isolated service identities", () => {
    const c = {
        ...source.snapshot.assets[0]!.document,
        fixtureInput: { name: "{{data.name}}" },
    };
    expect(validateSchema("CaseDslV1", c)).toEqual([]);
    const f = {
        schemaVersion: "1.0",
        prepare: { method: "POST", path: "/prepare" },
        query: { method: "GET", path: "/query" },
        cleanup: { method: "POST", path: "/cleanup" },
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        ttlSeconds: 60,
    };
    expect(validateSchema("FixtureV1", f)).toEqual([]);
    expect(
        validateSchema("FixtureV1", {
            ...f,
            prepare: { method: "GET", path: "/prepare" },
        }),
    ).not.toEqual([]);
});
test("evidence manifests require an explicit sensitivity classification", () => {
    const file = { path: "trace.zip", sha256: "a".repeat(64), sizeBytes: 1 };
    expect(validateSchema("EvidenceFileEntryV1", file)).not.toEqual([]);
    expect(
        validateSchema("EvidenceFileEntryV1", {
            ...file,
            sensitivity: "CREDENTIAL_RESTRICTED",
        }),
    ).toEqual([]);
});
test("registry source projection matches Python with mixed-case UUID lexical ordering", async () => {
    const { createHash } = await import("node:crypto");
    const vector = (await import("../fixtures/identity-source.json", { with: { type: "json" } })).default;
    expect(createHash("sha256").update(assetSourceBytes(vector.snapshot)).digest("hex")).toBe(vector.sha256);
});
test("initial variable declarations expose only own correctly typed frozen values", async () => {
    const { resolveInitialVariables } = await import("../src/index.js");
    expect(
        resolveInitialVariables({ name: "string", count: "number" }, { name: "Ada", count: 2, legacy: true }),
    ).toEqual({ name: "Ada", count: 2 });
    expect(resolveInitialVariables(undefined, { legacy: true })).toEqual({});
    expect(() => resolveInitialVariables({ name: "string" }, {})).toThrow("INITIAL_VARIABLES_INVALID");
    expect(() => resolveInitialVariables({ name: "string" }, { name: 42 })).toThrow("INITIAL_VARIABLES_INVALID");
    expect(() => resolveInitialVariables({ name: "string" }, Object.create({ name: "Ada" }))).toThrow(
        "INITIAL_VARIABLES_INVALID",
    );
});
