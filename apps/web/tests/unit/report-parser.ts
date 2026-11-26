import { test } from "node:test";
import assert from "node:assert/strict";
import { EventSourceParserStream } from "eventsource-parser/stream";
import { randomUUID } from "node:crypto";
import { reportAuthentication, type ReportEvent } from "../../src/features/reports/adapters";

/**
 * 只有终态事件中符合契约的固定认证事实可以进入报告摘要，历史缺省和带浏览器原文的异常资料保持隐藏。
 */
test("reports accept only bounded authentication facts on the terminal Attempt event", () => {
    const finish = {
        schemaVersion: "1.0",
        attemptId: randomUUID(),
        sequence: 1,
        timestamp: "2026-11-22T10:00:00Z",
        type: "ATTEMPT_FINISHED",
        valuesAvailable: false,
        payload: { outcome: "ERROR", cleanupStatus: "NOT_REQUIRED" },
    } satisfies ReportEvent;
    const authentication = { stage: "IDP", outcome: "FAILED", durationMs: 31, errorCode: "SSO_FLOW_INVALID" };
    assert.equal(reportAuthentication([finish]), undefined);
    assert.deepEqual(reportAuthentication([{ ...finish, payload: { authentication } }]), authentication);
    assert.equal(reportAuthentication([{ ...finish, type: "LOG", payload: { authentication } }]), undefined);
    assert.equal(
        reportAuthentication([{ ...finish, payload: { authentication: { ...authentication, durationMs: -1 } } }]),
        undefined,
    );
    const unexpected = { ...authentication, errorCode: "IdP sent a browser error" };
    assert.equal(reportAuthentication([{ ...finish, payload: { authentication: unexpected } }]), undefined);
});

test("the actual client parser retains a maximum Run cursor across transport chunks", async () => {
    const positions = Object.fromEntries(Array.from({ length: 2000 }, () => [randomUUID(), Number.MAX_SAFE_INTEGER]));
    const cursor = Buffer.from(
        JSON.stringify({
            scope: {
                workspaceId: randomUUID(),
                runId: randomUUID(),
                userId: randomUUID(),
            },
            positions,
        }),
    ).toString("base64");
    assert.ok(cursor.length < 230000);
    const wire = `id: ${cursor}\nevent: report\ndata: {"events":[],"report":{"state":"RUNNING"}}\n\n`;
    let offset = 0;
    const stream = new ReadableStream<string>({
        pull(controller) {
            if (offset >= wire.length) {
                controller.close();
                return;
            }
            controller.enqueue(wire.slice(offset, offset + 137));
            offset += 137;
        },
    });
    const reader = stream
        .pipeThrough(
            new EventSourceParserStream({
                maxBufferSize: 32 * 1024 * 1024,
                onError: "terminate",
            }),
        )
        .getReader();
    const { value } = await reader.read();
    assert.equal(value?.id, cursor);
    assert.equal(value?.event, "report");
    assert.equal(JSON.parse(value!.data).report.state, "RUNNING");
    assert.equal((await reader.read()).done, true);
});
