/**
 * 已打开的报告流属于发起视图，渲染器在等待宿主创建句柄时取消也必须释放句柄，避免占满共享的四条订阅名额。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { openDesktopStream } from "../src/renderer/stream.ts";

test("closing the conversation while Electron opens a stream releases the late handle", async () => {
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    const runId = "00000000-0000-4000-8000-000000000002";
    const opening = Promise.withResolvers<string>();
    const closed: string[] = [];
    const transport = {
        streamOpen: () => opening.promise,
        streamClose: async (id: string) => {
            closed.push(id);
        },
        streamPull: async () => assert.fail("late stream was pulled"),
    };
    const lifetime = new AbortController();
    const stream = openDesktopStream(
        transport,
        { operation: "streamRunReport", params: { workspaceId, runId }, data: {} },
        lifetime.signal,
    );
    lifetime.abort();
    opening.resolve("late-handle");
    const result = await Promise.allSettled([stream]);
    assert.deepEqual(closed, ["late-handle"]);
    assert.equal(result[0]?.status, "rejected");
});
