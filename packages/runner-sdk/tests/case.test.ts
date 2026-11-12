import { beforeAll, afterAll, it, expect } from "vitest";
import * as sdk from "../src/index.js";
import { snapshot, id } from "../../compiler/tests/helpers.js";
import { analyze } from "../../compiler/src/index.js";
import { fixture } from "./helpers.js";
import type { ExecutionSnapshotV1 } from "@veriq/contracts";
let f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
    f = await fixture();
});
afterAll(async () => {
    await f.close();
});
function execution(source: ReturnType<typeof snapshot>): ExecutionSnapshotV1 {
    return {
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
        namespace: "attempt-1",
        attemptNo: 1,
    };
}
it("requires real authentication lifecycle integration rather than succeeding with an absent provider", async () => {
    expect(sdk).toHaveProperty("executeCase");
    const source = snapshot();
    const r = await sdk.executeCase(analyze(source).cases[0]!, source, {
        page: f.page,
        execution: execution(source),
    });
    expect(r).toMatchObject({
        outcome: "ERROR",
        errorCode: "AUTH_PROVIDER_REQUIRED",
    });
});
it("runs compiler output with explicit lifecycle, returns steps and emits redacted evidence", async () => {
    expect(sdk).toHaveProperty("executeCase");
    const source = snapshot([
        {
            id: "open",
            action: "goto",
            path: "/",
            afterAssertions: [
                {
                    id: "url",
                    type: "url",
                    source: "page",
                    operator: "contains",
                    expected: "/",
                    severity: "BLOCK",
                    expectedSource: "REQ",
                },
            ],
        },
    ]);
    const events: unknown[] = [];
    const r = await sdk.executeCase(analyze(source).cases[0]!, source, {
        page: f.page,
        execution: execution(source),
        lifecycle: { authenticate: async () => ({ identityId: "test-identity" }) },
        emit: async (e) => {
            events.push(e);
        },
        redact: (v) => v,
    });
    expect(r.outcome).toBe("PASSED");
    expect(r.steps[0]?.assertions[0]?.status).toBe("PASSED");
    expect(events.length).toBeGreaterThan(0);
});
it("rejects context source mismatch before authentication", async () => {
    expect(sdk).toHaveProperty("executeCase");
    const source = snapshot();
    const r = await sdk.executeCase(analyze(source).cases[0]!, source, {
        page: f.page,
        execution: { ...execution(source), assetSourceHash: "0".repeat(64) },
    });
    expect(r.errorCode).toBe("EXECUTION_CONTEXT_MISMATCH");
});
it("blocks off-origin browser navigation redirects", async () => {
    expect(sdk).toHaveProperty("executeCase");
    const source = snapshot([{ id: "open", action: "goto", path: "/redirect" }]);
    const r = await sdk.executeCase(analyze(source).cases[0]!, source, {
        page: f.page,
        execution: execution(source),
        lifecycle: { authenticate: async () => ({ identityId: "test" }) },
    });
    expect(r.outcome).toBe("FAILED");
    expect(f.page.url()).not.toContain("localhost:1");
});
it("WRITE cannot pass solely on HTTP 200 or missing checkpoint results", async () => {
    expect(sdk).toHaveProperty("executeCase");
    const source = snapshot();
    const plan = analyze(source).cases[0]!;
    plan.document.kind = "WRITE";
    plan.persistenceCheckpointStepId = "absent";
    const r = await sdk.executeCase(plan, source, {
        page: f.page,
        execution: execution(source),
        lifecycle: { authenticate: async () => ({ identityId: "test" }) },
    });
    expect(r.outcome).toBe("FAILED");
    expect(r.errorCode).toBe("PERSISTENCE_CHECKPOINT_FAILED");
});
