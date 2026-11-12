import { test } from "node:test";
import assert from "node:assert/strict";
import { EventSourceParserStream } from "eventsource-parser/stream";
import { randomUUID } from "node:crypto";
test("the actual client parser retains a maximum Run cursor across transport chunks", async () => {
    const positions = Object.fromEntries(
        Array.from({ length: 2000 }, () => [randomUUID(), Number.MAX_SAFE_INTEGER]),
    );
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
