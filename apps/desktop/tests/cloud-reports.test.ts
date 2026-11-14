import assert from "node:assert/strict";
import test from "node:test";
import type { PlatformComponents } from "@veriq/contracts";
import { CloudReportAdapter } from "../../web/src/features/reports/adapters.ts";
import { installHostTransport } from "../../web/src/api.ts";
import { nativeCloudReports } from "../src/renderer/cloud-reports.ts";
import type { DesktopBridge } from "../src/shared/bridge.ts";

type S = PlatformComponents["schemas"];
const workspaceId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const attemptId = "33333333-3333-4333-8333-333333333333";
const gate = { passed: false, reasons: ["NOT_FINISHED"] };
const queued: S["RunReportDTO"] = {
    run: {
        id: runId,
        workspaceId,
        source: "CONNECTED_LOCAL",
        state: "QUEUED",
        snapshotHash: "a".repeat(64),
        createdAt: "2026-11-13T00:00:00Z",
    },
    cases: [],
    gateAtExecution: gate,
    gateNow: gate,
    statistics: { caseCount: 0, firstPassCount: 0, retryPassCount: 0, infrastructureErrorCount: 0 },
};
const streamed: S["RunReportDTO"] = {
    ...queued,
    cases: [
        {
            id: "44444444-4444-4444-8444-444444444444",
            caseVersionId: "55555555-5555-4555-8555-555555555555",
            state: "RUNNING",
            outcome: null,
            provenance: {},
            attempts: [
                {
                    id: attemptId,
                    attemptNo: 1,
                    runtimeId: null,
                    phase: "RUNNING",
                    outcome: null,
                    facts: {},
                    createdAt: "2026-11-13T00:00:00Z",
                    activatedAt: null,
                    finishedAt: null,
                    lastSequence: 0,
                    provenance: {},
                    gateAtExecution: gate,
                    gateNow: gate,
                    compensations: [],
                },
            ],
        },
    ],
};

/** 真实共享 CloudReportAdapter 先读取无 Attempt 的排队快照，再解析标准 SSE 新 Attempt 事件，原生按钮必须立即拥有正确 Run 上下文；测试仅替换网络传输和主机动作记录，不伪造业务执行或文件授权成功。 */
test("native artifact context includes streamed Attempts and rejects cross-scope reports", async () => {
    let next = streamed;
    installHostTransport({
        json: async () => queued,
        binary: async () => {
            throw new Error("UNEXPECTED_BINARY");
        },
        stream: async () =>
            new Response(`event: report\nid: 1\ndata: ${JSON.stringify({ report: next })}\n\n`, {
                headers: { "Content-Type": "text/event-stream" },
            }),
    });
    const actions: Parameters<DesktopBridge["artifact"]>[0][] = [];
    const adapter = nativeCloudReports(
        workspaceId,
        new CloudReportAdapter(workspaceId),
        async (input) => {
            actions.push(input);
        },
    );
    assert.equal((await adapter.report(runId)).cases.length, 0);
    assert(adapter.nativeArtifact);
    await assert.rejects(
        adapter.nativeArtifact(attemptId, attemptId, "trace"),
        /REPORT_CONTEXT_MISSING/,
    );
    const controller = new AbortController();
    await adapter.subscribe(
        runId,
        (report) => {
            assert.equal(report.cases[0]?.attempts[0]?.id, attemptId);
            controller.abort();
        },
        controller.signal,
    );
    await adapter.nativeArtifact(attemptId, attemptId, "trace");
    assert.deepEqual(actions, [
        { local: false, runId, attemptId, artifactId: attemptId, action: "trace" },
    ]);
    next = {
        ...streamed,
        run: { ...streamed.run, workspaceId: "66666666-6666-4666-8666-666666666666" },
    };
    const foreign = new AbortController();
    await assert.rejects(
        adapter.subscribe(runId, () => foreign.abort(), foreign.signal),
        /REPORT_CONTEXT_MISMATCH/,
    );
    assert.equal(actions.length, 1);
});
