import assert from "node:assert/strict";
import test from "node:test";
import { ownedTraceOrigin, allowedTraceRequest } from "../src/main/viewer-policy.ts";

/** 原生 Trace 页面是后台私有查看器的单一回环来源，不能复用平台会话或把监听日志中任意 URL 当成可导航能力；这些正反例覆盖主机、协议、凭证、默认端口和路径混淆。 */
test("native trace accepts only the owned loopback viewer endpoint", () => {
    assert.equal(
        ownedTraceOrigin(
            "http://127.0.0.1:43127/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/trace/index.html?trace=private.zip",
        ),
        "http://127.0.0.1:43127",
    );
    for (const value of [
        "http://127.0.0.1:43127",
        "http://127.0.0.1:43127/trace/index.html",
        "https://127.0.0.1:43127/trace/index.html",
        "http://evil.test:43127/trace/index.html",
        "http://127.0.0.1/trace/index.html",
        "http://user@127.0.0.1:43127/trace/index.html",
        "http://127.0.0.1:43127/other",
    ])
        assert.throws(() => ownedTraceOrigin(value), /TRACE_ORIGIN_DENIED/);
});

/** 子框架的官方空白快照例外不能变成主页面或任意外部网络通道，精确 origin 比较也排除相同主机的其它端口；这些断言直接覆盖 Trace Session 的实际请求判定函数。 */
test("trace snapshot exception does not permit main frames or external traffic", () => {
    const origin = "http://127.0.0.1:43127";
    assert.equal(allowedTraceRequest("data:text/html;base64,PGJvZHk+", "subFrame", origin), true);
    assert.equal(allowedTraceRequest("data:text/html;base64,PGJvZHk+", "mainFrame", origin), false);
    assert.equal(
        allowedTraceRequest("http://127.0.0.1:43128/trace/index.html", "mainFrame", origin),
        false,
    );
    assert.equal(allowedTraceRequest("https://example.com/", "xhr", origin), false);
    assert.equal(
        allowedTraceRequest(origin + "/private/trace/file?path=trace.zip", "xhr", origin),
        true,
    );
});
