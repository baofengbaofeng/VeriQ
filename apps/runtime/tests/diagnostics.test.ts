import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

function runDiagnostics(script: string) {
    return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        env: { ...process.env, LOG_LEVEL: "NOTICE" },
    });
}

test("platform calls share the operation trace, emit distinct child spans, and omit query values", () => {
    const script = `
        import assert from 'node:assert/strict';
        import { diagnosticFetch, withDiagnosticContext } from './src/diagnostics.ts';
        const headers = [];
        const fetcher = async (_url, options) => {
            headers.push(new Headers(options.headers));
            return new Response(null, { status: 204 });
        };
        const url = 'https://control.example/api/customer-opaque-id?private=VALUE';
        await withDiagnosticContext(async () => {
            await diagnosticFetch(fetcher, 'runtime.resource', url);
            await diagnosticFetch(fetcher, 'runtime.resource', url);
        });
        assert.match(headers[0].get('x-trace-id'), /^[a-f0-9]{32}$/);
        assert.equal(headers[0].get('x-trace-id'), headers[1].get('x-trace-id'));
        assert.match(headers[0].get('x-cspanid'), /^[a-f0-9]{16}$/);
        assert.notEqual(headers[0].get('x-cspanid'), headers[1].get('x-cspanid'));
        for (const entry of headers) process.stdout.write(entry.get('x-cspanid') + '\\n');
    `;
    const result = runDiagnostics(script);
    assert.equal(result.status, 0, result.stderr);
    const spans = result.stdout.trim().split("\n");
    const lines = result.stderr.trim().split("\n");
    assert.equal(lines.length, 2);
    for (const [index, line] of lines.entries()) {
        assert.match(line, /\[NOTICE\].* _com_http_success\|\|/);
        assert.ok(line.includes(`cspanid=${spans[index]}`));
        assert.ok(line.includes("uri=runtime.resource"));
        assert.doesNotMatch(line, /control.example|customer-opaque-id|private|VALUE/);
    }
});

test("failed and concurrent platform calls retain their own trace and exclude raw error content", () => {
    const script = `
        import assert from 'node:assert/strict';
        import { diagnosticFetch, withDiagnosticContext } from './src/diagnostics.ts';
        const received = [];
        const url = 'https://control.example/resource';
        const error = new Error('wire data is private');
        const record = async (_url, init) => {
            await new Promise((resolve) => setImmediate(resolve));
            received.push([init.headers.get('x-trace-id'), init.headers.get('x-cspanid')]);
            if (received.length === 2) throw error;
            return new Response(null, { status: 429 });
        };
        const [response, failure] = await Promise.allSettled([
            withDiagnosticContext(() => diagnosticFetch(record, 'runtime.resource', url)),
            withDiagnosticContext(() => diagnosticFetch(record, 'runtime.resource', url)),
        ]);
        assert.equal(response.value.status, 429);
        assert.equal(failure.reason, error);
        assert.notEqual(received[0][0], received[1][0]);
        process.stdout.write(JSON.stringify(received));
    `;
    const result = runDiagnostics(script);
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stderr.trim().split("\n");
    assert.equal(lines.length, 2);
    const contexts = JSON.parse(result.stdout) as [string, string][];
    for (const [index, [trace, span]] of contexts.entries()) {
        const line = lines[index] ?? "";
        assert.match(line, /\[ERROR\].* _com_http_failure\|\|/);
        assert.ok(line.includes(`traceid=${trace}`));
        assert.ok(line.includes(`cspanid=${span}`));
        assert.doesNotMatch(line, /wire data is private|control.example/);
    }
    assert.match(lines[0] ?? "", /\berrno=429\b/);
    assert.match(lines[1] ?? "", /\berrno=NETWORK_ERROR\b/);
});

test("console and known child diagnostics preserve stdout and hide third-party content", () => {
    const result = runDiagnostics(`
        import { once } from 'node:events';
        import { Readable } from 'node:stream';
        import { captureDiagnostics, installDiagnosticConsole, withDiagnosticContext } from './src/diagnostics.ts';
        installDiagnosticConsole('test.console');
        await withDiagnosticContext(async () => {
            console.error(new TypeError('raw error information'));
            const child = Readable.from([Buffer.from('raw child part'), Buffer.from('two\\nlast part')]);
            captureDiagnostics(child, 'test.child');
            await once(child, 'end');
        });
        process.stdout.write(JSON.stringify({ ok: true }));
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '{"ok":true}');
    const lines = result.stderr.trim().split("\n");
    assert.equal(lines.length, 3);
    assert.match(lines[0] ?? "", /source=test\.console\|\|method=error\|\|error_name=TypeError/);
    assert.match(lines[1] ?? "", /source=test\.child\|\|_msg=Third-party process diagnostic/);
    assert.match(lines[2] ?? "", /source=test\.child\|\|_msg=Third-party process diagnostic/);
    const traces = lines.map((line) => /\btraceid=([a-f0-9]{32})/.exec(line)?.[1]);
    assert.ok(traces[0]);
    assert.ok(traces.every((trace) => trace === traces[0]));
    assert.doesNotMatch(result.stderr, /raw|last part/);
});
