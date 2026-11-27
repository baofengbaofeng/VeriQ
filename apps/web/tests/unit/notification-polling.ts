/**
 * 测试原生收件箱的轮询间隔、授权失效和父会话取消；浏览器订阅只在待处理邀请需要刷新时保留慢速更新。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { inboxRefreshInterval } from "../../src/features/notifications/model.ts";

test("native inbox polls only an active authorized session and recovers on transient errors", () => {
    const controller = new AbortController();
    const pending = [{ kind: "WORKSPACE_INVITED", invitationStatus: "PENDING" }] as const;
    assert.equal(inboxRefreshInterval("poll", controller.signal), 30_000);
    assert.equal(inboxRefreshInterval("poll", controller.signal, undefined, 503), 30_000);
    for (const denied of [401, 403, 404, 410]) {
        assert.equal(inboxRefreshInterval("poll", controller.signal, undefined, denied), false);
    }
    assert.equal(inboxRefreshInterval("stream", controller.signal), false);
    assert.equal(inboxRefreshInterval("stream", controller.signal, pending), 30_000);
    assert.equal(inboxRefreshInterval("poll", undefined), false);
    controller.abort();
    assert.equal(inboxRefreshInterval("poll", controller.signal), false);
});
