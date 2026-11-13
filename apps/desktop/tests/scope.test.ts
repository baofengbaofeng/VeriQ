import assert from "node:assert/strict";
import test from "node:test";
import { authorizeSender } from "../src/main/scope.ts";

/** 可信来源是当前窗口的顶层框架加本地固定文档，单独比对应用协议或窗口编号不足以防止子框架代为调用；这些行为断言不依赖 Electron 二进制是否已安装。 */
test("the owned main frame can invoke its bundled local entry", () => {
    const frame = {};
    assert.doesNotThrow(() =>
        authorizeSender({ id: 1, frame, url: "veriq://app/index.html" }, { id: 1, frame }),
    );
});

test("foreign frame, window and navigation cannot acquire the bridge", () => {
    const frame = {};
    for (const actual of [
        { id: 2, frame, url: "veriq://app/index.html" },
        { id: 1, frame: {}, url: "veriq://app/index.html" },
        { id: 1, frame, url: "https://app/index.html" },
        { id: 1, frame, url: "veriq://other/index.html" },
        { id: 1, frame, url: "veriq://app/../secret" },
    ])
        assert.throws(() => authorizeSender(actual, { id: 1, frame }), /IPC_SENDER_DENIED/);
});
