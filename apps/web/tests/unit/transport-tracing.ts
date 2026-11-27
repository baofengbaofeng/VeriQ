import assert from "node:assert/strict";
import { test } from "node:test";
import { binaryRequest, request, streamRequest } from "../../src/api.js";

test("overlapping JSON, binary and stream requests send distinct nonzero trace and span IDs", async (t) => {
    const pending = new Map<string, { headers: Headers; complete: (response: Response) => void }>();
    t.mock.method(globalThis, "fetch", (url: string, options: RequestInit) => {
        return new Promise<Response>((complete) =>
            pending.set(url, { headers: new Headers(options.headers), complete }),
        );
    });
    const json = request("/json", "GET", undefined, undefined, { "X-Trace-Id": "duplicate", "X-Range": "preserved" });
    const binary = binaryRequest("/binary");
    const stream = streamRequest("/stream", {}, new AbortController().signal);
    const requests = [...pending.values()];
    for (const [index, sent] of requests.entries()) {
        sent.complete(index === 0 ? Response.json({ data: "json" }) : new Response(index === 1 ? "binary" : "stream"));
    }

    assert.equal(await json, "json");
    assert.equal(await (await binary).text(), "binary");
    assert.equal(await (await stream).text(), "stream");
    assert.equal(requests[0]?.headers.get("x-range"), "preserved");
    const traces = requests.map(({ headers }) => headers.get("x-trace-id"));
    const spans = requests.map(({ headers }) => headers.get("x-cspanid"));
    for (const trace of traces) assert.match(trace ?? "", /^(?!0{32}$)[0-9a-f]{32}$/);
    for (const span of spans) assert.match(span ?? "", /^(?!0{16}$)[0-9a-f]{16}$/);
    assert.equal(new Set(traces).size, 3);
    assert.equal(new Set(spans).size, 3);
});

test("response trace headers stay with their request when completions arrive out of order", async (t) => {
    const { installBrowserDiagnostics } = await import("../../src/browser-logging.js");
    const written: string[] = [];
    const receiver = Object.assign(new EventTarget(), {
        console: { log: (line: string) => written.push(line) } as Console,
    });
    installBrowserDiagnostics("web", receiver);
    installBrowserDiagnostics("web", receiver);
    const pending = new Map<string, { headers: Headers; complete: (response: Response) => void }>();
    t.mock.method(globalThis, "fetch", (url: string, options: RequestInit) => {
        return new Promise<Response>((complete) =>
            pending.set(url, { headers: new Headers(options.headers), complete }),
        );
    });

    const json = request("/json?token=private-query");
    const binary = binaryRequest("/binary?token=private-query");
    const first = pending.get("/api/v1/json?token=private-query");
    const second = pending.get("/api/v1/binary?token=private-query");
    assert.ok(first);
    assert.ok(second);
    second.complete(
        new Response("private-body", {
            headers: {
                "x-trace-id": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                "x-cspanid": "0000000000000000",
            },
        }),
    );
    await binary;
    first.complete(
        Response.json(
            { data: "private-body" },
            {
                headers: {
                    "x-trace-id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "x-cspanid": "1111111111111111",
                },
            },
        ),
    );
    await json;
    receiver.console.debug("private-debug");
    receiver.console.warn("Retries exhausted password=private-password", { token: "private-object" });
    const error = Object.assign(new Event("error", { cancelable: true }), { message: "private-raw-error" });
    const rejection = Object.assign(new Event("unhandledrejection", { cancelable: true }), {
        reason: new Error("private-raw-reason"),
    });
    assert.equal(receiver.dispatchEvent(error), false);
    assert.equal(receiver.dispatchEvent(rejection), false);

    assert.equal(written.length, 5);
    assert.match(
        written[0],
        /^\[NOTICE\].*_com_http_success\|\|.*traceid=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\|\|.*operation=web\.api\.binary/,
    );
    assert.match(
        written[1],
        /^\[NOTICE\].*_com_http_success\|\|.*traceid=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\|\|.*operation=web\.api\.json/,
    );
    assert.ok(written[0].includes(`||cspanid=${second.headers.get("x-cspanid")}||`));
    assert.doesNotMatch(written[0], /\|\|response_spanid=/);
    assert.ok(written[1].includes(`||cspanid=${first.headers.get("x-cspanid")}||`));
    assert.ok(written[1].includes("||response_spanid=1111111111111111||"));
    assert.match(written[2], /^\[WARNING\].*\|\|_msg=Retries exhausted /);
    assert.match(written[3], /^\[ERROR\].*\|\|event=web\.uncaught_error\|\|/);
    assert.match(written[4], /^\[ERROR\].*\|\|event=web\.unhandled_rejection\|\|/);
    assert.doesNotMatch(written.slice(2).join("\n"), /\|\|traceid=/);
    assert.doesNotMatch(written.join("\n"), /private-/);
});
